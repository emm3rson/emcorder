import { app, BrowserWindow, dialog, ipcMain, protocol, session, powerSaveBlocker } from 'electron'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { TakeStore } from './take-store'
import { PreferencesStore } from './preferences'

protocol.registerSchemesAsPrivileged([
  { scheme: 'recording', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let studio: BrowserWindow | null = null
let store: TakeStore
let blocker: number | null = null
let closing = false
let closePending = false
let preferences: PreferencesStore
let busy = 0
const rendererFile = join(__dirname, '../renderer/index.html')
const devUrl = process.env.ELECTRON_RENDERER_URL

function trusted(url: string): boolean {
  try {
    const candidate = new URL(url)
    if (devUrl) return candidate.origin === new URL(devUrl).origin
    candidate.hash = ''
    return candidate.href === pathToFileURL(rendererFile).href
  } catch { return false }
}

function requireStudio(event: Electron.IpcMainInvokeEvent): void {
  if (!studio || event.sender !== studio.webContents || event.senderFrame !== studio.webContents.mainFrame || !trusted(event.senderFrame.url)) {
    throw new Error('This action is only available in the studio.')
  }
}

function lockWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault() })
}

async function loadWindow(window: BrowserWindow, hash: string): Promise<void> {
  lockWindow(window)
  if (devUrl) await window.loadURL(`${devUrl}#${hash}`)
  else await window.loadFile(rendererFile, { hash })
}

function releaseBlocker(): void {
  if (blocker !== null && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
  blocker = null
}

async function createStudio(): Promise<void> {
  studio = new BrowserWindow({
    title: 'EmCorder', width: 1320, height: 860, minWidth: 940, minHeight: 680,
    icon: devUrl
      ? join(app.getAppPath(), 'src/renderer/public/branding/app-icon.ico')
      : join(__dirname, '../renderer/branding/app-icon.ico'),
    autoHideMenuBar: true, backgroundColor: '#F7F7F5',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  studio.on('close', (event) => {
    if (closing) return
    if (busy > 0) { event.preventDefault(); return }
    if (store.recording) {
      event.preventDefault()
      if (closePending) return
      const choice = dialog.showMessageBoxSync(studio!, {
        type: 'question', title: 'Recording in progress', message: 'Stop and finish the recording before closing?',
        detail: 'The take will stay in the local temporary recordings folder.', buttons: ['Keep recording', 'Stop and close'], defaultId: 0, cancelId: 0
      })
      if (choice === 1) { closePending = true; studio!.webContents.send('take:request-stop') }
    } else if (store.path && !store.isSaved) {
      const choice = dialog.showMessageBoxSync(studio!, {
        type: 'question', title: 'Unsaved take', message: 'Close and keep this take in temporary storage?',
        detail: store.path, buttons: ['Go back', 'Keep file and close'], defaultId: 0, cancelId: 0
      })
      if (choice === 0) event.preventDefault()
    }
  })
  studio.on('closed', () => { studio = null; releaseBlocker() })
  studio.webContents.on('render-process-gone', () => {
    if (!store.recording) return
    busy++
    void store.finish().catch((error: unknown) => {
      console.error('The interrupted recording could not be finalized. Its temporary file has been retained.', error)
    }).finally(() => { busy--; releaseBlocker() })
  })
  await loadWindow(studio, 'studio')
}

const testUserData = process.env.EMCORDER_TEST_USER_DATA
if (!app.isPackaged && testUserData && isAbsolute(testUserData)) app.setPath('userData', testUserData)

app.whenReady().then(async () => {
  store = new TakeStore(join(app.getPath('userData'), 'takes'))
  preferences = new PreferencesStore(app.getPath('userData'), app.getPath('videos'))
  await preferences.load()
  // Workers do not inherit the document's CSP. Keep dependency telemetry and all
  // other remote requests off the network; only the local Vite server is allowed in dev.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const url = new URL(details.url)
    const localDev = devUrl && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === new URL(devUrl).port
    callback({ cancel: !localDev })
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permission === 'media' && contents === studio?.webContents && details.isMainFrame && trusted(details.requestingUrl || contents.getURL())
  )
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permission === 'media' && contents === studio?.webContents && details.isMainFrame && trusted(details.requestingUrl))
  })

  protocol.handle('recording', async (request) => {
    const path = store.path
    if (new URL(request.url).pathname !== '/current.mp4' || !path || store.recording) return new Response(null, { status: 404 })
    let file
    try { file = await open(path, 'r') } catch { return new Response(null, { status: 404 }) }
    let size: number
    try { size = (await file.stat()).size }
    catch { await file.close().catch(() => undefined); return new Response(null, { status: 404 }) }
    const range = request.headers.get('range')
    const match = range?.match(/^bytes=(\d+)-(\d*)$/)
    const start = match ? Number(match[1]) : 0
    const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    if (!size || start >= size || start > end || (range && !match)) {
      await file.close()
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    const headers: Record<string, string> = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store' }
    if (match) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    if (request.method === 'HEAD') {
      await file.close()
      return new Response(null, { status: match ? 206 : 200, headers })
    }
    const body = Readable.toWeb(file.createReadStream({ start, end, autoClose: true })) as ReadableStream<Uint8Array>
    return new Response(body, { status: match ? 206 : 200, headers })
  })

  ipcMain.handle('take:begin', async (event, mimeType: unknown) => {
    requireStudio(event)
    if (typeof mimeType !== 'string' || !/^video\/mp4;codecs="avc1\.[a-fA-F0-9]+,mp4a\.40\.2"$/.test(mimeType)) throw new Error('Only H.264/AAC MP4 recording is supported.')
    busy++
    try {
      await store.begin()
      blocker = powerSaveBlocker.start('prevent-display-sleep')
    } finally { busy-- }
  })
  ipcMain.handle('take:chunk', (event, data: unknown) => {
    requireStudio(event)
    if (!(data instanceof ArrayBuffer) || data.byteLength > 16 * 1024 * 1024) throw new Error('Invalid recording chunk.')
    return store.append(new Uint8Array(data))
  })
  ipcMain.handle('take:finish', async (event) => {
    requireStudio(event)
    busy++
    let succeeded = false
    try {
      const bytes = await store.finish()
      succeeded = true
      return { url: `recording://take/current.mp4?t=${Date.now()}`, bytes }
    } finally {
      releaseBlocker()
      busy--
      if (closePending) {
        closePending = false
        if (succeeded) { closing = true; studio?.close() }
      }
    }
  })
  ipcMain.handle('take:discard', async (event) => { requireStudio(event); busy++; try { await store.discard() } finally { busy-- } })
  ipcMain.handle('take:save', async (event, options: unknown) => {
    requireStudio(event)
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid save options.')
    const value = options as Record<string, unknown>
    if (Object.keys(value).some((key) => key !== 'filename' && key !== 'directory') || typeof value.filename !== 'string' || typeof value.directory !== 'string') throw new Error('Invalid save options.')
    busy++
    try {
      const path = await store.save({ filename: value.filename, directory: value.directory })
      try { await preferences.setOutputFolder(value.directory) }
      catch (error) { console.warn('Recording saved, but its output folder preference could not be updated.', error) }
      return path
    } finally { busy-- }
  })
  ipcMain.handle('preferences:get', (event) => { requireStudio(event); return preferences.get() })
  ipcMain.handle('preferences:update', async (event, patch: unknown) => {
    requireStudio(event)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid preference update.')
    busy++
    try { await preferences.update(patch as never) } finally { busy-- }
  })
  ipcMain.handle('preferences:choose-output-folder', async (event) => {
    requireStudio(event)
    busy++
    try {
      const result = await dialog.showOpenDialog(studio!, { title: 'Choose recording folder', defaultPath: preferences.get().outputFolder, properties: ['openDirectory', 'createDirectory'] })
      if (result.canceled || !result.filePaths[0]) return null
      await preferences.setOutputFolder(result.filePaths[0])
      return result.filePaths[0]
    } finally { busy-- }
  })
  await createStudio()
}).catch((error: unknown) => { dialog.showErrorBox('EmCorder could not start', String(error)); app.quit() })

app.on('window-all-closed', () => app.quit())
app.on('will-quit', releaseBlocker)

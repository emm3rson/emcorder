import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const userData = await mkdtemp(join(tmpdir(), 'emcorder-desktop-smoke-'))
const env = { ...process.env, EMCORDER_TEST_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
let app
let second

try {
  app = await electron.launch({ executablePath: electronPath, args: [resolve('.')], env, timeout: 30_000 })
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByText(`EmCorder ${version}`, { exact: true }).waitFor()
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
  const marker = 'Keep this script across repeated launches.'
  await page.evaluate((script) => window.emcorder.updatePreferences({ script }), marker)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())

  second = spawn(electronPath, [resolve('.')], { env, stdio: 'ignore', windowsHide: true })
  const exitCode = await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error('Second instance did not exit within 15 seconds')), 15_000)
    second.once('error', (error) => { clearTimeout(timeout); reject(error) })
    second.once('exit', (code) => { clearTimeout(timeout); resolveExit(code) })
  })
  assert.equal(exitCode, 0, 'The second instance should exit cleanly')
  await page.waitForFunction(() => document.visibilityState === 'visible')
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), false)
  assert.equal((await page.evaluate(() => window.emcorder.getPreferences())).script, marker)
  console.log(`Desktop smoke passed: version ${version}, isolated data, second-instance exit, restored window, retained script.`)
} finally {
  if (second && second.exitCode === null) second.kill()
  if (app) await app.close()
  await rm(userData, { recursive: true, force: true })
}

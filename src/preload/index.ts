import { contextBridge, ipcRenderer } from 'electron'
import type { EmcorderBridge } from '../shared/contracts'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await ipcRenderer.invoke(channel, ...args) as T
  } catch (error) {
    if (error instanceof Error) {
      error.message = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    }
    throw error
  }
}

const bridge: EmcorderBridge = {
  beginRecording: (mimeType) => invoke('take:begin', mimeType),
  appendChunk: (data) => invoke('take:chunk', data),
  finishRecording: () => invoke('take:finish'),
  discardRecording: () => invoke('take:discard'),
  saveRecording: (options) => invoke('take:save', options),
  getPreferences: () => invoke('preferences:get'),
  updatePreferences: (patch) => invoke('preferences:update', patch),
  chooseOutputFolder: () => invoke('preferences:choose-output-folder'),
  onRequestStop: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('take:request-stop', listener)
    return () => ipcRenderer.removeListener('take:request-stop', listener)
  }
}
contextBridge.exposeInMainWorld('emcorder', bridge)

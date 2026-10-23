import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectRecording } from '../src/renderer/features/recordings/mediaChecks'

test('aborting inspection releases the hidden video and clears its timeout immediately', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let paused = false
  let released = false
  let loads = 0
  let timeoutCleared = false
  let finishTimeout: (() => void) | undefined
  const video = Object.assign(new EventTarget(), {
    duration: 10,
    src: '',
    currentTime: 0,
    pause: () => { paused = true },
    removeAttribute: (name: string) => { if (name === 'src') released = true },
    load: () => { loads++ },
  })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => video } })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => { finishTimeout = callback; return 1 },
      clearTimeout: () => { timeoutCleared = true },
    },
  })
  try {
    const controller = new AbortController()
    const inspecting = inspectRecording('recording://take', controller.signal)
    assert.equal(video.src, 'recording://take')
    controller.abort()
    assert.equal(paused, true)
    assert.equal(released, true)
    assert.equal(timeoutCleared, true)
    assert.match((await inspecting).message, /cancelled/)
    video.dispatchEvent(new Event('loadedmetadata'))
    finishTimeout?.()
    assert.equal(video.currentTime, 0, 'metadata listener has been removed')
    assert.equal(loads, 1, 'cleanup is idempotent')

    video.src = ''
    await inspectRecording('recording://another', controller.signal)
    assert.equal(video.src, '', 'an already-aborted inspection never loads the recording')
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'
import type { WorkerRequest, WorkerResponse } from '../src/renderer/features/blur/segmentation.protocol'

test('segmentation worker smooths by elapsed time and respects borrowed callback ownership', async (t) => {
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const replace = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  const worker = new EventTarget()
  const responses: WorkerResponse[] = []
  let insideCallback = false
  let failTransfer = false
  let failRead = false
  let resultClosed = 0
  let inputClosed = 0
  let clock = 0
  let width = 1
  let height = 2
  let confidence = 0.5
  let alpha = 0
  const outputs: Array<{ closeCount: number; close(): void }> = []
  const timestamps: number[] = []
  Object.assign(worker, {
    postMessage(message: WorkerResponse) {
      if (message.type === 'mask') {
        assert.ok(insideCallback, 'output must be completed before callback masks expire')
        if (failTransfer) throw new Error('transfer failed')
      }
      responses.push(message)
    },
  })
  class FakeCanvas {
    constructor(public width: number, public height: number) {}
    getContext() {
      return { putImageData(image: ImageData) {
        assert.ok(insideCallback)
        clock += 7
        alpha = image.data[3]
      } }
    }
    transferToImageBitmap() {
      assert.ok(insideCallback)
      clock += 3
      const output = { closeCount: 0, close() { this.closeCount++ } }
      outputs.push(output)
      return output
    }
  }
  replace('self', worker)
  replace('OffscreenCanvas', FakeCanvas)
  replace('ImageData', class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  })
  replace('performance', { now: () => clock })
  t.mock.method(FilesetResolver, 'forVisionTasks', async () => ({}))
  t.mock.method(ImageSegmenter, 'createFromOptions', async () => ({
    close() {},
    segmentForVideo(_bitmap: ImageBitmap, timestamp: number, callback: (result: unknown) => void) {
      assert.equal(typeof callback, 'function', 'avoid the overload that copies masks')
      timestamps.push(timestamp)
      insideCallback = true
      try {
        callback({
          confidenceMasks: [{ width, height, getAsFloat32Array() {
            assert.ok(insideCallback)
            if (failRead) throw new Error('mask read failed')
            return new Float32Array(width * height).fill(confidence)
          } }],
          close() { resultClosed++ },
        })
      } finally {
        insideCallback = false
      }
    },
  }))
  const dispatch = (request: WorkerRequest) => worker.dispatchEvent(new MessageEvent('message', { data: request }))
  let frameId = 0
  const segment = (timestampMs: number, resetHistory = false) => dispatch({
    type: 'segment', timestampMs, resetHistory, frameId: ++frameId,
    bitmap: { close() { inputClosed++ } } as ImageBitmap,
  })
  try {
    const { smoothConfidenceBuffer } = await import('../src/renderer/features/blur/segmentation.worker')
    await t.test('equal elapsed time produces equal damping while confidence stays in the low-change range', () => {
      const target = new Float32Array([0.54])
      const slow = smoothConfidenceBuffer(target, new Float32Array([0.5]), 80)
      let fast: Float32Array = new Float32Array([0.5])
      for (let i = 0; i < 4; i++) fast = smoothConfidenceBuffer(target, fast, 20)
      assert.ok(Math.abs(slow[0] - fast[0]) < 1e-6)
      assert.ok(Math.abs(slow[0] - (0.5 + 0.04 * (1 - 0.72 ** 2))) < 1e-6)
    })
    await t.test('long gaps and explicit resets reuse storage without carrying old confidence', () => {
      for (const [elapsedMs, reset] of [[800, false], [40, true], [NaN, false]] as const) {
        const previous = new Float32Array([0.1])
        assert.equal(smoothConfidenceBuffer(new Float32Array([0.9]), previous, elapsedMs, reset), previous)
        assert.ok(Math.abs(previous[0] - 0.9) < 1e-6)
      }
      const current = new Float32Array([0.2, 0.8])
      assert.deepEqual(smoothConfidenceBuffer(current, new Float32Array([0.1])), current)
      assert.notEqual(smoothConfidenceBuffer(current, null), current)
      const bounded = smoothConfidenceBuffer(new Float32Array([0.9]), new Float32Array([0.1]), -20)
      assert.ok(bounded[0] > 0.1 && bounded[0] < 0.9)
    })
    dispatch({ type: 'init', wasmBaseUrl: 'local', modelUrl: 'local' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(responses.at(-1)?.type, 'ready')
    segment(100)
    assert.equal(inputClosed, 1)
    assert.equal(outputs[0].closeCount, 0, 'transferred output belongs to the renderer')
    assert.deepEqual(responses.at(-1), {
      type: 'mask', bitmap: outputs[0], segmentationMs: 10, timestampMs: 100, frameId: 1,
    })
    confidence = 0.54
    segment(120)
    assert.equal(alpha, Math.round((0.5 + 0.04 * (1 - Math.sqrt(0.72))) * 255))
    confidence = 0.1
    segment(140, true)
    assert.equal(alpha, 26, 'explicit history reset takes the new confidence immediately')
    confidence = 0.9
    segment(1000)
    assert.equal(alpha, 229, 'long capture gaps discard the old silhouette')
    width = 2
    height = 1
    confidence = 0.5
    segment(1040)
    assert.equal(alpha, 128, 'changed geometry resets history even with the same pixel count')
    segment(1040)
    assert.ok(timestamps.at(-1)! > timestamps.at(-2)!, 'MediaPipe timestamps strictly increase')
    assert.equal((responses.at(-1) as Extract<WorkerResponse, { type: 'mask' }>).timestampMs, 1040)
    failTransfer = true
    segment(1080)
    assert.equal(outputs.at(-1)?.closeCount, 1, 'failed postMessage leaves the output owned by the worker')
    assert.equal(responses.at(-1)?.type, 'error')
    failTransfer = false
    failRead = true
    segment(1120)
    assert.equal(responses.at(-1)?.type, 'error')
    assert.equal(inputClosed, frameId, 'every input closes on both success and failures')
    assert.equal(resultClosed, 0, 'borrowed MediaPipe results must never be closed by the worker')
  } finally {
    worker.dispatchEvent(new Event('close'))
    t.mock.restoreAll()
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createPipeline } from '../src/renderer/features/blur/pipeline'
import type { WorkerRequest } from '../src/renderer/features/blur/segmentation.protocol'
import { computePersonConfidence, smoothConfidenceBuffer } from '../src/renderer/features/blur/segmentation.worker'

const originalGlobals = new Map<string, PropertyDescriptor | undefined>()

function replaceGlobal(name: string, value: unknown): void {
  if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

afterEach(() => {
  originalGlobals.forEach((descriptor, name) => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  })
  originalGlobals.clear()
})

function installFakes(failure?: 'construct' | 'initialize') {
  let now = 0
  let draws = 0
  let timerId = 0
  const intervals = new Map<number, { callback: () => void; delay: number }>()
  const timeouts = new Map<number, { callback: () => void; delay: number; at: number }>()
  const statuses: string[] = []
  const drawCalls: Array<unknown[]> = []
  const drawFilters: string[] = []
  const drawStates: Array<{ target: unknown; source: unknown; transform: number[] }> = []
  const createdCanvases: Array<{ width: number; height: number }> = []
  const canvas = () => {
    let transform = [1, 0, 0, 1, 0, 0]
    const context = {
      setTransform: (...values: number[]) => { transform = values },
      drawImage: (...args: unknown[]) => {
        draws++
        drawCalls.push(args)
        drawFilters.push(context.filter)
        drawStates.push({ target: surface, source: args[0], transform: [...transform] })
      },
      clearRect: () => {},
      filter: 'none',
      globalCompositeOperation: 'source-over',
    }
    const surface = { width: 0, height: 0, getContext: () => context }
    return surface
  }
  let worker: FakeWorker | undefined
  class FakeWorker extends EventTarget {
    terminated = false
    messages = 0
    requests: WorkerRequest[] = []
    constructor() {
      super()
      if (failure === 'construct') throw new Error('worker blocked')
      worker = this
    }
    postMessage(request: WorkerRequest): void {
      if (failure === 'initialize') throw new Error('worker initialization failed')
      this.messages++
      this.requests.push(request)
    }
    terminate(): void { this.terminated = true }
    ready(): void { this.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' } })) }
  }
  replaceGlobal('document', { createElement: () => { const result = canvas(); createdCanvases.push(result); return result }, baseURI: 'file:///app/index.html' })
  replaceGlobal('performance', { now: () => now })
  replaceGlobal('createImageBitmap', () => Promise.resolve({ close: () => {} } as ImageBitmap))
  replaceGlobal('window', {
    setInterval: (callback: () => void, delay: number) => {
      const id = ++timerId
      intervals.set(id, { callback, delay })
      return id
    },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId
      timeouts.set(id, { callback, delay, at: now + delay })
      return id
    },
    clearTimeout: (id: number) => timeouts.delete(id),
  })
  replaceGlobal('Worker', FakeWorker)
  replaceGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 })
  const video = { readyState: 2, videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement
  return {
    video,
    advance(ms: number) { now += ms },
    runNext() {
      const next = [...timeouts.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      assert.ok(next, 'expected a scheduled timeout')
      timeouts.delete(next[0])
      now = Math.max(now, next[1].at)
      next[1].callback()
    },
    async sample() {
      this.runNext()
      await Promise.resolve()
      return worker!.requests.filter((request) => request.type === 'segment').at(-1)! as Extract<WorkerRequest, { type: 'segment' }>
    },
    mask(request: Extract<WorkerRequest, { type: 'segment' }>, close = () => {}) {
      worker!.dispatchEvent(new MessageEvent('message', { data: {
        type: 'mask', bitmap: { close }, segmentationMs: 10,
        timestampMs: request.timestampMs, frameId: request.frameId,
      } }))
    },
    canvas: canvas() as unknown as HTMLCanvasElement,
    statuses,
    createdCanvases,
    drawCalls,
    drawFilters,
    drawStates,
    intervals,
    timeouts,
    get worker() { return worker! },
    get draws() { return draws },
  }
}

function installWebGLFake() {
  let contextLost = false
  let renderPasses = 0
  const gl = new Proxy({
    createShader: () => ({}),
    createProgram: () => ({}),
    createVertexArray: () => ({}),
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    checkFramebufferStatus: () => 'FRAMEBUFFER_COMPLETE',
    isContextLost: () => contextLost,
    drawArrays: () => { renderPasses++ },
  }, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key)
      // The fake only checks pipeline routing, not shader output.
      if (typeof key === 'string' && key.toUpperCase() === key) return key
      return () => {}
    },
  })
  class FakeOffscreenCanvas {
    constructor(public width: number, public height: number) {}
    getContext() { return gl }
  }
  replaceGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  return {
    surfaceType: FakeOffscreenCanvas,
    loseContext: () => { contextLost = true },
    get renderPasses() { return renderPasses },
  }
}

for (const renderer of ['canvas2d', 'webgl'] as const) {
  for (const quality of ['720p', '1080p'] as const) {
    test(`${quality} ${renderer} mirrors only the shared output and updates orientation without restarting`, async () => {
      const fakes = installFakes()
      const webgl = renderer === 'webgl' ? installWebGLFake() : null
      const pipeline = await createPipeline(fakes.video, fakes.canvas, {}, quality)
      fakes.worker.ready()
      fakes.mask(await fakes.sample())
      const frame = Array.from(fakes.intervals.values()).find(({ delay }) => delay === 1000 / 30)!.callback
      const checkOrientation = (mirrored: boolean, expectedOutputLayers: number) => {
        fakes.drawStates.length = 0
        frame()
        const outputDraws = fakes.drawStates.filter(({ target }) => target === fakes.canvas)
        assert.equal(outputDraws.length, expectedOutputLayers)
        for (const { transform } of outputDraws) {
          assert.deepEqual(transform, mirrored ? [-1, 0, 0, 1, fakes.canvas.width, 0] : [1, 0, 0, 1, 0, 0])
        }
        for (const { transform } of fakes.drawStates.filter(({ target }) => target !== fakes.canvas)) {
          assert.deepEqual(transform, [1, 0, 0, 1, 0, 0], 'source and mask coordinates must stay aligned')
        }
        return outputDraws
      }
      const layers = webgl ? 1 : 2
      const initialDraws = checkOrientation(true, layers)
      if (webgl) {
        assert.ok(initialDraws[0].source instanceof webgl.surfaceType, 'the WebGL result must reach the shared output')
        assert.equal(webgl.renderPasses, 3)
      }
      pipeline.setMirrorVideo(false)
      checkOrientation(false, layers)
      pipeline.setMirrorVideo(true)
      checkOrientation(true, layers)
      if (webgl) {
        webgl.loseContext()
        pipeline.setMirrorVideo(false)
        checkOrientation(false, 2)
        pipeline.setMirrorVideo(true)
        checkOrientation(true, 2)
      }
      pipeline.setBlur(false)
      pipeline.setMirrorVideo(false)
      checkOrientation(false, 1)
      pipeline.setMirrorVideo(true)
      checkOrientation(true, 1)
      pipeline.setBlur(true)
      fakes.worker.dispatchEvent(new Event('messageerror'))
      checkOrientation(true, 1)
      pipeline.setMirrorVideo(false)
      checkOrientation(false, 1)
      assert.equal(fakes.createdCanvases.length, 4, 'orientation changes should reuse all processing canvases')
      assert.equal(fakes.intervals.size, 1, 'the original render loop should survive segmentation failure')
      pipeline.dispose()
    })
  }
}

test('an initially unmirrored pipeline draws its first frame without a flip', async () => {
  const fakes = installFakes('construct')
  const pipeline = await createPipeline(fakes.video, fakes.canvas, { mirrorVideo: false })
  fakes.intervals.values().next().value!.callback()
  const outputDraw = fakes.drawStates.find(({ target }) => target === fakes.canvas)
  assert.deepEqual(outputDraw?.transform, [1, 0, 0, 1, 0, 0])
  pipeline.dispose()
})

for (const failure of ['construct', 'initialize'] as const) {
  test(`keeps drawing unblurred camera frames when the worker cannot ${failure}`, async () => {
    const fakes = installFakes(failure)
    const pipeline = await createPipeline(fakes.video, fakes.canvas, { onStatus: (message) => fakes.statuses.push(message) })

    assert.match(fakes.statuses.at(-1)!, /Showing the camera without blur/)
    assert.equal(fakes.intervals.size, 1)
    fakes.intervals.values().next().value!.callback()
    assert.equal(fakes.draws, 2)
    pipeline.dispose()
    assert.equal(fakes.intervals.size, 0)
    assert.equal(fakes.timeouts.size, 0)
    if (failure === 'initialize') assert.equal(fakes.worker.terminated, true)
  })
}

test('closes a pending frame bitmap after the segmentation worker fails', async () => {
  const fakes = installFakes()
  let completeBitmap!: (bitmap: ImageBitmap) => void
  replaceGlobal('createImageBitmap', () => new Promise<ImageBitmap>((resolve) => { completeBitmap = resolve }))
  const pipeline = await createPipeline(fakes.video, fakes.canvas)
  fakes.worker.ready()
  fakes.runNext()
  fakes.worker.dispatchEvent(new Event('messageerror'))
  let closed = false
  completeBitmap({ close: () => { closed = true } } as ImageBitmap)
  await Promise.resolve()

  assert.equal(closed, true)
  assert.equal(fakes.worker.messages, 1, 'only initialization reaches the failed worker')
  assert.equal(fakes.worker.terminated, true)
  pipeline.dispose()
  assert.equal(fakes.intervals.size, 0)
  assert.equal(fakes.timeouts.size, 0)
})

test('keeps blur status off through worker updates and invalidates old masks', async () => {
  const fakes = installFakes()
  const pipeline = await createPipeline(fakes.video, fakes.canvas, { onStatus: (message) => fakes.statuses.push(message) })
  fakes.worker.ready()
  const pending = await fakes.sample()
  pipeline.setBlur(false)
  const offStatusCount = fakes.statuses.length
  fakes.advance(150)
  fakes.mask(pending)
  assert.equal(fakes.statuses.at(-1), 'Camera blur is off.')
  assert.equal(fakes.statuses.length, offStatusCount)
  pipeline.setBlur(true)
  assert.match(fakes.statuses.at(-1)!, /preparing/)
  const next = await fakes.sample()
  assert.equal(next.resetHistory, true)
  fakes.mask(next)
  assert.match(fakes.statuses.at(-1)!, /ready/)
  pipeline.setBlur(false)
  fakes.worker.dispatchEvent(new Event('messageerror'))
  assert.equal(fakes.statuses.at(-1), 'Camera blur is off.')
  pipeline.setBlur(true)
  assert.match(fakes.statuses.at(-1)!, /unreadable message.*without blur/)
  pipeline.dispose()
})

for (const [quality, width, height] of [['720p', 1280, 720], ['1080p', 1920, 1080]] as const) {
  test(quality + ' sizes compositing canvases while keeping segmentation small', async () => {
    const fakes = installFakes();
    const pipeline = await createPipeline(fakes.video, fakes.canvas, {}, quality);
    assert.deepEqual([fakes.canvas.width, fakes.canvas.height], [width, height]);
    assert.deepEqual(fakes.createdCanvases.map(({ width, height }) => [width, height]), [
      [width, height], [width, height], [256, 256], [256, 256],
    ]);
    assert.ok(Array.from(fakes.intervals.values()).some(({ delay }) => delay === 1000 / 30));
    pipeline.dispose();
  });
}

for (const [quality, baseRadius, maskFeather] of [['720p', 18, 1.5], ['1080p', 27, 2.25]] as const) {
  test(quality + ' applies blur presets without changing mask feathering or restarting the pipeline', async () => {
    const fakes = installFakes()
    const pipeline = await createPipeline(fakes.video, fakes.canvas, {}, quality)
    fakes.worker.ready()
    fakes.mask(await fakes.sample())
    const frame = Array.from(fakes.intervals.values()).find(({ delay }) => delay === 1000 / 30)!.callback
    const checkRadius = (radius: number) => {
      fakes.drawFilters.length = 0
      frame()
      assert.ok(fakes.drawFilters.includes(`blur(${radius}px)`), 'background should use the selected radius')
      assert.ok(fakes.drawFilters.includes(`blur(${maskFeather}px)`), 'mask feathering should stay unchanged')
    }
    checkRadius(baseRadius)
    for (const [strength, scale] of [['light', 0.5], ['strong', 1.5], ['standard', 1]] as const) {
      pipeline.setBlurStrength(strength)
      checkRadius(baseRadius * scale)
    }
    pipeline.setBlur(false)
    pipeline.setBlurStrength('strong')
    fakes.drawFilters.length = 0
    frame()
    assert.ok(fakes.drawFilters.every((filter) => filter === 'none'), 'off should bypass blur regardless of strength')
    pipeline.setBlur(true)
    fakes.mask(await fakes.sample())
    checkRadius(baseRadius * 1.5)
    assert.equal(fakes.createdCanvases.length, 4, 'changing strength should reuse the processing canvases')
    assert.equal(fakes.intervals.size, 1, 'only output rendering should use a repeating timer')
    pipeline.dispose()
  })
}

test('computePersonConfidence preserves hair and glasses while suppressing ambiguous background chair edges', () => {
  // 6 classes: 0: bg, 1: hair, 2: body-skin, 3: face-skin, 4: clothes, 5: accessories
  const hairEdge = [
    new Float32Array([0.35]),
    new Float32Array([0.55]),
    new Float32Array([0.0]),
    new Float32Array([0.05]),
    new Float32Array([0.0]),
    new Float32Array([0.05]),
  ]
  const chairBack = [
    new Float32Array([0.48]),
    new Float32Array([0.0]),
    new Float32Array([0.0]),
    new Float32Array([0.0]),
    new Float32Array([0.50]),
    new Float32Array([0.02]),
  ]
  const hairConfidence = computePersonConfidence(hairEdge, 0)
  const chairConfidence = computePersonConfidence(chairBack, 0)

  assert.ok(hairConfidence >= 0.64, `expected strong hair/glasses confidence, got ${hairConfidence}`)
  assert.ok(chairConfidence <= 0.36, `expected ambiguous chair-back confidence to be suppressed, got ${chairConfidence}`)
  assert.equal(computePersonConfidence([new Float32Array([0.75])], 0), 0.75)
})

test('smoothConfidenceBuffer dampens stationary edge jitter while tracking fast movement', () => {
  const previous = new Float32Array([0.50, 0.10])
  const current = new Float32Array([0.54, 0.90])
  const smoothed = smoothConfidenceBuffer(current, previous)

  // Stationary jitter (diff = 0.04 <= 0.06) uses 0.28 blend -> 0.50 + 0.04 * 0.28 = 0.5112
  assert.ok(Math.abs(smoothed[0] - 0.5112) < 1e-5)
  // Fast movement (diff = 0.80 >= 0.26) uses 0.90 blend -> 0.10 + 0.80 * 0.90 = 0.82
  assert.ok(Math.abs(smoothed[1] - 0.82) < 1e-5)
})

test('segmentFrame maps the full 16:9 camera frame into the 256x256 segmentation canvas without center-square cropping', async () => {
  const fakes = installFakes()
  const video = { readyState: 2, videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement
  replaceGlobal('createImageBitmap', () => Promise.resolve({ close: () => {} } as ImageBitmap))
  const pipeline = await createPipeline(video, fakes.canvas, {}, '1080p')
  fakes.worker.ready()
  fakes.drawCalls.length = 0
  fakes.runNext()

  assert.equal(fakes.drawCalls.length, 1)
  assert.deepEqual(fakes.drawCalls[0].slice(1), [0, 0, 1920, 1080, 0, 0, 256, 256])
  pipeline.dispose()
})


test('samples single flight and schedules from the full round trip without interval quantization', async () => {
  const fakes = installFakes()
  let resolveBitmap!: (bitmap: ImageBitmap) => void
  replaceGlobal('createImageBitmap', () => new Promise<ImageBitmap>((resolve) => { resolveBitmap = resolve }))
  const pipeline = await createPipeline(fakes.video, fakes.canvas)
  fakes.worker.ready()
  fakes.runNext()
  fakes.advance(25)
  resolveBitmap({ close() {} } as ImageBitmap)
  await Promise.resolve()
  const request = fakes.worker.requests.at(-1)! as Extract<WorkerRequest, { type: 'segment' }>
  assert.equal(request.timestampMs, 0, 'sampling must precede bitmap preparation')
  assert.equal(fakes.timeouts.size, 1, 'only the watchdog exists during an in-flight request')
  assert.equal(fakes.intervals.size, 1)
  fakes.advance(30)
  fakes.mask(request)
  const next = [...fakes.timeouts.values()][0]
  assert.ok(Math.abs(next.delay - 5.5) < 0.001, '55 ms full round trip targets 60.5 ms start-to-start')
  pipeline.dispose()
})

test('rejects late masks using sampling age and recovers only when a fresh result arrives', async () => {
  const fakes = installFakes()
  const pipeline = await createPipeline(fakes.video, fakes.canvas, { onStatus: (status) => fakes.statuses.push(status) })
  fakes.worker.ready()
  const request = await fakes.sample()
  fakes.advance(801)
  let closed = false
  fakes.mask(request, () => { closed = true })
  assert.equal(closed, true)
  assert.match(fakes.statuses.at(-1)!, /without blur until a fresh mask/)
  fakes.drawFilters.length = 0
  fakes.intervals.values().next().value!.callback()
  assert.ok(fakes.drawFilters.every((filter) => filter === 'none'))
  fakes.mask(await fakes.sample())
  assert.match(fakes.statuses.at(-1)!, /ready/)
  fakes.advance(801)
  fakes.intervals.values().next().value!.callback()
  assert.match(fakes.statuses.at(-1)!, /without blur until a fresh mask/)
  pipeline.dispose()
})

test('disable and re-enable during inference discards the old epoch and resets the next history', async () => {
  const fakes = installFakes()
  const pipeline = await createPipeline(fakes.video, fakes.canvas)
  fakes.worker.ready()
  const old = await fakes.sample()
  pipeline.setBlur(false)
  pipeline.setBlur(true)
  assert.equal(fakes.timeouts.size, 1, 'a toggle must not overlap the pending request')
  fakes.mask(old)
  fakes.drawFilters.length = 0
  fakes.intervals.values().next().value!.callback()
  assert.ok(fakes.drawFilters.every((filter) => filter === 'none'))
  const next = await fakes.sample()
  assert.ok(next.frameId > old.frameId)
  assert.equal(next.resetHistory, true)
  fakes.mask(old)
  assert.equal(fakes.timeouts.size, 1, 'duplicate old response must not clear the active watchdog')
  fakes.mask(next)
  pipeline.dispose()
})

for (const end of ['dispose', 'timeout'] as const) {
  test('closes a pending bitmap after ' + end + ' and clears timers', async () => {
    const fakes = installFakes()
    let resolveBitmap!: (bitmap: ImageBitmap) => void
    replaceGlobal('createImageBitmap', () => new Promise<ImageBitmap>((resolve) => { resolveBitmap = resolve }))
    const pipeline = await createPipeline(fakes.video, fakes.canvas)
    fakes.worker.ready()
    fakes.runNext()
    if (end === 'dispose') pipeline.dispose()
    else fakes.runNext()
    let closed = false
    resolveBitmap({ close() { closed = true } } as ImageBitmap)
    await Promise.resolve()
    assert.equal(closed, true)
    assert.equal(fakes.worker.messages, 1)
    assert.equal(fakes.worker.terminated, true)
    assert.equal(fakes.timeouts.size, 0)
    pipeline.dispose()
    assert.equal(fakes.intervals.size, 0)
  })
}

test('does not repeatedly sample an unchanged camera timestamp but retries within a bound', async () => {
  const fakes = installFakes()
  Object.assign(fakes.video, { currentTime: 1 })
  const pipeline = await createPipeline(fakes.video, fakes.canvas)
  fakes.worker.ready()
  fakes.mask(await fakes.sample())
  fakes.runNext()
  assert.equal(fakes.worker.messages, 2)
  fakes.advance(200)
  const next = await fakes.sample()
  assert.equal(next.frameId, 2)
  pipeline.dispose()
})


test('a toggle during bitmap preparation closes the old sample before a reset submission', async () => {
  const fakes = installFakes()
  let resolveBitmap!: (bitmap: ImageBitmap) => void
  replaceGlobal('createImageBitmap', () => new Promise<ImageBitmap>((resolve) => { resolveBitmap = resolve }))
  const pipeline = await createPipeline(fakes.video, fakes.canvas)
  fakes.worker.ready()
  fakes.runNext()
  pipeline.setBlur(false)
  pipeline.setBlur(true)
  let closed = false
  resolveBitmap({ close() { closed = true } } as ImageBitmap)
  await Promise.resolve()
  assert.equal(closed, true)
  assert.equal(fakes.worker.messages, 1, 'the invalidated bitmap must never reach the worker')
  replaceGlobal('createImageBitmap', () => Promise.resolve({ close() {} } as ImageBitmap))
  const next = await fakes.sample()
  assert.equal(next.resetHistory, true)
  assert.equal(next.frameId, 2)
  pipeline.dispose()
})


test('allows bounded cold inference warm-up, rejects its old mask, then uses the normal watchdog', async () => {
  const fakes = installFakes()
  const pipeline = await createPipeline(fakes.video, fakes.canvas, { onStatus: (status) => fakes.statuses.push(status) })
  fakes.worker.ready()
  const cold = await fakes.sample()
  assert.equal([...fakes.timeouts.values()][0].delay, 20_000)
  fakes.advance(4_000)
  fakes.mask(cold)
  assert.match(fakes.statuses.at(-1)!, /without blur until a fresh mask/)
  fakes.drawFilters.length = 0
  fakes.intervals.values().next().value!.callback()
  assert.ok(fakes.drawFilters.every((filter) => filter === 'none'))
  const next = await fakes.sample()
  assert.equal([...fakes.timeouts.values()][0].delay, 1_500)
  fakes.advance(100)
  fakes.mask(next)
  assert.match(fakes.statuses.at(-1)!, /ready/)
  pipeline.dispose()
})

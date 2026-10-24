import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createWebGLBlurCompositor, SEGMENTATION_MASK_SIZE } from '../src/renderer/features/blur/webglCompositor'

const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas')

afterEach(() => {
  if (originalOffscreenCanvas) Object.defineProperty(globalThis, 'OffscreenCanvas', originalOffscreenCanvas)
  else Reflect.deleteProperty(globalThis, 'OffscreenCanvas')
})

function installGL(options: { failedAllocation?: number; incompleteFramebuffer?: boolean } = {}) {
  type Texture = { id: number }
  let boundTexture: Texture | null = null
  let lost = false
  let failUpload = false
  let failedUploadTexture: number | undefined
  const textures: Texture[] = []
  const deletedTextures: Texture[] = []
  const allocations: Array<{ texture: Texture | null; args: number[] }> = []
  const uploads: Array<{ texture: Texture | null; args: unknown[] }> = []
  const mipmaps: Array<Texture | null> = []
  const draws: unknown[][] = []
  const constants = {
    TEXTURE_2D: 1, TEXTURE_MIN_FILTER: 2, TEXTURE_MAG_FILTER: 3, LINEAR: 4,
    TEXTURE_WRAP_S: 5, TEXTURE_WRAP_T: 6, CLAMP_TO_EDGE: 7, RGBA8: 8,
    FRAMEBUFFER: 9, COLOR_ATTACHMENT0: 10, FRAMEBUFFER_COMPLETE: 11,
    VERTEX_SHADER: 12, FRAGMENT_SHADER: 13, COMPILE_STATUS: 14, LINK_STATUS: 15,
    UNPACK_FLIP_Y_WEBGL: 16, DEPTH_TEST: 17, BLEND: 18, LINEAR_MIPMAP_LINEAR: 19,
    TEXTURE0: 20, TEXTURE1: 21, TEXTURE2: 22, RGBA: 23, UNSIGNED_BYTE: 24, TRIANGLES: 25,
  }
  const noop = () => {}
  const gl = {
    ...constants,
    createShader: () => ({}), shaderSource: noop, compileShader: noop,
    getShaderParameter: () => true, deleteShader: noop,
    createProgram: () => ({}), attachShader: noop, linkProgram: noop,
    getProgramParameter: () => true, deleteProgram: noop,
    createVertexArray: () => ({}), deleteVertexArray: noop,
    createTexture: () => { const texture = { id: textures.length }; textures.push(texture); return texture },
    bindTexture: (_target: number, texture: Texture | null) => { boundTexture = texture },
    texParameteri: noop,
    texStorage2D: (...args: number[]) => {
      allocations.push({ texture: boundTexture, args })
      if (allocations.length === options.failedAllocation) throw new Error('allocation failed')
    },
    texSubImage2D: (...args: unknown[]) => {
      if (failUpload && (failedUploadTexture === undefined || boundTexture?.id === failedUploadTexture)) throw new Error('upload failed')
      uploads.push({ texture: boundTexture, args })
    },
    deleteTexture: (texture: Texture) => { deletedTextures.push(texture) },
    generateMipmap: () => { mipmaps.push(boundTexture) },
    createFramebuffer: () => ({}), bindFramebuffer: noop, framebufferTexture2D: noop,
    checkFramebufferStatus: () => options.incompleteFramebuffer ? 0 : constants.FRAMEBUFFER_COMPLETE,
    deleteFramebuffer: noop, pixelStorei: noop, disable: noop, useProgram: noop,
    uniform1i: noop, uniform1f: noop, uniform2f: noop,
    getUniformLocation: () => ({}), bindVertexArray: noop, activeTexture: noop,
    viewport: noop, drawArrays: (...args: unknown[]) => { draws.push(args) },
    isContextLost: () => lost,
  }
  let surface: FakeCanvas
  class FakeCanvas extends EventTarget {
    constructor(public width: number, public height: number) { super(); surface = this }
    getContext() { return gl }
  }
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, writable: true, value: FakeCanvas })
  return {
    gl, textures, deletedTextures, allocations, uploads, mipmaps, draws,
    contextLost() { lost = true },
    dispatchContextLost() { surface.dispatchEvent(new Event('webglcontextlost', { cancelable: true })) },
    failUploads(value: boolean, textureId?: number) { failUpload = value; failedUploadTexture = textureId },
  }
}

const sourceCanvas = () => ({ width: 1280, height: 720 }) as HTMLCanvasElement
const maskCanvas = () => ({ width: SEGMENTATION_MASK_SIZE, height: SEGMENTATION_MASK_SIZE }) as HTMLCanvasElement

test('allocates fixed RGBA8 storage once and refreshes source pixels and mipmaps every render', () => {
  const fake = installGL()
  const compositor = createWebGLBlurCompositor(1280, 720)
  assert.ok(compositor)
  assert.deepEqual(fake.allocations.map(({ args }) => args), [
    [fake.gl.TEXTURE_2D, 11, fake.gl.RGBA8, 1280, 720],
    [fake.gl.TEXTURE_2D, 1, fake.gl.RGBA8, 256, 256],
    [fake.gl.TEXTURE_2D, 1, fake.gl.RGBA8, 320, 180],
    [fake.gl.TEXTURE_2D, 1, fake.gl.RGBA8, 320, 180],
  ])
  const source = sourceCanvas()
  const mask = maskCanvas()
  for (const strength of ['light', 'standard', 'strong'] as const) {
    assert.equal(compositor.render(source, mask, strength, 1), true)
  }
  assert.equal(fake.allocations.length, 4)
  const sourceUploads = fake.uploads.filter(({ texture }) => texture === fake.textures[0])
  assert.equal(sourceUploads.length, 3)
  assert.deepEqual(sourceUploads[0].args, [fake.gl.TEXTURE_2D, 0, 0, 0, fake.gl.RGBA, fake.gl.UNSIGNED_BYTE, source])
  assert.equal(fake.uploads.filter(({ texture }) => texture === fake.textures[1]).length, 1)
  assert.deepEqual(fake.mipmaps, Array(3).fill(fake.textures[0]))
  assert.equal(fake.draws.length, 9)
  compositor.dispose()
  compositor.dispose()
  assert.deepEqual(new Set(fake.deletedTextures), new Set(fake.textures))
  assert.equal(fake.deletedTextures.length, 4)
})

test('uploads a reused mask canvas on a new revision and a new object on the same revision', () => {
  const fake = installGL()
  const compositor = createWebGLBlurCompositor(1280, 720)
  assert.ok(compositor)
  const source = sourceCanvas()
  const mask = maskCanvas()
  assert.equal(compositor.render(source, mask, 'standard', 10), true)
  assert.equal(compositor.render(source, mask, 'standard', 11), true)
  const replacement = maskCanvas()
  assert.equal(compositor.render(source, replacement, 'standard', 11), true)
  assert.equal(compositor.render(source, replacement, 'strong', 11), true)
  assert.deepEqual(fake.uploads.filter(({ texture }) => texture === fake.textures[1]).map(({ args }) => args[6]), [mask, mask, replacement])
  compositor.dispose()
})

test('lost contexts and disposed compositors decline rendering without further uploads', () => {
  for (const reason of ['event', 'poll', 'dispose'] as const) {
    const fake = installGL()
    const compositor = createWebGLBlurCompositor(1280, 720)
    assert.ok(compositor)
    const source = sourceCanvas()
    const mask = maskCanvas()
    assert.equal(compositor.render(source, mask, 'standard', 1), true)
    if (reason === 'event') fake.dispatchContextLost()
    if (reason === 'poll') fake.contextLost()
    if (reason === 'dispose') compositor.dispose()
    const uploads = fake.uploads.length
    assert.equal(compositor.render(source, mask, 'standard', 2), false)
    assert.equal(fake.uploads.length, uploads)
    compositor.dispose()
  }
})

test('initialization failures release every texture that was created', () => {
  for (const options of [{ failedAllocation: 2 }, { incompleteFramebuffer: true }]) {
    const fake = installGL(options)
    assert.equal(createWebGLBlurCompositor(1280, 720), null)
    assert.equal(fake.deletedTextures.length, fake.textures.length)
    assert.deepEqual(new Set(fake.deletedTextures), new Set(fake.textures))
  }
})

test('an upload exception declines the frame and can recover on the next render', () => {
  const fake = installGL()
  const compositor = createWebGLBlurCompositor(1280, 720)
  assert.ok(compositor)
  const source = sourceCanvas()
  const mask = maskCanvas()
  fake.failUploads(true, 1)
  assert.equal(compositor.render(source, mask, 'standard', 1), false)
  assert.equal(fake.draws.length, 0)
  fake.failUploads(false)
  assert.equal(compositor.render(source, mask, 'standard', 1), true)
  assert.equal(fake.uploads.length, 3)
  assert.equal(fake.uploads.filter(({ texture }) => texture === fake.textures[1]).length, 1)
  compositor.dispose()
})

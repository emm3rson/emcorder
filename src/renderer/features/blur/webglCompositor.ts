import { BLUR_STRENGTHS, type BlurStrength } from '../../../shared/blurStrength'

export interface WebGLBlurCompositor {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  render(source: CanvasImageSource, mask: CanvasImageSource, strength: BlurStrength): boolean
  dispose(): void
}

const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

out vec2 v_uv;

void main() {
  vec2 pos = POSITIONS[gl_VertexID];
  v_uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`

const PASS1_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_source;
uniform sampler2D u_mask;
uniform float u_stepX;
uniform float u_sourceLod;

out vec4 outColor;

const float WEIGHTS[9] = float[9](
  1.000000,
  0.975611,
  0.905955,
  0.800737,
  0.673638,
  0.539408,
  0.411112,
  0.298234,
  0.205924
);

void main() {
  float centerMask = texture(u_mask, v_uv).a;
  vec3 sumColor = vec3(0.0);
  float sumWeight = 0.0;

  for (int i = -8; i <= 8; i++) {
    float gaussWeight = WEIGHTS[abs(i)];
    vec2 sampleUv = v_uv + vec2(float(i) * u_stepX, 0.0);
    vec3 srcColor = textureLod(u_source, sampleUv, u_sourceLod).rgb;
    float m = texture(u_mask, sampleUv).a;
    float bgWeight = gaussWeight * max(0.015, 1.0 - smoothstep(0.28, 0.68, m));
    sumColor += srcColor * bgWeight;
    sumWeight += bgWeight;
  }

  outColor = vec4(sumColor / max(sumWeight, 0.0001), centerMask);
}
`

const PASS2_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_pass1;
uniform float u_stepY;

out vec4 outColor;

const float WEIGHTS[9] = float[9](
  1.000000,
  0.975611,
  0.905955,
  0.800737,
  0.673638,
  0.539408,
  0.411112,
  0.298234,
  0.205924
);

void main() {
  vec3 sumColor = vec3(0.0);
  float sumWeight = 0.0;

  for (int i = -8; i <= 8; i++) {
    float gaussWeight = WEIGHTS[abs(i)];
    vec2 sampleUv = v_uv + vec2(0.0, float(i) * u_stepY);
    vec4 tap = texture(u_pass1, sampleUv);
    float bgWeight = gaussWeight * max(0.015, 1.0 - smoothstep(0.28, 0.68, tap.a));
    sumColor += tap.rgb * bgWeight;
    sumWeight += bgWeight;
  }

  outColor = vec4(sumColor / max(sumWeight, 0.0001), 1.0);
}
`

const PASS3_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_source;
uniform sampler2D u_mask;
uniform sampler2D u_blurred;
uniform vec2 u_maskTexelSize;

out vec4 outColor;

void main() {
  vec3 sharp = texture(u_source, v_uv).rgb;
  vec3 blurred = texture(u_blurred, v_uv).rgb;
  float centerMask = texture(u_mask, v_uv).a;

  float refinedMask = centerMask;
  if (centerMask > 0.02 && centerMask < 0.98) {
    float bilateralMask = 0.0;
    float totalW = 0.0;
    vec2 stepSize = u_maskTexelSize * 1.35;

    for (int dy = -2; dy <= 2; dy++) {
      for (int dx = -2; dx <= 2; dx++) {
        vec2 sampleUv = v_uv + vec2(float(dx), float(dy)) * stepSize;
        vec3 sampleColor = texture(u_source, sampleUv).rgb;
        float sampleMask = texture(u_mask, sampleUv).a;

        vec3 diff = sampleColor - sharp;
        float lumaDiff = dot(diff, vec3(0.30, 0.59, 0.11));
        float colorDist2 = lumaDiff * lumaDiff * 2.0 + dot(diff, diff);

        float spatialWeight = exp(-float(dx * dx + dy * dy) / (2.0 * 1.5 * 1.5));
        float w = spatialWeight * exp(-colorDist2 / (2.0 * 0.08 * 0.08));

        bilateralMask += sampleMask * w;
        totalW += w;
      }
    }

    refinedMask = bilateralMask / max(totalW, 0.0001);
  }

  // Retain more of moderately confident hair, hands, and clothing edges while
  // keeping low-confidence background predictions below the transition.
  float alpha = smoothstep(0.32, 0.70, refinedMask);
  vec3 finalColor = mix(blurred, sharp, alpha);
  outColor = vec4(finalColor, 1.0);
}
`

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexShader: WebGLShader,
  fragmentSource: string,
): WebGLProgram | null {
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (!fragmentShader) return null

  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(fragmentShader)
    return null
  }

  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(fragmentShader)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }
  return program
}

function createTexture(gl: WebGL2RenderingContext, width?: number, height?: number): WebGLTexture | null {
  const texture = gl.createTexture()
  if (!texture) return null
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  if (width !== undefined && height !== undefined) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  }
  return texture
}

function createFramebuffer(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
): WebGLFramebuffer | null {
  const fbo = gl.createFramebuffer()
  if (!fbo) return null
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo)
    return null
  }
  return fbo
}

function createSurface(width: number, height: number): OffscreenCanvas | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  return new OffscreenCanvas(width, height)
}

export function createWebGLBlurCompositor(width: number, height: number): WebGLBlurCompositor | null {
  if (width <= 0 || height <= 0) return null

  let canvas: OffscreenCanvas | null = null
  try {
    canvas = createSurface(width, height)
    if (!canvas) return null
    canvas.width = width
    canvas.height = height
  } catch {
    return null
  }

  let gl: WebGL2RenderingContext | null = null
  try {
    gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null
  } catch {
    return null
  }

  if (
    !gl ||
    typeof gl.createShader !== 'function' ||
    typeof gl.createFramebuffer !== 'function' ||
    typeof gl.createVertexArray !== 'function'
  ) {
    return null
  }

  const blurWidth = Math.max(64, Math.round(width / 4))
  const blurHeight = Math.max(36, Math.round(height / 4))

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE)
  if (!vertexShader) return null

  const pass1Program = createProgram(gl, vertexShader, PASS1_FRAGMENT_SHADER_SOURCE)
  const pass2Program = createProgram(gl, vertexShader, PASS2_FRAGMENT_SHADER_SOURCE)
  const pass3Program = createProgram(gl, vertexShader, PASS3_FRAGMENT_SHADER_SOURCE)
  gl.deleteShader(vertexShader)

  const vao = gl.createVertexArray()
  const sourceTex = createTexture(gl)
  const maskTex = createTexture(gl)
  const fboTexA = createTexture(gl, blurWidth, blurHeight)
  const fboTexB = createTexture(gl, blurWidth, blurHeight)
  const fboA = fboTexA ? createFramebuffer(gl, fboTexA) : null
  const fboB = fboTexB ? createFramebuffer(gl, fboTexB) : null

  const cleanupResources = () => {
    if (fboA) gl.deleteFramebuffer(fboA)
    if (fboB) gl.deleteFramebuffer(fboB)
    if (fboTexA) gl.deleteTexture(fboTexA)
    if (fboTexB) gl.deleteTexture(fboTexB)
    if (sourceTex) gl.deleteTexture(sourceTex)
    if (maskTex) gl.deleteTexture(maskTex)
    if (vao) gl.deleteVertexArray(vao)
    if (pass1Program) gl.deleteProgram(pass1Program)
    if (pass2Program) gl.deleteProgram(pass2Program)
    if (pass3Program) gl.deleteProgram(pass3Program)
  }

  if (
    !pass1Program ||
    !pass2Program ||
    !pass3Program ||
    !vao ||
    !sourceTex ||
    !maskTex ||
    !fboTexA ||
    !fboTexB ||
    !fboA ||
    !fboB
  ) {
    cleanupResources()
    return null
  }

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.BLEND)

  gl.bindTexture(gl.TEXTURE_2D, sourceTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)

  gl.useProgram(pass1Program)
  gl.uniform1i(gl.getUniformLocation(pass1Program, 'u_source'), 0)
  gl.uniform1i(gl.getUniformLocation(pass1Program, 'u_mask'), 1)
  const stepXLocation = gl.getUniformLocation(pass1Program, 'u_stepX')
  const sourceLodLocation = gl.getUniformLocation(pass1Program, 'u_sourceLod')

  gl.useProgram(pass2Program)
  gl.uniform1i(gl.getUniformLocation(pass2Program, 'u_pass1'), 0)
  const stepYLocation = gl.getUniformLocation(pass2Program, 'u_stepY')

  gl.useProgram(pass3Program)
  gl.uniform1i(gl.getUniformLocation(pass3Program, 'u_source'), 0)
  gl.uniform1i(gl.getUniformLocation(pass3Program, 'u_mask'), 1)
  gl.uniform1i(gl.getUniformLocation(pass3Program, 'u_blurred'), 2)
  gl.uniform2f(gl.getUniformLocation(pass3Program, 'u_maskTexelSize'), 1.0 / 256.0, 1.0 / 256.0)

  let disposed = false
  let contextLost = false

  const handleContextLost = (event: Event) => {
    event.preventDefault()
    contextLost = true
  }

  canvas.addEventListener?.('webglcontextlost', handleContextLost)

  return {
    canvas,
    render(source: CanvasImageSource, mask: CanvasImageSource, strength: BlurStrength): boolean {
      if (disposed || contextLost || gl.isContextLost()) {
        return false
      }

      try {
        const strengthScale = BLUR_STRENGTHS[strength].scale
        gl.bindVertexArray(vao)

        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, sourceTex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource)
        gl.generateMipmap(gl.TEXTURE_2D)

        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, maskTex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask as TexImageSource)

        // Pass 1: Horizontal Foreground-Excluded Gaussian Blur (source + mask -> fboA)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboA)
        gl.viewport(0, 0, blurWidth, blurHeight)
        gl.useProgram(pass1Program)
        gl.uniform1f(stepXLocation, strengthScale / blurWidth)
        gl.uniform1f(sourceLodLocation, 2.0 + Math.log2(strengthScale))
        gl.drawArrays(gl.TRIANGLES, 0, 3)

        // Pass 2: Vertical Foreground-Excluded Gaussian Blur (fboA -> fboB)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboB)
        gl.viewport(0, 0, blurWidth, blurHeight)
        gl.useProgram(pass2Program)
        gl.uniform1f(stepYLocation, strengthScale / blurHeight)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, fboTexA)
        gl.drawArrays(gl.TRIANGLES, 0, 3)

        // Pass 3: Joint Bilateral Guided Mask Upsampling + Steep Sigmoid & Edge Decontamination
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, width, height)
        gl.useProgram(pass3Program)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, sourceTex)
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, maskTex)
        gl.activeTexture(gl.TEXTURE2)
        gl.bindTexture(gl.TEXTURE_2D, fboTexB)
        gl.drawArrays(gl.TRIANGLES, 0, 3)

        gl.bindVertexArray(null)
        return true
      } catch {
        return false
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      canvas.removeEventListener?.('webglcontextlost', handleContextLost)
      if (!contextLost && !gl.isContextLost()) {
        cleanupResources()
      }
      canvas.width = 1
      canvas.height = 1
    },
  }
}

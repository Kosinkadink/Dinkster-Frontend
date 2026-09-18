/**
 * WebGL2 executor for schema-declared glsl mirrors. Draws one fragment
 * shader (the schema's mirror source) over input textures bound per the
 * schema binding contract: `sampler2D u_<id>` per image input read with
 * texelFetch, scalar uniforms named by input id. Texture row y equals image
 * row y (no upload flip) and framebuffer row y equals output row y, so a
 * texel and its estimate share coordinates.
 *
 * Two paths share the program cache: the display path uploads decoded
 * browser imagery into RGBA8 and reads back an ImageData for preview
 * panels; the float path uploads RGBA float32 frames into RGBA32F and reads
 * back float pixels (requires EXT_color_buffer_float), which is what parity
 * tests compare against CPU-computed expectations.
 *
 * Every failure - context creation, shader compile/link, framebuffer
 * completeness, context loss - returns undefined rather than throwing:
 * mirrors are presentation only and must fail soft.
 */
import type { GlslScalarUniform } from '@dinkster/core'

/** One RGBA float32 frame in row-major top-first order. */
export interface FloatFrame {
  readonly data: Float32Array
  readonly width: number
  readonly height: number
}

export interface GlslDisplayDraw {
  readonly source: string
  readonly images: readonly { readonly name: string; readonly image: TexImageSource }[]
  readonly scalars: readonly GlslScalarUniform[]
  readonly width: number
  readonly height: number
}

export interface GlslFloatDraw {
  readonly source: string
  readonly images: readonly { readonly name: string; readonly frame: FloatFrame }[]
  readonly scalars: readonly GlslScalarUniform[]
  readonly width: number
  readonly height: number
}

export interface GlslMirrorRunner {
  /** Draw into RGBA8 and read back display pixels; undefined = fail soft. */
  renderDisplay(draw: GlslDisplayDraw): ImageData | undefined
  /** Draw into RGBA32F and read back float pixels; undefined = fail soft. */
  renderFloat(draw: GlslFloatDraw): Float32Array | undefined
  /** Release the context and every cached program. */
  dispose(): void
}

/** Fullscreen triangle from gl_VertexID; no attributes or buffers. */
const VERTEX_SOURCE = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`

const MAX_ESTIMATE_PIXELS = 4096 * 4096

/** Program cache bound; the oldest entry is dropped and deleted past it. */
const MAX_CACHED_PROGRAMS = 32

interface RunnerState {
  readonly gl: WebGL2RenderingContext
  /**
   * Mirror source -> linked program, or null after a failed compile/link.
   * Insertion order is recency order: hits re-insert, inserts evict the
   * oldest entry (deleting its program) once the bound is reached.
   */
  readonly programs: Map<string, WebGLProgram | null>
  colorBufferFloat: boolean | undefined
}

const createDefaultGl = (): WebGL2RenderingContext | undefined => {
  const canvas: OffscreenCanvas | HTMLCanvasElement | undefined =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : typeof document !== 'undefined'
        ? document.createElement('canvas')
        : undefined
  const gl = canvas?.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null | undefined
  return gl ?? undefined
}

const compileProgram = (state: RunnerState, fragmentSource: string): WebGLProgram | null => {
  const cached = state.programs.get(fragmentSource)
  if (cached !== undefined) {
    state.programs.delete(fragmentSource)
    state.programs.set(fragmentSource, cached)
    return cached
  }
  const { gl } = state
  const link = (): WebGLProgram | null => {
    const vertex = gl.createShader(gl.VERTEX_SHADER)
    const fragment = gl.createShader(gl.FRAGMENT_SHADER)
    const program = gl.createProgram()
    if (!vertex || !fragment || !program) {
      if (vertex) gl.deleteShader(vertex)
      if (fragment) gl.deleteShader(fragment)
      if (program) gl.deleteProgram(program)
      return null
    }
    try {
      gl.shaderSource(vertex, VERTEX_SOURCE)
      gl.compileShader(vertex)
      gl.shaderSource(fragment, fragmentSource)
      gl.compileShader(fragment)
      gl.attachShader(program, vertex)
      gl.attachShader(program, fragment)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program)
        return null
      }
      return program
    } finally {
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
    }
  }
  const program = link()
  if (state.programs.size >= MAX_CACHED_PROGRAMS) {
    const oldest = state.programs.keys().next()
    if (oldest.done !== true) {
      const evicted = state.programs.get(oldest.value)
      if (evicted) gl.deleteProgram(evicted)
      state.programs.delete(oldest.value)
    }
  }
  state.programs.set(fragmentSource, program)
  return program
}

const setScalars = (
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  scalars: readonly GlslScalarUniform[],
): void => {
  for (const scalar of scalars) {
    const location = gl.getUniformLocation(program, scalar.name)
    if (location === null) continue
    if (scalar.glslType === 'float') gl.uniform1f(location, Number(scalar.value))
    else if (scalar.glslType === 'int') gl.uniform1i(location, Number(scalar.value))
    else gl.uniform1i(location, scalar.value === true ? 1 : 0)
  }
}

/** Nearest/clamped sampling state; texelFetch never filters, but RGBA32F
 * textures are not filterable and default LINEAR would leave them
 * incomplete (reads would return zero). */
const configureTexture = (gl: WebGL2RenderingContext): void => {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
}

export function createGlslMirrorRunner(
  /** Test seam: supplies the WebGL2 context instead of an offscreen canvas. */
  acquireGl: () => WebGL2RenderingContext | undefined = createDefaultGl,
): GlslMirrorRunner {
  /** undefined = not yet created, null = disposed or unavailable. */
  let state: RunnerState | undefined | null
  const ensureState = (): RunnerState | undefined => {
    if (state === null) return undefined
    if (state !== undefined && state.gl.isContextLost()) state = undefined
    if (state === undefined) {
      const gl = acquireGl()
      state = gl === undefined ? null : { gl, programs: new Map(), colorBufferFloat: undefined }
    }
    return state ?? undefined
  }

  /** Compile, bind, draw, hand the bound framebuffer to `read`, clean up. */
  const draw = <T>(args: {
    readonly source: string
    readonly scalars: readonly GlslScalarUniform[]
    readonly width: number
    readonly height: number
    readonly float: boolean
    readonly imageNames: readonly string[]
    readonly upload: (gl: WebGL2RenderingContext, index: number) => boolean
    readonly read: (gl: WebGL2RenderingContext) => T
  }): T | undefined => {
    if (!Number.isInteger(args.width) || !Number.isInteger(args.height)) return undefined
    if (args.width <= 0 || args.height <= 0 || args.width * args.height > MAX_ESTIMATE_PIXELS) return undefined
    const current = ensureState()
    if (!current) return undefined
    const { gl } = current
    if (args.float) {
      current.colorBufferFloat ??= gl.getExtension('EXT_color_buffer_float') !== null
      if (!current.colorBufferFloat) return undefined
    }
    const program = compileProgram(current, args.source)
    if (!program) return undefined

    const textures: WebGLTexture[] = []
    let framebuffer: WebGLFramebuffer | null = null
    try {
      gl.useProgram(program)
      gl.disable(gl.BLEND)
      gl.disable(gl.DEPTH_TEST)
      gl.disable(gl.SCISSOR_TEST)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)

      for (let index = 0; index < args.imageNames.length; index++) {
        const texture = gl.createTexture()
        if (!texture) return undefined
        textures.push(texture)
        gl.activeTexture(gl.TEXTURE0 + index)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        configureTexture(gl)
        if (!args.upload(gl, index)) return undefined
        const location = gl.getUniformLocation(program, args.imageNames[index]!)
        if (location !== null) gl.uniform1i(location, index)
      }
      setScalars(gl, program, args.scalars)

      const target = gl.createTexture()
      if (!target) return undefined
      textures.push(target)
      framebuffer = gl.createFramebuffer()
      if (!framebuffer) return undefined
      gl.activeTexture(gl.TEXTURE0 + args.imageNames.length)
      gl.bindTexture(gl.TEXTURE_2D, target)
      configureTexture(gl)
      gl.texImage2D(
        gl.TEXTURE_2D, 0, args.float ? gl.RGBA32F : gl.RGBA8, args.width, args.height, 0,
        gl.RGBA, args.float ? gl.FLOAT : gl.UNSIGNED_BYTE, null,
      )
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return undefined

      gl.viewport(0, 0, args.width, args.height)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      const result = args.read(gl)
      return gl.isContextLost() ? undefined : result
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.bindTexture(gl.TEXTURE_2D, null)
      for (const texture of textures) gl.deleteTexture(texture)
      if (framebuffer) gl.deleteFramebuffer(framebuffer)
    }
  }

  return {
    renderDisplay(request) {
      return draw({
        source: request.source,
        scalars: request.scalars,
        width: request.width,
        height: request.height,
        float: false,
        imageNames: request.images.map((image) => image.name),
        upload: (gl, index) => {
          const image = request.images[index]!.image
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image)
          } catch {
            return false
          }
          return gl.getError() === gl.NO_ERROR
        },
        read: (gl) => {
          const pixels = new Uint8ClampedArray(request.width * request.height * 4)
          gl.readPixels(0, 0, request.width, request.height, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pixels.buffer))
          // Decoded preview imagery carries a synthetic opaque alpha for
          // images whose semantic channel count the client cannot know; the
          // shader transforms that padding like any channel (invert turns
          // a=1 into a=0), which a premultiplied canvas draw would erase.
          // Display panels want the computed color, so present opaque.
          for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
          return new ImageData(pixels, request.width, request.height)
        },
      })
    },
    renderFloat(request) {
      for (const image of request.images) {
        const frame = image.frame
        if (frame.data.length !== frame.width * frame.height * 4) return undefined
      }
      return draw({
        source: request.source,
        scalars: request.scalars,
        width: request.width,
        height: request.height,
        float: true,
        imageNames: request.images.map((image) => image.name),
        upload: (gl, index) => {
          const frame = request.images[index]!.frame
          gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA32F, frame.width, frame.height, 0,
            gl.RGBA, gl.FLOAT, frame.data,
          )
          return gl.getError() === gl.NO_ERROR
        },
        read: (gl) => {
          const pixels = new Float32Array(request.width * request.height * 4)
          gl.readPixels(0, 0, request.width, request.height, gl.RGBA, gl.FLOAT, pixels)
          return pixels
        },
      })
    },
    dispose() {
      if (state) {
        for (const program of state.programs.values()) {
          if (program) state.gl.deleteProgram(program)
        }
        state.programs.clear()
        state.gl.getExtension('WEBGL_lose_context')?.loseContext()
      }
      state = null
    },
  }
}

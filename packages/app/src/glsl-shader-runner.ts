import type { GlslShaderState } from '@dinkster/core'

export interface GlslShaderDraw {
  readonly source: string
  readonly state: GlslShaderState
  readonly images: Readonly<Record<string, TexImageSource>>
  readonly output: 0 | 1 | 2 | 3
}

export type GlslShaderResult =
  | { readonly ok: true; readonly image: ImageData }
  | { readonly ok: false; readonly diagnostics: readonly string[] }

export interface GlslShaderRunner {
  render(draw: GlslShaderDraw): GlslShaderResult
  dispose(): void
}

const VERTEX_SOURCE = `#version 300 es
out vec2 v_texCoord;
void main() {
  vec2 vertices[3] = vec2[](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  v_texCoord = vertices[gl_VertexID] * 0.5 + 0.5;
  gl_Position = vec4(vertices[gl_VertexID], 0.0, 1.0);
}`

const MAX_PREVIEW_PIXELS = 2048 * 2048
const MAX_SOURCE_BYTES = 65_536
const PASSES = /^\s*#pragma\s+passes\s+(\d+)\s*$/m
const IMAGE_NAME = /^u_image([0-4])$/
const CURVE_NAME = /^u_curve([0-3])$/
const TARGET_TEXTURE_UNIT = 15
const ZERO = new Float32Array([0, 0, 0, 0])

const createDefaultContext = (): WebGL2RenderingContext | undefined => {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(1, 1)
    : document.createElement('canvas')
  return canvas.getContext('webgl2', {
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null ?? undefined
}

export function createGlslShaderRunner(
  acquire: () => WebGL2RenderingContext | undefined = createDefaultContext,
): GlslShaderRunner {
  const gl = acquire()
  const fail = (...diagnostics: string[]): GlslShaderResult => ({ ok: false, diagnostics })

  const compile = (kind: number, source: string): WebGLShader | string => {
    if (!gl) return 'WebGL2 is unavailable; browser preview is disabled'
    const shader = gl.createShader(kind)
    if (!shader) return 'WebGL2 could not allocate a shader'
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
    const message = gl.getShaderInfoLog(shader) || 'Shader compilation failed'
    gl.deleteShader(shader)
    return message
  }

  return {
    render(draw) {
      if (!gl) return fail('WebGL2 is unavailable; browser preview is disabled')
      const { width, height } = draw.state
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
          width <= 0 || height <= 0 || width * height > MAX_PREVIEW_PIXELS) {
        return fail(`Preview ${width}x${height} exceeds the ${MAX_PREVIEW_PIXELS}-pixel browser limit`)
      }
      if (new TextEncoder().encode(draw.source).byteLength > MAX_SOURCE_BYTES) {
        return fail(`Shader source exceeds ${MAX_SOURCE_BYTES} UTF-8 bytes`)
      }
      const passText = draw.source.match(PASSES)?.[1]
      const passes = passText === undefined ? 1 : Number(passText)
      if (!Number.isSafeInteger(passes) || passes < 1 || passes > 32) {
        return fail('#pragma passes must be an integer from 1 through 32')
      }
      for (const input of draw.state.inputs) {
        if (!(input.name in draw.images)) return fail(`Preview image ${input.name} is unavailable`)
      }
      if (!gl.getExtension('EXT_color_buffer_float')) {
        return fail('WebGL2 float render targets are unavailable; browser preview is disabled')
      }
      if (Object.keys(draw.state.curves).length > 0 && !gl.getExtension('OES_texture_float_linear')) {
        return fail('WebGL2 float texture filtering is unavailable; curve preview is disabled')
      }

      const vertex = compile(gl.VERTEX_SHADER, VERTEX_SOURCE)
      const fragment = compile(gl.FRAGMENT_SHADER, draw.source)
      if (typeof vertex === 'string' || typeof fragment === 'string') {
        if (typeof vertex !== 'string') gl.deleteShader(vertex)
        if (typeof fragment !== 'string') gl.deleteShader(fragment)
        return fail(...[vertex, fragment].filter((value): value is string => typeof value === 'string'))
      }
      const program = gl.createProgram()
      if (!program) {
        gl.deleteShader(vertex)
        gl.deleteShader(fragment)
        return fail('WebGL2 could not allocate a program')
      }

      const textures: WebGLTexture[] = []
      const framebuffers: WebGLFramebuffer[] = []
      const texture = (): WebGLTexture => {
        const value = gl.createTexture()
        if (!value) throw new Error('WebGL2 could not allocate a texture')
        textures.push(value)
        return value
      }
      const framebuffer = (): WebGLFramebuffer => {
        const value = gl.createFramebuffer()
        if (!value) throw new Error('WebGL2 could not allocate a framebuffer')
        framebuffers.push(value)
        return value
      }
      const configureTexture = (): void => {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      }
      const uniform = (name: string): WebGLUniformLocation | null =>
        gl.getUniformLocation(program, name)

      try {
        gl.attachShader(program, vertex)
        gl.attachShader(program, fragment)
        gl.linkProgram(program)
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          return fail(gl.getProgramInfoLog(program) || 'Shader link failed')
        }
        gl.useProgram(program)

        const resolution = uniform('u_resolution')
        if (resolution !== null) gl.uniform2f(resolution, width, height)
        for (const [name, value] of Object.entries(draw.state.floats)) {
          const location = uniform(name)
          if (location !== null) gl.uniform1f(location, value)
        }
        for (const [name, value] of Object.entries(draw.state.ints)) {
          const location = uniform(name)
          if (location !== null) gl.uniform1i(location, value)
        }
        for (const [name, value] of Object.entries(draw.state.bools)) {
          const location = uniform(name)
          if (location !== null) gl.uniform1i(location, value ? 1 : 0)
        }

        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
        for (const input of draw.state.inputs) {
          const match = IMAGE_NAME.exec(input.name)
          if (!match) throw new Error(`Invalid preview image name ${input.name}`)
          const unit = Number(match[1])
          gl.activeTexture(gl.TEXTURE0 + unit)
          gl.bindTexture(gl.TEXTURE_2D, texture())
          configureTexture()
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            draw.images[input.name]!,
          )
          const location = uniform(input.name)
          if (location !== null) gl.uniform1i(location, unit)
        }
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)

        for (const [name, samples] of Object.entries(draw.state.curves)) {
          const match = CURVE_NAME.exec(name)
          if (!match) throw new Error(`Invalid curve uniform name ${name}`)
          const unit = 5 + Number(match[1])
          gl.activeTexture(gl.TEXTURE0 + unit)
          gl.bindTexture(gl.TEXTURE_2D, texture())
          configureTexture()
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.R32F,
            samples.length,
            1,
            0,
            gl.RED,
            gl.FLOAT,
            new Float32Array(samples),
          )
          const location = uniform(name)
          if (location !== null) gl.uniform1i(location, unit)
        }

        const makeTarget = (): WebGLTexture => {
          const target = texture()
          gl.bindTexture(gl.TEXTURE_2D, target)
          configureTexture()
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA32F,
            width,
            height,
            0,
            gl.RGBA,
            gl.FLOAT,
            null,
          )
          return target
        }
        // Keep framebuffer targets off the fixed image (0-4) and curve (5-8)
        // sampler units so allocation cannot replace a shader input binding.
        gl.activeTexture(gl.TEXTURE0 + TARGET_TEXTURE_UNIT)
        const finalTargets = Array.from({ length: 4 }, makeTarget)
        const finalFramebuffer = framebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, finalFramebuffer)
        finalTargets.forEach((target, index) => gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0 + index,
          gl.TEXTURE_2D,
          target,
          0,
        ))
        const finalBuffers = [
          gl.COLOR_ATTACHMENT0,
          gl.COLOR_ATTACHMENT1,
          gl.COLOR_ATTACHMENT2,
          gl.COLOR_ATTACHMENT3,
        ]
        gl.drawBuffers(finalBuffers)
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          return fail('Four-output float framebuffer is unavailable')
        }

        const pingTargets = passes > 1 ? [makeTarget(), makeTarget()] : []
        const pingFramebuffers = pingTargets.map((target) => {
          const value = framebuffer()
          gl.bindFramebuffer(gl.FRAMEBUFFER, value)
          gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            target,
            0,
          )
          gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE, gl.NONE, gl.NONE])
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error('Multipass float framebuffer is unavailable')
          }
          return value
        })

        const passLocation = uniform('u_pass')
        const image0Location = uniform('u_image0')
        gl.viewport(0, 0, width, height)
        gl.disable(gl.BLEND)
        gl.disable(gl.DEPTH_TEST)
        gl.disable(gl.SCISSOR_TEST)
        for (let pass = 0; pass < passes; pass += 1) {
          const last = pass === passes - 1
          gl.bindFramebuffer(
            gl.FRAMEBUFFER,
            last ? finalFramebuffer : pingFramebuffers[pass % 2]!,
          )
          gl.drawBuffers(last ? finalBuffers : [gl.COLOR_ATTACHMENT0, gl.NONE, gl.NONE, gl.NONE])
          if (passLocation !== null) gl.uniform1i(passLocation, pass)
          if (pass > 0) {
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, pingTargets[(pass - 1) % 2]!)
            if (image0Location !== null) gl.uniform1i(image0Location, 0)
          }
          const clearCount = last ? 4 : 1
          for (let index = 0; index < clearCount; index += 1) {
            gl.clearBufferfv(gl.COLOR, index, ZERO)
          }
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          const error = gl.getError()
          if (error !== gl.NO_ERROR) {
            throw new Error(`WebGL2 rendering failed with error 0x${error.toString(16)}`)
          }
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, finalFramebuffer)
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + draw.output)
        const values = new Float32Array(width * height * 4)
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, values)
        const error = gl.getError()
        if (error !== gl.NO_ERROR) {
          throw new Error(`WebGL2 readback failed with error 0x${error.toString(16)}`)
        }
        if (values.some((value) => !Number.isFinite(value))) {
          return fail('Preview output contains non-finite values; native output was not modified')
        }
        if (values.some((value) => value < 0 || value > 1)) {
          return fail('Preview output is outside display range [0, 1]; native output was not clamped')
        }
        const pixels = new Uint8ClampedArray(values.length)
        for (let y = 0; y < height; y += 1) {
          const sourceRow = height - y - 1
          for (let x = 0; x < width * 4; x += 1) {
            pixels[y * width * 4 + x] = Math.round(values[sourceRow * width * 4 + x]! * 255)
          }
        }
        return { ok: true, image: new ImageData(pixels, width, height) }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.useProgram(null)
        for (const value of textures) gl.deleteTexture(value)
        for (const value of framebuffers) gl.deleteFramebuffer(value)
        gl.deleteProgram(program)
        gl.deleteShader(vertex)
        gl.deleteShader(fragment)
      }
    },
    dispose() {
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

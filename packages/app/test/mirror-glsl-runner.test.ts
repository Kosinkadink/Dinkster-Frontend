import { describe, expect, it } from 'vitest'
import { createGlslMirrorRunner } from '../src/mirror-glsl-runner.js'

// The runner's program cache and allocation cleanup are exercised through a
// fake WebGL2 context injected via the runner's context seam: every GL call
// the float path makes is stubbed, and shader/program handle lifetimes are
// recorded so the tests can prove eviction deletes exactly the evicted
// program and failed compiles never strand handles.

interface Handle {
  readonly id: number
}

const createFakeGl = () => {
  const createdPrograms: Handle[] = []
  const deletedPrograms: Handle[] = []
  const createdShaders: Handle[] = []
  const deletedShaders: Handle[] = []
  const createdTextures: Handle[] = []
  const deletedTextures: Handle[] = []
  let nextId = 1
  let shaderFailures = 0
  let programFailures = 0
  let framebufferFailures = 0
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    LINK_STATUS: 0x8b82,
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    SCISSOR_TEST: 0x0c11,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    UNPACK_ALIGNMENT: 0x0cf5,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    RGBA32F: 0x8814,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    NO_ERROR: 0,
    TRIANGLES: 4,
    createShader: (): Handle | null => {
      if (shaderFailures > 0) {
        shaderFailures--
        return null
      }
      const shader = { id: nextId++ }
      createdShaders.push(shader)
      return shader
    },
    createProgram: (): Handle | null => {
      if (programFailures > 0) {
        programFailures--
        return null
      }
      const program = { id: nextId++ }
      createdPrograms.push(program)
      return program
    },
    deleteShader: (shader: Handle | null): void => {
      if (shader) deletedShaders.push(shader)
    },
    deleteProgram: (program: Handle | null): void => {
      if (program) deletedPrograms.push(program)
    },
    shaderSource: (): void => {},
    compileShader: (): void => {},
    attachShader: (): void => {},
    linkProgram: (): void => {},
    getProgramParameter: (): boolean => true,
    getExtension: (name: string): unknown =>
      name === 'EXT_color_buffer_float' ? {} : name === 'WEBGL_lose_context' ? { loseContext: () => {} } : null,
    useProgram: (): void => {},
    disable: (): void => {},
    pixelStorei: (): void => {},
    createTexture: (): Handle => {
      const texture = { id: nextId++ }
      createdTextures.push(texture)
      return texture
    },
    activeTexture: (): void => {},
    bindTexture: (): void => {},
    texParameteri: (): void => {},
    texImage2D: (): void => {},
    getUniformLocation: (): null => null,
    uniform1i: (): void => {},
    uniform1f: (): void => {},
    createFramebuffer: (): object | null => {
      if (framebufferFailures > 0) {
        framebufferFailures--
        return null
      }
      return {}
    },
    bindFramebuffer: (): void => {},
    framebufferTexture2D: (): void => {},
    checkFramebufferStatus: (): number => 0x8cd5,
    viewport: (): void => {},
    drawArrays: (): void => {},
    readPixels: (): void => {},
    getError: (): number => 0,
    isContextLost: (): boolean => false,
    deleteTexture: (texture: Handle | null): void => {
      if (texture) deletedTextures.push(texture)
    },
    deleteFramebuffer: (): void => {},
  }
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    createdPrograms,
    deletedPrograms,
    createdShaders,
    deletedShaders,
    createdTextures,
    deletedTextures,
    failNextShaders: (count: number) => {
      shaderFailures += count
    },
    failNextPrograms: (count: number) => {
      programFailures += count
    },
    failNextFramebuffers: (count: number) => {
      framebufferFailures += count
    },
  }
}

const setup = () => {
  const fake = createFakeGl()
  const runner = createGlslMirrorRunner(() => fake.gl)
  const render = (source: string) =>
    runner.renderFloat({ source, images: [], scalars: [], width: 1, height: 1 })
  return { ...fake, runner, render }
}

/** Mirrors MAX_CACHED_PROGRAMS in mirror-glsl-runner.ts. */
const BOUND = 32

describe('mirror glsl runner program cache', () => {
  it('evicts and deletes exactly the oldest program past the bound', () => {
    const t = setup()
    for (let i = 0; i < BOUND; i++) expect(t.render(`s${i}`)).toBeDefined()
    expect(t.createdPrograms).toHaveLength(BOUND)
    expect(t.deletedPrograms).toHaveLength(0)

    expect(t.render(`s${BOUND}`)).toBeDefined()
    expect(t.deletedPrograms).toEqual([t.createdPrograms[0]])

    // The evicted source recompiles; a retained one does not.
    t.render('s0')
    expect(t.createdPrograms).toHaveLength(BOUND + 2)
    t.render(`s${BOUND}`)
    expect(t.createdPrograms).toHaveLength(BOUND + 2)
  })

  it('keeps a recently reused program and evicts the next-oldest instead', () => {
    const t = setup()
    for (let i = 0; i < BOUND; i++) t.render(`s${i}`)
    t.render('s0')
    expect(t.createdPrograms).toHaveLength(BOUND)

    t.render(`s${BOUND}`)
    expect(t.deletedPrograms).toEqual([t.createdPrograms[1]])
    t.render('s0')
    expect(t.createdPrograms).toHaveLength(BOUND + 1)
  })

  it('deletes created shaders when program allocation fails, and caches the failure', () => {
    const t = setup()
    t.failNextPrograms(1)
    expect(t.render('broken')).toBeUndefined()
    expect(t.createdShaders).toHaveLength(2)
    expect(t.deletedShaders).toEqual(t.createdShaders)

    // The failure is negative-cached: no new handles on retry.
    expect(t.render('broken')).toBeUndefined()
    expect(t.createdShaders).toHaveLength(2)
    expect(t.createdPrograms).toHaveLength(0)
  })

  it('deletes the created shader and program when shader allocation fails', () => {
    const t = setup()
    t.failNextShaders(1)
    expect(t.render('broken')).toBeUndefined()
    expect(t.createdShaders).toHaveLength(1)
    expect(t.deletedShaders).toEqual(t.createdShaders)
    expect(t.createdPrograms).toHaveLength(1)
    expect(t.deletedPrograms).toEqual(t.createdPrograms)
  })

  it('deletes the target texture when framebuffer allocation fails', () => {
    const t = setup()
    t.failNextFramebuffers(1)
    expect(t.render('s')).toBeUndefined()
    expect(t.createdTextures).toHaveLength(1)
    expect(t.deletedTextures).toEqual(t.createdTextures)
  })

  it('dispose deletes every cached program', () => {
    const t = setup()
    t.render('a')
    t.render('b')
    t.runner.dispose()
    expect(t.deletedPrograms).toEqual(t.createdPrograms)
  })
})

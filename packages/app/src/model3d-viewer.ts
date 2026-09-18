/**
 * Lazy three.js 3D rendering: GLB scenes through GLTFLoader, gaussian-splat
 * PLY through @sparkjsdev/spark. Nothing imports three or spark statically:
 * the first poster render or orbit-viewer mount pulls each library in as its
 * own chunk, so workflows without 3D content never pay for it, and GLB-only
 * workflows never pay for spark.
 *
 * Two consumers share the same loading and framing logic:
 * - renderModel3dPoster: one offscreen render returned as an ImageBitmap,
 *   painted in-canvas by the node preview panel and reused (via
 *   renderModel3dPosterUrl) for asset-browser thumbnails.
 * - mountModel3dViewer: an interactive orbit viewport inside a host-owned
 *   DOM container. Camera state lives in the mounted viewer only; it is
 *   never written to the document.
 */
import { GLB_MIME, SPLAT_PLY_MIME } from './model3d-mime.js'

type ThreeModules = {
  readonly THREE: typeof import('three')
  readonly GLTFLoader: typeof import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader
  readonly OrbitControls: typeof import('three/examples/jsm/controls/OrbitControls.js').OrbitControls
}

let threeModules: Promise<ThreeModules> | undefined

const loadThree = (): Promise<ThreeModules> => {
  threeModules ??= Promise.all([
    import('three'),
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/controls/OrbitControls.js'),
  ]).then(([THREE, loaders, controls]) => ({
    THREE,
    GLTFLoader: loaders.GLTFLoader,
    OrbitControls: controls.OrbitControls,
  }))
  return threeModules
}

type SparkModules = {
  readonly SplatMesh: typeof import('@sparkjsdev/spark').SplatMesh
  readonly SparkRenderer: typeof import('@sparkjsdev/spark').SparkRenderer
}

let sparkModules: Promise<SparkModules> | undefined

const loadSpark = (): Promise<SparkModules> => {
  sparkModules ??= import('@sparkjsdev/spark').then((spark) => ({
    SplatMesh: spark.SplatMesh,
    SparkRenderer: spark.SparkRenderer,
  }))
  return sparkModules
}

interface FramedScene {
  readonly scene: import('three').Scene
  readonly camera: import('three').PerspectiveCamera
  readonly center: import('three').Vector3
  /**
   * Splat scenes need a per-GL-context SparkRenderer in the scene tree
   * (without one, splats are silent no-ops). The scene loads before any
   * WebGL context exists, so the renderer attaches later. Returns the
   * spark view; the caller disposes it before the scene.
   */
  attachSpark?(
    renderer: import('three').WebGLRenderer,
    autoUpdate: boolean,
  ): import('@sparkjsdev/spark').SparkRenderer
  dispose(): void
}

/** Camera framing shared by GLB and splat scenes. */
const frameCamera = (
  THREE: ThreeModules['THREE'],
  bounds: import('three').Box3,
  aspect: number,
): { readonly camera: import('three').PerspectiveCamera; readonly center: import('three').Vector3 } => {
  const size = bounds.isEmpty() ? new THREE.Vector3(1, 1, 1) : bounds.getSize(new THREE.Vector3())
  const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3())
  const radius = Math.max(size.length() / 2, 1e-3)

  const camera = new THREE.PerspectiveCamera(40, aspect, radius / 100, radius * 100)
  const distance = radius / Math.tan((camera.fov * Math.PI) / 360)
  camera.position.set(
    center.x + distance * 0.65,
    center.y + distance * 0.45,
    center.z + distance * 0.65,
  )
  camera.lookAt(center)
  camera.updateProjectionMatrix()
  return { camera, center }
}

/** Load a GLB and build a lit scene with the camera framing its bounds. */
const loadFramedScene = async (modules: ThreeModules, src: string, aspect: number): Promise<FramedScene> => {
  const { THREE } = modules
  const loader = new modules.GLTFLoader()
  const gltf = await loader.loadAsync(src)
  const scene = new THREE.Scene()
  scene.add(gltf.scene)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.4))
  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(1, 1.5, 1.2)
  scene.add(key)

  const bounds = new THREE.Box3().setFromObject(gltf.scene)
  const { camera, center } = frameCamera(THREE, bounds, aspect)

  // GLTF scenes share geometries, materials, and textures across meshes;
  // collect first so each GPU resource is disposed exactly once, and close
  // ImageBitmaps the loader decoded for textures.
  const dispose = (): void => {
    const geometries = new Set<import('three').BufferGeometry>()
    const materials = new Set<import('three').Material>()
    scene.traverse((object) => {
      const mesh = object as Partial<import('three').Mesh>
      if (mesh.geometry !== undefined) geometries.add(mesh.geometry)
      const material = mesh.material
      for (const entry of Array.isArray(material) ? material : material === undefined ? [] : [material]) {
        materials.add(entry)
      }
    })
    const textures = new Set<import('three').Texture>()
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value)
      }
    }
    const bitmaps = new Set<ImageBitmap>()
    for (const texture of textures) {
      const image: unknown = texture.image
      texture.dispose()
      if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) bitmaps.add(image)
    }
    for (const bitmap of bitmaps) bitmap.close()
    for (const material of materials) material.dispose()
    for (const geometry of geometries) geometry.dispose()
  }
  return { scene, camera, center, dispose }
}

/**
 * Load a gaussian-splat PLY and build a scene with the camera framing its
 * bounds. Bytes are fetched on the main thread so blob object URLs work
 * (spark's own URL loading happens inside a worker). Splats are unlit, so
 * the scene carries no lights.
 */
const loadFramedSplatScene = async (
  modules: ThreeModules,
  spark: SparkModules,
  src: string,
  aspect: number,
): Promise<FramedScene> => {
  const { THREE } = modules
  const response = await fetch(src)
  if (!response.ok) throw new Error(`splat fetch failed: ${response.status}`)
  const bytes = await response.arrayBuffer()
  const mesh = new spark.SplatMesh({ fileBytes: bytes, fileName: 'model.ply' })
  try {
    await mesh.initialized
    // 3DGS PLY files use OpenCV-style Y-down coordinates; rotate 180 degrees
    // around X into the three.js Y-up convention (the correction ComfyUI and
    // spark's own viewer apply to every loaded splat file).
    mesh.quaternion.set(1, 0, 0, 0)

    const scene = new THREE.Scene()
    scene.add(mesh)
    scene.updateMatrixWorld(true)
    const bounds = mesh.getBoundingBox(false).clone().applyMatrix4(mesh.matrixWorld)
    const { camera, center } = frameCamera(THREE, bounds, aspect)

    return {
      scene,
      camera,
      center,
      attachSpark: (renderer, autoUpdate) => {
        const view = new spark.SparkRenderer({ renderer, autoUpdate })
        scene.add(view)
        return view
      },
      dispose: () => mesh.dispose(),
    }
  } catch (error) {
    mesh.dispose()
    throw error
  }
}

const loadFramedSceneFor = async (
  modules: ThreeModules,
  src: string,
  aspect: number,
  mime: string,
): Promise<FramedScene> =>
  mime === SPLAT_PLY_MIME
    ? loadFramedSplatScene(modules, await loadSpark(), src, aspect)
    : loadFramedScene(modules, src, aspect)

/** Dispose a renderer AND lose its WebGL context so the browser context pool drains immediately. */
const disposeRenderer = (renderer: import('three').WebGLRenderer): void => {
  renderer.dispose()
  renderer.forceContextLoss()
}

/**
 * Browsers cap live WebGL contexts (typically 8-16); a thumbnail grid can
 * request dozens of posters at once, so poster renders queue through a
 * small concurrency gate and each render releases its context before the
 * next starts.
 */
const POSTER_CONCURRENCY = 2
let posterSlots = 0
const posterWaiters: Array<() => void> = []

const withPosterSlot = async <T>(work: () => Promise<T>): Promise<T> => {
  if (posterSlots >= POSTER_CONCURRENCY) {
    // The finishing render hands its slot over without decrementing, so a
    // caller arriving mid-handoff cannot sneak past the cap.
    await new Promise<void>((resolve) => posterWaiters.push(resolve))
  } else {
    posterSlots += 1
  }
  try {
    return await work()
  } finally {
    const next = posterWaiters.shift()
    if (next !== undefined) next()
    else posterSlots -= 1
  }
}

export interface Model3dPoster {
  readonly image: ImageBitmap
  readonly width: number
  readonly height: number
}

const POSTER_WIDTH = 512
const POSTER_HEIGHT = 384

/** One offscreen render of the model at `src`, framed to its bounds. */
export function renderModel3dPoster(src: string, mime: string = GLB_MIME): Promise<Model3dPoster> {
  return withPosterSlot(async () => {
    const modules = await loadThree()
    const canvas = document.createElement('canvas')
    canvas.width = POSTER_WIDTH
    canvas.height = POSTER_HEIGHT
    const renderer = new modules.THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    try {
      renderer.setSize(POSTER_WIDTH, POSTER_HEIGHT, false)
      const framed = await loadFramedSceneFor(modules, src, POSTER_WIDTH / POSTER_HEIGHT, mime)
      let sparkView: import('@sparkjsdev/spark').SparkRenderer | undefined
      try {
        if (framed.attachSpark !== undefined) {
          // Splat sorting is asynchronous; with autoUpdate off, the awaited
          // update() installs the first sorted ordering so the single render
          // below is capturable.
          sparkView = framed.attachSpark(renderer, false)
          framed.scene.updateMatrixWorld(true)
          framed.camera.updateMatrixWorld(true)
          await sparkView.update({ scene: framed.scene, camera: framed.camera })
        }
        renderer.render(framed.scene, framed.camera)
        const image = await createImageBitmap(canvas)
        return { image, width: POSTER_WIDTH, height: POSTER_HEIGHT }
      } finally {
        try {
          sparkView?.dispose()
        } finally {
          framed.dispose()
        }
      }
    } finally {
      disposeRenderer(renderer)
    }
  })
}

const POSTER_URL_CACHE_LIMIT = 64
const posterUrls = new Map<string, Promise<string>>()

/**
 * Poster render as an object URL, cached per source URL. Thumbnail grids
 * re-request entries on every scroll; the cache keeps one render (and one
 * object URL) per asset, evicting and revoking the least recent beyond the
 * bound.
 */
export function renderModel3dPosterUrl(src: string, mime: string = GLB_MIME): Promise<string> {
  const cached = posterUrls.get(src)
  if (cached !== undefined) {
    // Refresh recency so scroll churn evicts the least recently used entry.
    posterUrls.delete(src)
    posterUrls.set(src, cached)
    return cached
  }
  const pending = (async () => {
    const poster = await renderModel3dPoster(src, mime)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = poster.width
      canvas.height = poster.height
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('2d canvas unavailable for poster encode')
      ctx.drawImage(poster.image, 0, 0)
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => (value === null ? reject(new Error('poster encode failed')) : resolve(value)), 'image/png')
      })
      return URL.createObjectURL(blob)
    } finally {
      poster.image.close()
    }
  })()
  posterUrls.set(src, pending)
  // Only clear our own failed entry; an evicted stale promise must not
  // delete a newer entry for the same source.
  pending.catch(() => {
    if (posterUrls.get(src) === pending) posterUrls.delete(src)
  })
  for (const [key, value] of posterUrls) {
    if (posterUrls.size <= POSTER_URL_CACHE_LIMIT) break
    posterUrls.delete(key)
    value.then((url) => URL.revokeObjectURL(url), () => {})
  }
  return pending
}

export interface Model3dViewerHandle {
  dispose(): void
}

/**
 * Mount an interactive orbit viewport for the model at `src` into
 * `container`. The scene loads before any WebGL context exists, so a slow
 * or hung fetch never pins a context, and all renderer setup shares one
 * exception-safe cleanup path.
 */
export async function mountModel3dViewer(
  container: HTMLElement,
  src: string,
  mime: string = GLB_MIME,
): Promise<Model3dViewerHandle> {
  const modules = await loadThree()
  const framed = await loadFramedSceneFor(
    modules,
    src,
    Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
    mime,
  )

  let renderer: import('three').WebGLRenderer | undefined
  let sparkView: import('@sparkjsdev/spark').SparkRenderer | undefined
  let controls: InstanceType<ThreeModules['OrbitControls']> | undefined
  let resize: ResizeObserver | undefined
  let disposed = false
  let frame = 0
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(frame)
    resize?.disconnect()
    controls?.dispose()
    try {
      try {
        sparkView?.dispose()
      } finally {
        framed.dispose()
      }
    } finally {
      if (renderer !== undefined) {
        disposeRenderer(renderer)
        renderer.domElement.remove()
      }
    }
  }

  try {
    const gl = new modules.THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer = gl
    gl.setPixelRatio(window.devicePixelRatio)
    gl.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1))
    gl.domElement.style.display = 'block'
    container.appendChild(gl.domElement)
    // The continuous render loop below lets spark drive its own async sort
    // updates (autoUpdate on).
    if (framed.attachSpark !== undefined) sparkView = framed.attachSpark(gl, true)

    const orbit = new modules.OrbitControls(framed.camera, gl.domElement)
    controls = orbit
    orbit.target.copy(framed.center)
    orbit.enableDamping = true
    orbit.update()

    const renderLoop = (): void => {
      if (disposed) return
      orbit.update()
      gl.render(framed.scene, framed.camera)
      frame = requestAnimationFrame(renderLoop)
    }
    frame = requestAnimationFrame(renderLoop)

    resize = new ResizeObserver(() => {
      const width = Math.max(container.clientWidth, 1)
      const height = Math.max(container.clientHeight, 1)
      gl.setSize(width, height)
      framed.camera.aspect = width / height
      framed.camera.updateProjectionMatrix()
    })
    resize.observe(container)
  } catch (error) {
    dispose()
    throw error
  }

  return { dispose }
}

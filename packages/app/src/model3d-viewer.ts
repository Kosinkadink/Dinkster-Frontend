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
 *   DOM container. Editors can read and restore authored camera and model
 *   state and capture images before committing them to the document.
 */
import { GLB_MIME, SPLAT_PLY_MIME } from './model3d-mime.js'
import type { Model3dCameraState, Model3dTransform } from '@dinkster/canvas'
export type { Model3dCameraState, Model3dTransform } from '@dinkster/canvas'

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

type SparkModules = typeof import('@sparkjsdev/spark')

let sparkModules: Promise<SparkModules> | undefined

const loadSpark = (): Promise<SparkModules> => {
  sparkModules ??= import('@sparkjsdev/spark')
  return sparkModules
}

interface FramedScene {
  readonly scene: import('three').Scene
  readonly model: import('three').Object3D
  readonly animations?: readonly import('three').AnimationClip[]
  readonly animationRoot?: import('three').Object3D
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
  beginNormalPass?(): () => void
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

const cameraForState = (THREE: ThreeModules['THREE'], perspective: import('three').PerspectiveCamera, state: Model3dCameraState) => {
  const bounds = state.frustum ?? { left: -10, right: 10, top: 10, bottom: -10 }
  const camera = state.cameraType === 'orthographic'
    ? new THREE.OrthographicCamera(bounds.left, bounds.right, bounds.top, bounds.bottom, state.near ?? perspective.near, state.far ?? perspective.far)
    : perspective
  if (camera instanceof THREE.PerspectiveCamera) camera.fov = state.fov ?? camera.fov
  camera.near = state.near ?? camera.near
  camera.far = state.far ?? camera.far
  camera.position.copy(state.position)
  camera.zoom = state.zoom
  const customUp = state.customUp ?? (state.useCustomUp && state.quaternion
    ? new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion().copy(state.quaternion).normalize()) : undefined)
  const useCustomUp = state.useCustomUp === true && customUp !== undefined
  camera.up.copy(useCustomUp ? customUp! : { x: 0, y: 1, z: 0 })
  camera.lookAt(new THREE.Vector3().copy(state.target))
  return { camera, customUp, useCustomUp }
}

const fitCameraAspect = (THREE: ThreeModules['THREE'], camera: import('three').PerspectiveCamera | import('three').OrthographicCamera, aspect: number): void => {
  if (camera instanceof THREE.PerspectiveCamera) camera.aspect = aspect
  else {
    const center = (camera.left + camera.right) / 2
    const halfWidth = (camera.top - camera.bottom) * aspect / 2
    camera.left = center - halfWidth
    camera.right = center + halfWidth
  }
  camera.updateProjectionMatrix()
}

export interface Model3dLoadOptions {
  readonly resources?: Readonly<Record<string, string>>
  readonly format?: string
  readonly pointCloud?: boolean
  readonly camera?: Model3dCameraState
  readonly transform?: Model3dTransform
}

/** Load a mesh or point cloud and frame its bounds in a lit scene. */
const loadFramedScene = async (modules: ThreeModules, src: string, aspect: number, options: Model3dLoadOptions): Promise<FramedScene> => {
  const { THREE } = modules
  const { resources, format = 'glb' } = options
  const manager = new THREE.LoadingManager()
  let resourceError: Error | undefined
  let resourcesReady = Promise.resolve()
  let resourcesLoaded = (): void => {}
  manager.onStart = () => { resourcesReady = new Promise((resolve) => { resourcesLoaded = resolve }) }
  manager.onLoad = () => resourcesLoaded()
  manager.onError = (url) => { resourceError = new Error(`3D resource failed to load: ${url}`) }
  if (resources !== undefined) manager.setURLModifier((url) => {
    if (url === src || url.startsWith('data:') || Object.values(resources).includes(url)) return url
    const key = decodeURIComponent(new URL(url, 'https://viewport.invalid/').pathname.slice(1))
    const granted = Object.hasOwn(resources, key) ? resources[key] : undefined
    if (!granted || new URL(url, 'https://viewport.invalid/').origin !== 'https://viewport.invalid') {
      resourceError = new Error(`3D resource is not granted: ${url}`)
      throw resourceError
    }
    return granted
  })
  let model: import('three').Object3D
  let animations: readonly import('three').AnimationClip[] = []
  if (format === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js')
    const loader = new OBJLoader(manager)
    const text = await new THREE.FileLoader(manager).loadAsync(src)
    const libraries = [...String(text).matchAll(/^mtllib\s+(.+)$/gm)].map((match) => match[1]!.trim())
    const library = libraries.find((name) => resources?.[name] !== undefined)
    if (library) {
      const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js')
      const materialText = await new THREE.FileLoader(manager).loadAsync(resources![library]!)
      loader.setMaterials(new MTLLoader(manager).parse(String(materialText), new URL('.', `https://viewport.invalid/${library}`).href))
    }
    model = loader.parse(String(text))
  } else if (format === 'fbx') {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
    const loader = new FBXLoader(manager)
    loader.setResourcePath('https://viewport.invalid/')
    model = await loader.loadAsync(src)
    animations = model.animations
  } else if (format === 'usdz') {
    const { USDLoader } = await import('three/examples/jsm/loaders/USDLoader.js')
    model = await new USDLoader(manager).loadAsync(src)
  } else if (format === 'stl' || format === 'ply') {
    const geometry = format === 'stl'
      ? await new (await import('three/examples/jsm/loaders/STLLoader.js')).STLLoader(manager).loadAsync(src)
      : await new (await import('three/examples/jsm/loaders/PLYLoader.js')).PLYLoader(manager).loadAsync(src)
    geometry.computeVertexNormals()
    const colors = geometry.hasAttribute('color')
    model = format === 'ply' && (options.pointCloud || !geometry.index?.count)
      ? new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.005, vertexColors: colors, color: colors ? 0xffffff : 0xcccccc }))
      : new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: colors, color: colors ? 0xffffff : 0x808080, side: THREE.DoubleSide, roughness: 0.8, metalness: 0.1 }))
  } else if (format === 'glb' || format === 'gltf') {
    const loader = new modules.GLTFLoader(manager)
    if (resources !== undefined) loader.setResourcePath('https://viewport.invalid/')
    loader.register((parser) => {
      const loadImageSource = parser.loadImageSource.bind(parser)
      parser.loadImageSource = (index, imageLoader) => {
        if (parser.json.images[index].bufferView === undefined) return loadImageSource(index, imageLoader)
        // GLTFLoader creates these URLs from already-authorized buffer views,
        // not authored URIs. Keep their authority local to this image load.
        const embeddedManager = new THREE.LoadingManager()
        embeddedManager.onError = (url) => {
          URL.revokeObjectURL(url)
          resourceError = new Error('Embedded 3D texture failed to load')
        }
        const embeddedLoader = Object.create(imageLoader) as typeof imageLoader
        embeddedLoader.manager = embeddedManager
        return loadImageSource(index, embeddedLoader)
      }
      return { name: 'embedded-image-authority' }
    })
    const gltf = await loader.loadAsync(src)
    model = gltf.scene
    animations = gltf.animations
  } else throw new Error(`Unsupported 3D format: ${format}`)
  await resourcesReady
  const scene = new THREE.Scene()
  const transformRoot = new THREE.Group()
  transformRoot.add(model)
  scene.add(transformRoot)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.4))
  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(1, 1.5, 1.2)
  scene.add(key)

  const bounds = new THREE.Box3().setFromObject(model)
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
  if (resourceError) { dispose(); throw resourceError }
  return { scene, model: transformRoot, animations, animationRoot: model, camera, center, dispose }
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
  format = 'ply',
): Promise<FramedScene> => {
  const { THREE } = modules
  const response = await fetch(src)
  if (!response.ok) throw new Error(`splat fetch failed: ${response.status}`)
  const bytes = await response.arrayBuffer()
  const mesh = new spark.SplatMesh({ fileBytes: bytes, fileName: `model.${format}` })
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
      model: mesh,
      camera,
      center,
      attachSpark: (renderer, autoUpdate) => {
        const view = new spark.SparkRenderer({ renderer, autoUpdate })
        scene.add(view)
        return view
      },
      beginNormalPass: () => {
        const previousModifiers = mesh.worldModifiers
        const previousWorldToView = mesh.enableWorldToView
        const { dyno } = spark
        const identity = new spark.SplatTransformer()
        identity.updateFromMatrix(new THREE.Matrix4())
        const colorNormal = spark.modifiers.makeNormalColorModifier(identity)
        mesh.enableWorldToView = true
        mesh.worldModifiers = [...previousModifiers ?? [], dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
          if (!gsplat) throw new Error('Normal capture requires a splat')
          const viewSplat = mesh.context.worldToView.applyGsplat(gsplat)
          const colored = colorNormal.apply({ gsplat: viewSplat }).gsplat!
          return { gsplat: dyno.combineGsplat({ gsplat, rgb: dyno.splitGsplat(colored).outputs.rgb }) }
        })]
        mesh.updateGenerator()
        return () => {
          if (previousModifiers === undefined) delete mesh.worldModifiers
          else mesh.worldModifiers = previousModifiers
          mesh.enableWorldToView = previousWorldToView
          mesh.updateGenerator()
        }
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
  options: Model3dLoadOptions = {},
): Promise<FramedScene> =>
  !options.pointCloud && (mime === SPLAT_PLY_MIME || ['splat', 'spz', 'ksplat'].includes(options.format ?? ''))
    ? loadFramedSplatScene(modules, await loadSpark(), src, aspect, options.format)
    : loadFramedScene(modules, src, aspect, options)

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
export function renderModel3dPoster(src: string, mime: string = GLB_MIME, options: Model3dLoadOptions = {}): Promise<Model3dPoster> {
  return withPosterSlot(async () => {
    const modules = await loadThree()
    const canvas = document.createElement('canvas')
    canvas.width = POSTER_WIDTH
    canvas.height = POSTER_HEIGHT
    const renderer = new modules.THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    try {
      renderer.setSize(POSTER_WIDTH, POSTER_HEIGHT, false)
      const framed = await loadFramedSceneFor(modules, src, POSTER_WIDTH / POSTER_HEIGHT, mime, options)
      let sparkView: import('@sparkjsdev/spark').SparkRenderer | undefined
      try {
        if (options.transform !== undefined) {
          framed.model.position.copy(options.transform.position)
          framed.model.quaternion.copy(options.transform.quaternion).normalize()
          framed.model.scale.copy(options.transform.scale)
          framed.model.updateMatrixWorld(true)
        }
        const camera = options.camera === undefined ? framed.camera : cameraForState(modules.THREE, framed.camera, options.camera).camera
        fitCameraAspect(modules.THREE, camera, POSTER_WIDTH / POSTER_HEIGHT)
        if (framed.attachSpark !== undefined) {
          // Splat sorting is asynchronous; with autoUpdate off, the awaited
          // update() installs the first sorted ordering so the single render
          // below is capturable.
          sparkView = framed.attachSpark(renderer, false)
          framed.scene.updateMatrixWorld(true)
          camera.updateMatrixWorld(true)
          await sparkView.update({ scene: framed.scene, camera })
        }
        renderer.render(framed.scene, camera)
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
  cameraState(): Model3dCameraState
  setCameraState(state: Model3dCameraState): void
  modelTransform(): Model3dTransform
  setModelTransform(state: Model3dTransform): void
  animationClips(): readonly { name: string; duration: number }[]
  animationTime(): number
  setAnimation(index: number, time: number, playing: boolean, speed: number): void
  recordingStream(width: number, height: number): { stream: MediaStream; stop(): void }
  capture(width: number, height: number): Promise<{ image: Blob; mask: Blob; normal: Blob }>
}

type Vector3State = { x: number; y: number; z: number }

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
  options: Model3dLoadOptions = {},
): Promise<Model3dViewerHandle> {
  const modules = await loadThree()
  const framed = await loadFramedSceneFor(
    modules,
    src,
    Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
    mime,
    options,
  )

  let renderer: import('three').WebGLRenderer | undefined
  let sparkView: import('@sparkjsdev/spark').SparkRenderer | undefined
  let controls: InstanceType<ThreeModules['OrbitControls']> | undefined
  let resize: ResizeObserver | undefined
  let disposed = false
  let capturing = false
  let recording: { stop(): void } | undefined
  let frame = 0
  const clips = framed.animations ?? []
  const mixer = clips.length ? new modules.THREE.AnimationMixer(framed.animationRoot ?? framed.model) : undefined
  let animation: import('three').AnimationAction | undefined
  let playing = false
  let animationSpeed = 1
  let lastFrame = performance.now()
  let customUp: Vector3State | undefined
  let useCustomUp = false
  let cancelCapture: ((reason: Error) => void) | undefined
  let activeCamera: import('three').PerspectiveCamera | import('three').OrthographicCamera = framed.camera
  const updateProjection = (width: number, height: number): void => {
    fitCameraAspect(modules.THREE, activeCamera, width / height)
  }
  const setOutputSize = (width: number, height: number): void => {
    renderer!.setPixelRatio(1)
    renderer!.setSize(width, height, false)
    updateProjection(width, height)
  }
  const updateSplats = async (): Promise<void> => {
    if (!sparkView) return
    // update() can return while an older worker sort or delayed sort is pending.
    // Drain those updates before requesting the capture camera's own ordering.
    clearTimeout(sparkView.updateTimeoutId)
    sparkView.updateTimeoutId = -1
    const settle = async (): Promise<void> => {
      while (sparkView!.sorting || sparkView!.sortDirty) {
        if (disposed) throw new Error('3D viewport was closed during capture')
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
      if (disposed) throw new Error('3D viewport was closed during capture')
    }
    const update = async (): Promise<void> => {
      await settle()
      if (disposed) throw new Error('3D viewport was closed during capture')
      framed.scene.updateMatrixWorld(true)
      activeCamera.updateMatrixWorld(true)
      await sparkView!.update({ scene: framed.scene, camera: activeCamera })
      await settle()
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const cancellation = new Promise<never>((_resolve, reject) => {
      cancelCapture = reject
      timeout = setTimeout(() => {
        reject(new Error('3D splat sorting did not finish'))
        // A timed-out worker must not resume against a reusable GL context.
        dispose()
      }, 30_000)
    })
    try { await Promise.race([update(), cancellation]) }
    finally { clearTimeout(timeout); cancelCapture = undefined }
  }
  const dispose = (): void => {
    if (disposed) return
    recording?.stop()
    disposed = true
    cancelCapture?.(new Error('3D viewport was closed during capture'))
    cancelAnimationFrame(frame)
    resize?.disconnect()
    controls?.dispose()
    mixer?.stopAllAction()
    mixer?.uncacheRoot(framed.animationRoot ?? framed.model)
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
      const now = performance.now()
      if (!capturing) {
        if (playing) mixer?.update((now - lastFrame) / 1000 * animationSpeed)
        controls!.update()
        gl.render(framed.scene, activeCamera)
      }
      lastFrame = now
      frame = requestAnimationFrame(renderLoop)
    }
    frame = requestAnimationFrame(renderLoop)

    resize = new ResizeObserver(() => {
      if (capturing || recording || disposed) return
      const width = Math.max(container.clientWidth, 1)
      const height = Math.max(container.clientHeight, 1)
      gl.setSize(width, height)
      updateProjection(width, height)
    })
    resize.observe(container)
  } catch (error) {
    dispose()
    throw error
  }

  const vector = (value: Vector3State): Vector3State => ({ x: value.x, y: value.y, z: value.z })
  const handle: Model3dViewerHandle = {
    dispose,
    cameraState: () => ({
      position: vector(activeCamera.position), target: vector(controls!.target),
      zoom: activeCamera.zoom,
      cameraType: activeCamera instanceof modules.THREE.PerspectiveCamera ? 'perspective' : 'orthographic',
      quaternion: { ...vector(activeCamera.quaternion), w: activeCamera.quaternion.w },
      ...(customUp ? { customUp: vector(customUp), useCustomUp } : {}),
      fov: framed.camera.fov, aspect: framed.camera.aspect, near: activeCamera.near, far: activeCamera.far,
      ...(activeCamera instanceof modules.THREE.OrthographicCamera ? {
        frustum: { left: activeCamera.left, right: activeCamera.right, top: activeCamera.top, bottom: activeCamera.bottom },
      } : {}),
    }),
    setCameraState(state) {
      if (disposed || capturing) return
      if (recording && state.cameraType !== (activeCamera instanceof modules.THREE.PerspectiveCamera ? 'perspective' : 'orthographic')) return
      const restored = cameraForState(modules.THREE, framed.camera, state)
      activeCamera = restored.camera
      customUp = restored.customUp ? vector(restored.customUp) : undefined
      useCustomUp = restored.useCustomUp
      // OrbitControls caches the camera-up basis when it is constructed.
      controls!.dispose()
      controls = new modules.OrbitControls(activeCamera, renderer!.domElement)
      controls.enableDamping = true
      controls!.target.copy(state.target)
      activeCamera.lookAt(controls!.target)
      const size = renderer!.getSize(new modules.THREE.Vector2())
      updateProjection(size.x, size.y)
      controls!.update()
    },
    modelTransform: () => ({ position: vector(framed.model.position),
      quaternion: { ...vector(framed.model.quaternion), w: framed.model.quaternion.w }, scale: vector(framed.model.scale) }),
    setModelTransform(state) {
      if (disposed || capturing) return
      framed.model.position.copy(state.position)
      framed.model.quaternion.copy(state.quaternion).normalize()
      framed.model.scale.copy(state.scale)
      framed.model.updateMatrixWorld(true)
    },
    animationClips: () => clips.map((clip) => ({ name: clip.name, duration: clip.duration })),
    animationTime: () => animation?.time ?? 0,
    setAnimation(index, time, play, speed) {
      if (disposed || capturing || !mixer || !clips[index] || !Number.isFinite(time) || !Number.isFinite(speed)) return
      animation?.stop()
      animation = mixer.clipAction(clips[index])
      animation.reset().play()
      animation.time = Math.max(0, Math.min(time, clips[index].duration))
      mixer.update(0)
      playing = play
      animationSpeed = speed
      lastFrame = performance.now()
    },
    recordingStream(width, height) {
      if (disposed || capturing || recording) throw new Error('3D viewport is unavailable for recording')
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
        throw new Error('Recording dimensions must be integers from 1 to 4096')
      }
      const gl = renderer!
      const previousRatio = gl.getPixelRatio()
      const previousFrustum = activeCamera instanceof modules.THREE.OrthographicCamera
        ? { left: activeCamera.left, right: activeCamera.right, top: activeCamera.top, bottom: activeCamera.bottom }
        : undefined
      let stream: MediaStream | undefined
      let stopped = false
      const session = {
        stop() {
          if (stopped) return
          stopped = true
          stream?.getTracks().forEach((track) => track.stop())
          recording = undefined
          if (disposed) return
          gl.setPixelRatio(previousRatio)
          const width = Math.max(container.clientWidth, 1)
          const height = Math.max(container.clientHeight, 1)
          gl.setSize(width, height, false)
          if (previousFrustum && activeCamera instanceof modules.THREE.OrthographicCamera) Object.assign(activeCamera, previousFrustum)
          updateProjection(width, height)
        },
      }
      recording = session
      try {
        setOutputSize(width, height)
        stream = gl.domElement.captureStream(30)
        gl.render(framed.scene, activeCamera)
        return { stream, stop: session.stop }
      } catch (error) { session.stop(); throw error }
    },
    async capture(width, height) {
      if (disposed || capturing || recording) throw new Error('3D viewport is unavailable for capture')
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
        throw new Error('Capture dimensions must be integers from 1 to 4096')
      }
      const gl = renderer!
      const previousRatio = gl.getPixelRatio()
      const previousAspect = framed.camera.aspect
      const previousMaterial = framed.scene.overrideMaterial
      const previousBackground = framed.scene.background
      const previousColor = gl.getClearColor(new modules.THREE.Color())
      const previousAlpha = gl.getClearAlpha()
      const previousOrbitEnabled = controls!.enabled
      const previousSparkAutoUpdate = sparkView?.autoUpdate
      let endNormalPass: (() => void) | undefined
      const previousFrustum = activeCamera instanceof modules.THREE.OrthographicCamera
        ? { left: activeCamera.left, right: activeCamera.right, top: activeCamera.top, bottom: activeCamera.bottom }
        : undefined
      const normalMaterial = new modules.THREE.MeshNormalMaterial({ side: modules.THREE.DoubleSide })
      const encode = async (): Promise<Blob> => {
        if (disposed) throw new Error('3D viewport was closed during capture')
        gl.render(framed.scene, activeCamera)
        return new Promise((resolve, reject) => gl.domElement.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('3D capture encoding failed')), 'image/png'))
      }
      capturing = true
      controls!.enabled = false
      if (sparkView) sparkView.autoUpdate = false
      try {
        setOutputSize(width, height)
        await updateSplats()
        const image = await encode()
        // LoadImage returns 1-alpha as MASK. Keep transparent background,
        // including the original materials' transparency and alpha maps.
        framed.scene.background = null
        gl.setClearColor(0x000000, 0)
        const mask = await encode()
        framed.scene.overrideMaterial = normalMaterial
        gl.setClearColor(0x000000, 1)
        endNormalPass = framed.beginNormalPass?.()
        if (endNormalPass) await updateSplats()
        const normal = await encode()
        return { image, mask, normal }
      } finally {
        endNormalPass?.()
        framed.scene.overrideMaterial = previousMaterial
        framed.scene.background = previousBackground
        framed.camera.aspect = previousAspect
        if (previousFrustum && activeCamera instanceof modules.THREE.OrthographicCamera) Object.assign(activeCamera, previousFrustum)
        activeCamera.updateProjectionMatrix()
        if (!disposed) {
          gl.setClearColor(previousColor, previousAlpha)
          gl.setPixelRatio(previousRatio)
          const width = Math.max(container.clientWidth, 1)
          const height = Math.max(container.clientHeight, 1)
          gl.setSize(width, height, false)
          updateProjection(width, height)
          controls!.enabled = previousOrbitEnabled
          if (sparkView && previousSparkAutoUpdate !== undefined) sparkView.autoUpdate = previousSparkAutoUpdate
        }
        normalMaterial.dispose()
        capturing = false
      }
    },
  }
  try {
    if (options.transform !== undefined) handle.setModelTransform(options.transform)
    if (options.camera !== undefined) handle.setCameraState(options.camera)
    return handle
  } catch (error) { dispose(); throw error }
}

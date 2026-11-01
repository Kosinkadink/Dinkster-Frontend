import { isAssetRefValue, type Json } from '@dinkster/core'
import type { Model3dCameraState, Model3dLoadOptions, Model3dTransform } from './model3d-viewer.js'

export const isFile3dType = (type: string): boolean => [
  'FILE_3D', 'FILE_3D_GLB', 'FILE_3D_GLTF', 'FILE_3D_FBX', 'FILE_3D_OBJ',
  'FILE_3D_STL', 'FILE_3D_USDZ', 'FILE_3D_PLY', 'FILE_3D_SPLAT', 'FILE_3D_SPZ',
  'FILE_3D_KSPLAT', 'FILE_3D_SPLAT_ANY', 'FILE_3D_POINT_CLOUD_ANY',
].includes(type)

export const file3dObject = (value: unknown): Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, Json> : {}

/** Validate browser-facing metadata without changing the original value. */
export function file3dViewOptions(camera: unknown, models: unknown): Pick<Model3dLoadOptions, 'camera' | 'transform'> {
  const vector = (value: unknown, axes: readonly string[] = ['x', 'y', 'z']): boolean => {
    const fields = file3dObject(value)
    return axes.every((axis) => typeof fields[axis] === 'number' && Number.isFinite(fields[axis]))
  }
  if (camera != null) {
    const state = file3dObject(camera)
    if (!vector(state.position) || !vector(state.target) || typeof state.zoom !== 'number' || !Number.isFinite(state.zoom) || state.zoom <= 0
      || !['perspective', 'orthographic'].includes(String(state.cameraType))
      || (state.quaternion !== undefined && !vector(state.quaternion, ['x', 'y', 'z', 'w']))
      || (state.customUp !== undefined && !vector(state.customUp))
      || ['fov', 'aspect', 'near', 'far'].some((key) => state[key] !== undefined && (typeof state[key] !== 'number' || !Number.isFinite(state[key])))
      || (state.frustum !== undefined && !vector(state.frustum, ['left', 'right', 'top', 'bottom']))) throw new Error('3D preview camera is unavailable')
  }
  if (models != null && (!Array.isArray(models) || models.some((value: unknown) => {
    const model = file3dObject(value)
    return !vector(model.position) || !vector(model.quaternion, ['x', 'y', 'z', 'w']) || !vector(model.scale)
  }))) throw new Error('3D preview model placement is unavailable')
  return { ...(camera == null ? {} : { camera: camera as Model3dCameraState }),
    ...(Array.isArray(models) && models[0] !== undefined ? { transform: models[0] as Model3dTransform } : {}) }
}

export const validFile3dAsset = (value: unknown): boolean => {
  const asset = file3dObject(value)
  const valid = asset.verification === 'unverified'
    ? !('digest' in asset) && typeof asset.localBinding === 'string' && asset.localBinding.length > 0
      && typeof asset.name === 'string' && typeof asset.mediaType === 'string' && typeof asset.virtualPath === 'string'
      && typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size >= 0
    : isAssetRefValue(value)
  return valid && Object.keys(asset).every((key) =>
    ['digest', 'name', 'size', 'mediaType', 'virtualPath', 'verification', 'localBinding'].includes(key))
}

export const file3dFormatFromBytes = (bytes: Uint8Array): string | undefined => {
  const head = new TextDecoder().decode(bytes.subarray(0, 512))
  if (head.startsWith('glTF')) return 'glb'
  if (head.startsWith('ply')) return 'ply'
  if (/^solid\b/i.test(head.trimStart())) return 'stl'
  if (head.startsWith('Kaydara FBX Binary') || /^;\s*FBX\s/m.test(head)) return 'fbx'
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) return 'usdz'
  if (bytes.length >= 84 && 84 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true) * 50 === bytes.length) return 'stl'
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'spz'
  if (bytes[0] === 0 && (bytes[1] ?? 0) >= 1) return 'ksplat'
  const text = new TextDecoder().decode(bytes)
  if (text.trimStart().startsWith('{')) return 'gltf'
  if (/^v[ \t]+[+-]?(?:\d|\.)/m.test(text)) return 'obj'
  if (bytes.length > 0 && bytes.length % 32 === 0) return 'splat'
  return undefined
}

/** Original bytes and explicitly granted sidecars, owned until release. */
export async function loadFile3dPreview(
  manifest: unknown,
  read: (ref: Readonly<Record<string, Json>>) => Promise<ArrayBuffer | undefined>,
  options: { readonly pointCloud?: boolean; readonly signal?: AbortSignal } = {},
): Promise<{ readonly src: string; readonly name: string; readonly mime: string; readonly options: Model3dLoadOptions; release(): void }> {
  const file = file3dObject(manifest)
  const refs = Object.entries(file3dObject(file.resources))
  if (typeof file.format !== 'string' || !/^[a-z0-9]*$/.test(file.format)
    || Object.keys(file).some((key) => !['format', 'source', 'resources'].includes(key))
    || !validFile3dAsset(file.source) || refs.some(([, ref]) => !validFile3dAsset(ref))
    || (file.resources !== undefined && (file.resources === null || typeof file.resources !== 'object' || Array.isArray(file.resources)))
    || refs.some(([name]) => !name || name.split('/').some((part) => !part || part === '.' || part === '..') || /[\\:%?#\u0000]/.test(name))) {
    throw new Error('3D preview manifest is unavailable')
  }
  const urls: string[] = []
  const release = (): void => { urls.splice(0).forEach((url) => URL.revokeObjectURL(url)) }
  try {
    const asset = async (ref: Readonly<Record<string, Json>>) => {
      options.signal?.throwIfAborted()
      const bytes = await read(ref)
      options.signal?.throwIfAborted()
      if (!bytes) throw new Error('3D preview resource is unavailable')
      const url = URL.createObjectURL(new Blob([bytes], { type: String(ref.mediaType ?? 'application/octet-stream') }))
      urls.push(url)
      return { url, bytes: new Uint8Array(bytes) }
    }
    const source = file3dObject(file.source)
    const primary = await asset(source)
    const format = file.format || file3dFormatFromBytes(primary.bytes)
    if (!format) throw new Error('3D preview format is unavailable')
    const resources: Record<string, string> = Object.create(null)
    for (const [name, ref] of refs) resources[name] = (await asset(file3dObject(ref))).url
    const lines: string[] = []
    if (format === 'ply') {
      const decoder = new TextDecoder()
      for (let start = 0; start < primary.bytes.length;) {
        const end = primary.bytes.indexOf(10, start)
        if (end < 0) break
        const line = decoder.decode(primary.bytes.subarray(start, end))
        if (line.trim() === 'end_header') break
        lines.push(line)
        start = end + 1
      }
    }
    const header = lines.join('\n')
    const gaussian = /^property\s+float\s+f_dc_0\s*$/m.test(header)
      && /^property\s+float\s+scale_0\s*$/m.test(header) && /^property\s+float\s+rot_0\s*$/m.test(header)
    const mime = format === 'gltf' ? 'model/gltf+json' : format === 'ply' ? gaussian ? 'model/ply' : 'application/octet-stream'
      : file.format === '' ? 'application/octet-stream' : String(source.mediaType ?? 'model/gltf-binary')
    return { src: primary.url, name: String(source.name), mime, options: { resources, format, ...(options.pointCloud === undefined ? {} : { pointCloud: options.pointCloud }) }, release }
  } catch (error) {
    release()
    throw error
  }
}

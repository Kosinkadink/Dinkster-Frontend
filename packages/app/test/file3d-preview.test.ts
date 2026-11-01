import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadFile3dPreview } from '../src/file3d-preview.js'

const stored = { digest: `blake3:${'a'.repeat(64)}`, name: 'scene.gltf', size: 12, mediaType: 'model/gltf+json', virtualPath: 'scene.gltf' }
const local = { verification: 'unverified', localBinding: 'granted-buffer', name: 'mesh.bin', size: 36,
  mediaType: 'application/octet-stream', virtualPath: 'geometry/mesh.bin' }
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer

afterEach(() => vi.restoreAllMocks())

describe('original FILE_3D preview resources', () => {
  it('loads mixed granted sources and named sidecars without changing bytes, and releases every URL', async () => {
    const source = bytes('{"asset":{"version":"2.0"}}')
    const sidecar = new Uint8Array([4, 9, 127, 255]).buffer
    const manifest = { format: 'gltf', source: stored, resources: { 'geometry/mesh.bin': local } }
    const snapshot = JSON.stringify(manifest)
    const model = await loadFile3dPreview(manifest, async (ref) => ref.digest ? source : sidecar)
    expect(model.mime).toBe('model/gltf+json')
    expect(model.options.format).toBe('gltf')
    expect(await (await fetch(model.src)).text()).toBe('{"asset":{"version":"2.0"}}')
    const url = model.options.resources!['geometry/mesh.bin']!
    expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(new Uint8Array([4, 9, 127, 255]))
    expect(JSON.stringify(manifest)).toBe(snapshot)
    model.release()
    model.release()
    await expect(fetch(model.src)).rejects.toThrow()
    await expect(fetch(url)).rejects.toThrow()
  })

  it.each(['../mesh.bin', '/mesh.bin', 'geometry/../mesh.bin', 'https://host/mesh.bin', 'mesh%2fbin', 'mesh?x', 'mesh\\bin', 'geometry//mesh.bin'])(
    'refuses an unauthorized resource name %s before reading bytes', async (name) => {
      const read = vi.fn(async () => bytes('unused'))
      await expect(loadFile3dPreview({ format: 'gltf', source: stored, resources: { [name]: local } }, read)).rejects.toThrow()
      expect(read).not.toHaveBeenCalled()
    },
  )

  it.each([null, { ...local, digest: stored.digest }, { ...local, localBinding: '' }])('refuses null or hybrid source authority', async (source) => {
    await expect(loadFile3dPreview({ format: 'gltf', source }, async () => bytes('unused'))).rejects.toThrow()
  })

  it('releases the primary when a sidecar disappears and when cancellation arrives during a read', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    await expect(loadFile3dPreview({ format: 'gltf', source: stored, resources: { 'mesh.bin': local } },
      async (ref) => ref.digest ? bytes('{}') : undefined)).rejects.toThrow('unavailable')
    expect(revoke).toHaveBeenCalledTimes(1)
    const controller = new AbortController()
    await expect(loadFile3dPreview({ format: 'gltf', source: stored }, async () => {
      controller.abort()
      return bytes('{}')
    }, { signal: controller.signal })).rejects.toThrow()
    expect(revoke).toHaveBeenCalledTimes(1)
  })

  it.each(['glb', 'gltf', 'obj', 'fbx', 'stl', 'usdz', 'ply', 'splat', 'spz', 'ksplat'])(
    'preserves the declared %s format and original bytes for the existing viewer', async (format) => {
      const original = new Uint8Array([12, 35, 92, 201]).buffer
      const model = await loadFile3dPreview({ format, source: stored }, async () => original)
      expect(model.options.format).toBe(format)
      expect(new Uint8Array(await (await fetch(model.src)).arrayBuffer())).toEqual(new Uint8Array(original))
      model.release()
    },
  )

  it('detects generic OBJ beyond long comments and distinguishes point clouds from gaussian PLY', async () => {
    const obj = await loadFile3dPreview({ format: '', source: stored }, async () => bytes('# comment\n'.repeat(100) + 'v 1 2 3\n'))
    expect(obj.options.format).toBe('obj')
    obj.release()
    const cloud = await loadFile3dPreview({ format: '', source: stored }, async () => bytes('ply\nformat ascii 1.0\nproperty float x\nend_header\n'), { pointCloud: true })
    expect(cloud.mime).toBe('application/octet-stream')
    expect(cloud.options.pointCloud).toBe(true)
    cloud.release()
    const gaussian = await loadFile3dPreview({ format: '', source: stored }, async () => bytes('ply\nproperty float f_dc_0\nproperty float scale_0\nproperty float rot_0\nend_header\n'))
    expect(gaussian.mime).toBe('model/ply')
    gaussian.release()
  })
})

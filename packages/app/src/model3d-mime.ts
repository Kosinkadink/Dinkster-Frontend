/**
 * MIME types the model3d preview pipeline renders. GLB scenes load through
 * three.js GLTFLoader; binary gaussian-splat PLY loads through
 * @sparkjsdev/spark. This module has no heavy imports so gating code can
 * use it without pulling the lazy viewer chunk.
 */
export const GLB_MIME = 'model/gltf-binary'
export const SPLAT_PLY_MIME = 'model/ply'

export type Model3dMime = typeof GLB_MIME | typeof SPLAT_PLY_MIME

export const isModel3dMime = (mime: string | undefined): mime is Model3dMime =>
  mime === GLB_MIME || mime === SPLAT_PLY_MIME

/**
 * Browsers rarely assign a MIME type to .glb or .ply files; trust a declared
 * model3d type, otherwise infer one from the file name.
 */
export const model3dMimeFor = (name: string, declaredType: string): Model3dMime | undefined => {
  if (isModel3dMime(declaredType)) return declaredType
  const lower = name.toLowerCase()
  return lower.endsWith('.glb') ? GLB_MIME : lower.endsWith('.ply') ? SPLAT_PLY_MIME : undefined
}

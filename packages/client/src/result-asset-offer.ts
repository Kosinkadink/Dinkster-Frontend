import type { ExecutionArtifact } from './execution-store.js'

/** Server-persisted roots for a parent output or one terminal artifact. */
export type ResultAssetOffer = {
  readonly token: string
  readonly scope: string
  readonly jobRef: string
  readonly attemptId: number
  readonly nodeId: string
  readonly publication: number
  readonly digests: readonly string[]
  readonly complete: boolean
} & (
  | { readonly outputId: string; readonly artifact?: never }
  | { readonly artifact: ExecutionArtifact & { readonly index: number }; readonly outputId?: never }
)

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function artifactFile(value: unknown): value is Record<string, unknown> & Omit<ExecutionArtifact, 'nodeId' | 'preview'> {
  return record(value) && typeof value['digest'] === 'string' && value['digest'].length === 71 && /^blake3:[0-9a-f]{64}$/.test(value['digest']) &&
    ['name', 'mediaType', 'virtualPath'].every((key) => typeof value[key] === 'string' && value[key].length > 0) &&
    typeof value['size'] === 'number' && Number.isSafeInteger(value['size']) && value['size'] >= 0
}

/** Missing or malformed source authority must never become an empty complete set. */
export function parseResultAssetOffer(value: unknown): ResultAssetOffer | undefined {
  if (!record(value) || typeof value['token'] !== 'string' || value['token'].length !== 32 || !/^[0-9a-f]{32}$/.test(value['token']) ||
    !['scope', 'jobRef', 'nodeId'].every((key) => typeof value[key] === 'string' && value[key].length > 0) ||
    !['attemptId', 'publication'].every((key) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 1) ||
    typeof value['complete'] !== 'boolean' || !Array.isArray(value['digests']) || value['digests'].length > 4096 ||
    !value['digests'].every((digest: unknown, index: number, digests: unknown[]) =>
      typeof digest === 'string' && digest.length === 71 && /^blake3:[0-9a-f]{64}$/.test(digest) &&
      (index === 0 || (digests[index - 1] as string) < digest))) return undefined
  const base = {
    token: value['token'], scope: value['scope'] as string, jobRef: value['jobRef'] as string,
    attemptId: value['attemptId'] as number, nodeId: value['nodeId'] as string,
    publication: value['publication'] as number, digests: [...value['digests']] as string[], complete: value['complete'],
  }
  if (typeof value['outputId'] === 'string' && value['outputId'].length > 0 && !Object.hasOwn(value, 'artifact')) {
    return { ...base, outputId: value['outputId'] }
  }
  const artifact = value['artifact']
  if (Object.hasOwn(value, 'outputId') || !artifactFile(artifact) || !record(artifact) ||
    artifact['nodeId'] !== base.nodeId || typeof artifact['index'] !== 'number' ||
    !Number.isSafeInteger(artifact['index']) || artifact['index'] < 0 ||
    Object.keys(artifact).some((key) => !['nodeId', 'digest', 'name', 'size', 'mediaType', 'virtualPath', 'index', 'preview'].includes(key))) return undefined
  const preview = artifact['preview']
  if (Object.hasOwn(artifact, 'preview') && (!artifactFile(preview) ||
    Object.keys(preview).some((key) => !['digest', 'name', 'size', 'mediaType', 'virtualPath'].includes(key)) ||
    preview.virtualPath !== `previews/${preview.digest.slice(7)}/${preview.name}`)) return undefined
  const roots = [...new Set([artifact.digest, ...(preview === undefined ? [] : [(preview as ExecutionArtifact).digest])])].sort()
  if (roots.length !== base.digests.length || roots.some((digest, index) => digest !== base.digests[index])) return undefined
  return {
    ...base,
    artifact: {
      nodeId: base.nodeId, index: artifact['index'], digest: artifact.digest, name: artifact.name,
      size: artifact.size, mediaType: artifact.mediaType, virtualPath: artifact.virtualPath,
      ...(preview === undefined ? {} : { preview: { ...(preview as NonNullable<ExecutionArtifact['preview']>) } }),
    },
  }
}

/**
 * Contract shared by the starter execution harness
 * (tests/starter-execution-live.spec.ts) and its non-live validation tests
 * (test/starter-execution-support.test.ts): the authoritative starter family
 * matrix and the DINKSTER_STARTER_OVERRIDES file contract. Kept free of
 * Playwright imports so the non-live tests can import it directly.
 */

export type StarterOutputKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'model3d'
  | 'gaussian-splat'

export interface StarterRow {
  /** Exact family key served by /api/templates. */
  readonly family: string
  /** Exact template id inside the family. */
  readonly templateId: string
  /** Expected terminal output kind of the starter's save node. */
  readonly outputKind: StarterOutputKind
  /** Exact save-node type the starter must execute. */
  readonly saveNodeType: string
  /** Exact save-target prefix the starter's save node must carry. */
  readonly saveTargetPrefix: string
}

/**
 * Every starter family the gallery advertises, one row each. The live
 * harness requires the native catalog to match this matrix one-to-one
 * before executing anything.
 */
export const STARTER_ROWS: readonly StarterRow[] = [
  { family: 'dinkster.sd15', templateId: 'sd15', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'sd15' },
  { family: 'dinkster.sdxl', templateId: 'sdxl', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'sdxl' },
  { family: 'dinkster.sdxl_refiner', templateId: 'sdxl-refiner', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'sdxl-refiner' },
  { family: 'dinkster.chroma', templateId: 'chroma', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'chroma' },
  { family: 'dinkster.chroma_radiance', templateId: 'chroma-radiance', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'chroma-radiance' },
  { family: 'dinkster.flux_dev', templateId: 'flux-dev', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'flux-dev' },
  { family: 'dinkster.flux_schnell', templateId: 'flux-schnell', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'flux-schnell' },
  { family: 'dinkster.flux2_dev', templateId: 'flux2-dev', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'flux2-dev' },
  { family: 'dinkster.flux2_klein_9b', templateId: 'flux2-klein-9b', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'flux2-klein-9b' },
  { family: 'dinkster.flux2_klein_4b', templateId: 'flux2-klein-4b', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'flux2-klein-4b' },
  { family: 'dinkster.ltxv', templateId: 'ltxv', outputKind: 'video', saveNodeType: 'dinkster.save_video', saveTargetPrefix: 'ltxv' },
  { family: 'dinkster.ltxav', templateId: 'ltxav', outputKind: 'video', saveNodeType: 'dinkster.save_video', saveTargetPrefix: 'ltxav' },
  { family: 'dinkster.z_image', templateId: 'z-image', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'z-image' },
  { family: 'dinkster.z_image_pixel_space', templateId: 'z-image-pixel', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'z-image-pixel' },
  { family: 'dinkster.minimax_h3', templateId: 'minimax-h3', outputKind: 'video', saveNodeType: 'dinkster.save_video', saveTargetPrefix: 'minimax-h3' },
  { family: 'dinkster.minimax_music3', templateId: 'minimax-music3', outputKind: 'audio', saveNodeType: 'dinkster.save_audio', saveTargetPrefix: 'minimax-music3' },
  { family: 'dinkster.krea2', templateId: 'krea2', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'krea2' },
  { family: 'dinkster.ideogram4', templateId: 'ideogram4', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'ideogram4' },
  { family: 'dinkster.seedvr2', templateId: 'seedvr2', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'seedvr2' },
  { family: 'dinkster.anima', templateId: 'anima', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'anima' },
  { family: 'dinkster.lumina2', templateId: 'lumina2', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'lumina2' },
  { family: 'dinkster.trellis2', templateId: 'trellis2', outputKind: 'model3d', saveNodeType: 'dinkster.save_model3d', saveTargetPrefix: 'trellis2' },
  { family: 'dinkster.qwen_image', templateId: 'qwen-image', outputKind: 'image', saveNodeType: 'dinkster.save_image', saveTargetPrefix: 'qwen-image' },
  { family: 'dinkster.triposplat', templateId: 'triposplat', outputKind: 'gaussian-splat', saveNodeType: 'dinkster.save_gaussian_splat', saveTargetPrefix: 'triposplat' },
  { family: 'dinkster.wan21', templateId: 'wan21', outputKind: 'video', saveNodeType: 'dinkster.save_video', saveTargetPrefix: 'wan21' },
  { family: 'dinkster.wan22', templateId: 'wan22', outputKind: 'video', saveNodeType: 'dinkster.save_video', saveTargetPrefix: 'wan22' },
]

export const STARTER_FAMILIES: readonly string[] = STARTER_ROWS.map((row) => row.family)

/**
 * Families whose packs do not compose in a normal launch until wrapper
 * issue 248 lands. An absent catalog entry for one of these is a
 * composition blocker, not an ordinary catalog gap.
 */
export const COMPOSITION_BLOCKER_FAMILIES: readonly string[] = [
  'dinkster.qwen_image',
  'dinkster.triposplat',
  'dinkster.wan21',
  'dinkster.wan22',
]

/** Terminal media-type prefix each output kind must produce. */
export const MEDIA_PREFIX_FOR_KIND: Record<StarterOutputKind, string> = {
  image: 'image/',
  video: 'video/',
  audio: 'audio/',
  model3d: 'model/gltf-binary',
  'gaussian-splat': 'model/ply',
}

export interface SavedArtifact {
  readonly digest?: string
  readonly mediaType?: string
  readonly name?: string
  readonly virtualPath?: string
  readonly size?: number
}

/** Collect saved asset descriptors nested under terminal node outputs. */
export function collectSavedArtifacts(
  value: unknown,
  into: SavedArtifact[],
): void {
  if (Array.isArray(value)) {
    for (const element of value) collectSavedArtifacts(element, into)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  const meta = record['meta']
  if (typeof meta === 'object' && meta !== null) {
    const descriptor = meta as Record<string, unknown>
    if (
      typeof descriptor['digest'] === 'string' &&
      typeof descriptor['mediaType'] === 'string' &&
      typeof descriptor['virtualPath'] === 'string'
    ) {
      into.push({
        digest: descriptor['digest'],
        mediaType: descriptor['mediaType'],
        virtualPath: descriptor['virtualPath'],
        ...(typeof descriptor['name'] === 'string'
          ? { name: descriptor['name'] }
          : {}),
        ...(typeof descriptor['size'] === 'number'
          ? { size: descriptor['size'] }
          : {}),
      })
    }
  }
  for (const child of Object.values(record)) collectSavedArtifacts(child, into)
}

export interface StarterModelOverride {
  /** Document-graph node id whose ASSET input is replaced. */
  readonly node: string
  /** ASSET input id on that node. */
  readonly input: string
  /** Documented model filename the starter advertises for that input. */
  readonly documentedValue: string
  /** Pinned replacement asset filename resolved through /api/assets/guess. */
  readonly replacement: string
  /** Exact byte size the replacement must have. */
  readonly sizeBytes: number
  /** SHA-256 of the replacement asset bytes (64 hex digits). */
  readonly sha256: string
}

export interface StarterValueOverride {
  /** Document-graph node id whose input value is rewritten. */
  readonly node: string
  /** Input id on that node. */
  readonly input: string
  /** Bounded replacement value (dimensions, frame count, duration, steps). */
  readonly value: number | string
}

export interface StarterFamilyOverride {
  readonly models: readonly StarterModelOverride[]
  readonly values: readonly StarterValueOverride[]
}

export type StarterOverrides = ReadonlyMap<string, StarterFamilyOverride>

const SHA256_PATTERN = /^[0-9a-f]{64}$/

function malformed(detail: string): Error {
  return new Error(`malformed DINKSTER_STARTER_OVERRIDES file: ${detail}`)
}

function parseModelOverride(raw: unknown): StarterModelOverride {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw malformed('each model override must be a JSON object')
  }
  const entry = raw as Record<string, unknown>
  for (const key of ['node', 'input', 'documentedValue', 'replacement', 'sizeBytes', 'sha256'] as const) {
    if (!(key in entry)) throw malformed(`model override is missing '${key}'`)
  }
  for (const key of ['node', 'input', 'documentedValue', 'replacement'] as const) {
    if (typeof entry[key] !== 'string' || (entry[key] as string).length === 0) {
      throw malformed(`model override '${key}' must be a non-empty string`)
    }
  }
  if (typeof entry['sizeBytes'] !== 'number' || !Number.isSafeInteger(entry['sizeBytes']) || entry['sizeBytes'] <= 0) {
    throw malformed('model override \'sizeBytes\' must be a positive integer')
  }
  if (typeof entry['sha256'] !== 'string' || !SHA256_PATTERN.test(entry['sha256'].toLowerCase())) {
    throw malformed('model override \'sha256\' must be 64 hex digits')
  }
  if (/[/\\]/.test(entry['replacement'] as string) || entry['replacement'] === '..') {
    throw malformed('model override \'replacement\' must be a plain filename')
  }
  return {
    node: entry['node'] as string,
    input: entry['input'] as string,
    documentedValue: entry['documentedValue'] as string,
    replacement: entry['replacement'] as string,
    sizeBytes: entry['sizeBytes'] as number,
    sha256: (entry['sha256'] as string).toLowerCase(),
  }
}

function parseValueOverride(raw: unknown): StarterValueOverride {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw malformed('each value override must be a JSON object')
  }
  const entry = raw as Record<string, unknown>
  for (const key of ['node', 'input', 'value'] as const) {
    if (!(key in entry)) throw malformed(`value override is missing '${key}'`)
  }
  for (const key of ['node', 'input'] as const) {
    if (typeof entry[key] !== 'string' || (entry[key] as string).length === 0) {
      throw malformed(`value override '${key}' must be a non-empty string`)
    }
  }
  const value = entry['value']
  if (
    !(typeof value === 'number' && Number.isFinite(value)) &&
    !(typeof value === 'string' && value.length > 0)
  ) {
    throw malformed('value override \'value\' must be a finite number or non-empty string')
  }
  return { node: entry['node'] as string, input: entry['input'] as string, value }
}

/**
 * Parse and validate a DINKSTER_STARTER_OVERRIDES file body. Overrides are
 * keyed by exact starter family; a key that is not a matrix family is
 * refused, as is any malformed or unpinned row. Throws with a clear
 * message instead of returning partial overrides.
 */
export function parseStarterOverrides(text: string): StarterOverrides {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw malformed(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw malformed('the file must be a JSON object keyed by starter family')
  }
  const overrides = new Map<string, StarterFamilyOverride>()
  for (const [family, raw] of Object.entries(body as Record<string, unknown>)) {
    if (!STARTER_FAMILIES.includes(family)) {
      throw malformed(`'${family}' is not a starter family from the execution matrix`)
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw malformed(`override for '${family}' must be a JSON object`)
    }
    const entry = raw as Record<string, unknown>
    for (const key of Object.keys(entry)) {
      if (key !== 'models' && key !== 'values') throw malformed(`override for '${family}' has unknown key '${key}'`)
    }
    const models: StarterModelOverride[] = []
    if (entry['models'] !== undefined) {
      if (!Array.isArray(entry['models'])) throw malformed(`'models' for '${family}' must be an array`)
      for (const raw of entry['models']) models.push(parseModelOverride(raw))
    }
    const values: StarterValueOverride[] = []
    if (entry['values'] !== undefined) {
      if (!Array.isArray(entry['values'])) throw malformed(`'values' for '${family}' must be an array`)
      for (const raw of entry['values']) values.push(parseValueOverride(raw))
    }
    if (models.length === 0 && values.length === 0) {
      throw malformed(`override for '${family}' has no rows`)
    }
    const seen = new Set<string>()
    for (const row of [...models.map((row) => `${row.node}/${row.input}`), ...values.map((row) => `${row.node}/${row.input}`)]) {
      if (seen.has(row)) throw malformed(`override for '${family}' targets '${row}' more than once`)
      seen.add(row)
    }
    overrides.set(family, { models, values })
  }
  return overrides
}

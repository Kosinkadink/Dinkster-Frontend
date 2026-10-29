import type { AssetRef, Json, WorkflowDocument } from '@dinkster/core'
import { isAssetRef } from './image-editor.js'

const EXT_KEY = 'dinkster.assetLocations'

export interface WorkflowAssetOccurrence {
  readonly graph: string
  readonly node: string
  readonly input: string
  readonly index: number
  readonly asset: AssetRef
}

export interface AssetLocationHint {
  readonly machine: string
  readonly paths: readonly string[]
}

export function workflowAssetOccurrences(doc: WorkflowDocument): readonly WorkflowAssetOccurrence[] {
  return Object.values(doc.graphs).flatMap((graph) => Object.values(graph.nodes).flatMap((node) =>
    Object.entries(node.values).flatMap(([input, value]) => {
      const values = Array.isArray(value) ? value : [value]
      return values.flatMap((asset, index) => isAssetRef(asset)
        ? [{ graph: graph.id, node: node.id, input, index, asset }] : [])
    })))
}

const isObject = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Saved hints describe previous observations, never authority to read a path. */
export function savedAssetLocation(doc: WorkflowDocument, occurrence: WorkflowAssetOccurrence): AssetLocationHint | undefined {
  const raw = doc.meta?.ext?.[EXT_KEY]
  if (!isObject(raw) || raw['version'] !== 1 || !Array.isArray(raw['observations'])) return undefined
  const observation = raw['observations'].find((entry) => isObject(entry) &&
    entry['digest'] === occurrence.asset.digest && entry['graph'] === occurrence.graph &&
    entry['node'] === occurrence.node && entry['input'] === occurrence.input && entry['index'] === occurrence.index)
  if (!isObject(observation) || typeof observation['machine'] !== 'string' ||
      !Array.isArray(observation['paths']) || !observation['paths'].every((path) => typeof path === 'string')) return undefined
  return { machine: observation['machine'], paths: observation['paths'] as readonly string[] }
}

export function stampAssetLocations(
  doc: WorkflowDocument,
  observed: ReadonlyMap<string, AssetLocationHint> | undefined,
): WorkflowDocument {
  const observations = workflowAssetOccurrences(doc).flatMap((occurrence) => {
    const hint = observed?.get(occurrence.asset.digest) ?? savedAssetLocation(doc, occurrence)
    return hint === undefined ? [] : [{
      graph: occurrence.graph, node: occurrence.node, input: occurrence.input, index: occurrence.index,
      digest: occurrence.asset.digest, machine: hint.machine, paths: [...hint.paths],
    }]
  })
  if (observations.length === 0) return doc
  return { ...doc, meta: { ...doc.meta, ext: { ...doc.meta?.ext,
    [EXT_KEY]: { version: 1, observations },
  } } }
}

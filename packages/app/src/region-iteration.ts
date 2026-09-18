import type { ExecutionState, ValuePeekResult } from '@dinkster/client'
import {
  occurrenceKey,
  parseDinksterRuntimePath,
  parseOccurrenceKey,
  type Occurrence,
} from '@dinkster/core'

export interface RegionIterationNode {
  readonly runtimeId: string
  readonly occurrence: Occurrence
  readonly outputIds: readonly string[]
  readonly state: ExecutionState['nodes'][string]['state']
  readonly progress?: number
  readonly iterationPath: readonly { readonly nodeId: string; readonly iteration: number }[]
}

export interface RegionIteration {
  readonly key: string
  readonly path: RegionIterationNode['iterationPath']
  readonly nodes: readonly RegionIterationNode[]
}

export interface RegionIterationInventory {
  readonly runtimeId: string
  readonly expectedIterations: number | null
  readonly finishedIterations?: number
  readonly iterations: readonly RegionIteration[]
}

export interface RegionValuePresentation {
  readonly available: boolean
  readonly typeId: string
  readonly fingerprint: string
  readonly value?: string
  readonly reason: string
  readonly error: string
}

export function regionValuePresentation(result: ValuePeekResult): RegionValuePresentation {
  if (!result.available) {
    return { available: false, typeId: '', fingerprint: '', reason: result.reason, error: result.error }
  }
  return {
    available: true,
    typeId: result.descriptor.typeId,
    fingerprint: result.descriptor.fingerprint,
    ...(result.descriptor.value === undefined ? {} : { value: String(result.descriptor.value) }),
    reason: '',
    error: '',
  }
}

const flattenedRuntimeId = (runtimeId: string): string | undefined =>
  parseDinksterRuntimePath(runtimeId)?.map((segment) => segment.nodeId).join('.')

export function regionIterationInventory(
  execution: ExecutionState,
  regionOccurrence: Occurrence,
): RegionIterationInventory | undefined {
  const artifact = execution.artifact
  if (artifact === undefined) return undefined
  const runtimeId = artifact.provenance.fromSource[occurrenceKey(regionOccurrence)]
    ?.find((candidate) => execution.regions[candidate] !== undefined)
  if (runtimeId === undefined) return undefined
  const region = execution.regions[runtimeId]!
  const grouped = new Map<string, { path: RegionIterationNode['iterationPath']; nodes: RegionIterationNode[] }>()
  for (const [bodyRuntimeId, progress] of Object.entries(execution.nodes)) {
    const path = parseDinksterRuntimePath(bodyRuntimeId)
    const root = path?.[0]
    if (path === undefined || path.length < 2 || root?.nodeId !== runtimeId || root.iteration === undefined) continue
    const flatId = flattenedRuntimeId(bodyRuntimeId)
    if (flatId === undefined) continue
    const sourceKey = artifact.provenance.toSource[flatId]
    if (sourceKey === undefined) continue
    let occurrence: Occurrence
    try {
      occurrence = parseOccurrenceKey(sourceKey)
    } catch {
      continue
    }
    const iterationPath = path.flatMap((segment) =>
      segment.iteration === undefined ? [] : [{ nodeId: segment.nodeId, iteration: segment.iteration }])
    const key = JSON.stringify(iterationPath)
    let entry = grouped.get(key)
    if (entry === undefined) {
      entry = { path: iterationPath, nodes: [] }
      grouped.set(key, entry)
    }
    const outputIds = new Set([
      ...(artifact.prompt[flatId]?.outputIds ?? []),
      ...Object.keys(progress.outputs ?? {}),
    ])
    entry.nodes.push({
      runtimeId: bodyRuntimeId,
      occurrence,
      outputIds: [...outputIds],
      state: progress.state,
      ...(progress.value === undefined ? {} : { progress: Math.max(0, Math.min(1, progress.value)) }),
      iterationPath,
    })
  }
  const iterations = [...grouped.entries()]
    .map(([key, entry]) => ({ key, path: entry.path, nodes: entry.nodes.sort((a, b) => a.runtimeId.localeCompare(b.runtimeId)) }))
    .sort((a, b) => {
      const count = Math.max(a.path.length, b.path.length)
      for (let index = 0; index < count; index++) {
        const left = a.path[index]
        const right = b.path[index]
        if (left === undefined || right === undefined) return left === undefined ? -1 : 1
        if (left.iteration !== right.iteration) return left.iteration - right.iteration
        const node = left.nodeId.localeCompare(right.nodeId)
        if (node !== 0) return node
      }
      return 0
    })
  return {
    runtimeId,
    expectedIterations: region.iterations,
    ...(region.finishedIterations === undefined ? {} : { finishedIterations: region.finishedIterations }),
    iterations,
  }
}

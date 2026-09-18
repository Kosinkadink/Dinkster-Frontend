/**
 * Data lens: an alternate canvas VIEW that re-skins node bodies with the
 * bound execution's recorded data - per-output values, types, list lengths,
 * run states - so the whole graph is interrogable at a glance without
 * cluttering the default view. Presentation only, by contract:
 *
 * - pure derivation over state the app already holds (execution progress,
 *   occurrence mapping, exactness oracle); never stored, never document
 *   state, and switching lenses changes zero semantics;
 * - layout is untouched - nodes keep size/position so spatial memory
 *   survives lens switches (the renderer draws panels OVER bodies);
 * - the same honesty rules as companion values apply verbatim: inline
 *   scalars display exact only when the exactness oracle proves every
 *   contributing occurrence current (frozen tabs are exact by identity),
 *   multi-occurrence disagreement says 'varies' rather than presenting one
 *   arbitrary iteration, and an unknown instance path abstains ('-') rather
 *   than guessing attribution;
 * - subgraph instance nodes get no panel: their runtime values belong to
 *   the inner nodes, which this lens shows after drilling in.
 */

import { companionText, typeIdDisplayLabel, type DataPanelMap, type DataPanelRow, type SceneNode } from '@dinkster/canvas'
import type { NodeActivity, NodeProgress } from '@dinkster/core'

/** Registered canvas lens ids. 'standard' is the default editing view. */
export type CanvasLens = 'standard' | 'types' | 'data' | 'exposure'

export interface DataLensContext {
  readonly execNodes?: Readonly<Record<string, NodeProgress>> | undefined
  readonly activities?: readonly NodeActivity[] | undefined
  readonly runtimeIdsOf?: ((nodeId: string) => readonly string[]) | undefined
  readonly frozen: boolean
  readonly exactProducer?: ((runtimeId: string) => boolean) | undefined
}

interface RecordedInlineOutput {
  readonly id: string
  readonly value: string | number | boolean
  readonly stale: boolean
}

interface RecordedOutputProjection {
  readonly rows: readonly DataPanelRow[]
  readonly inline: readonly RecordedInlineOutput[]
  /** Number of output ids whose recorded inline values are strings, agreed or not. */
  readonly stringOutputCount: number
}

const entriesForNode = (
  nodeId: string,
  context: DataLensContext,
): readonly (readonly [string, NodeProgress])[] | undefined => {
  if (context.runtimeIdsOf === undefined) return undefined
  const entries: (readonly [string, NodeProgress])[] = []
  for (const runtimeId of context.runtimeIdsOf(nodeId)) {
    const progress = context.execNodes?.[runtimeId]
    if (progress) entries.push([runtimeId, progress])
  }
  return entries
}

/**
 * The recorded-output projection shared by the Data lens and Standard-view
 * text results. Keeping agreement and exactness here prevents the automatic
 * result surface from inventing a second interpretation of execution data.
 */
const projectRecordedOutputs = (
  entries: readonly (readonly [string, NodeProgress])[],
  context: Pick<DataLensContext, 'frozen' | 'exactProducer'>,
): RecordedOutputProjection => {
  const rows: DataPanelRow[] = []
  const inline: RecordedInlineOutput[] = []
  let stringOutputCount = 0
  const outputIds: string[] = []
  for (const [, progress] of entries) {
    for (const outputId of Object.keys(progress.outputs ?? {})) {
      if (!outputIds.includes(outputId)) outputIds.push(outputId)
    }
  }
  for (const outputId of outputIds) {
    const recorded = entries.filter(([, progress]) => progress.outputs?.[outputId] !== undefined)
    const summaries = recorded.map(([, progress]) => progress.outputs![outputId]!)
    const values = summaries.map((summary) => summary.value)
    if (values.length > 0 && values.every((value) => typeof value === 'string')) stringOutputCount += 1
    if (values.every((value) => value !== undefined)) {
      if (new Set(values).size === 1) {
        const exact =
          context.frozen ||
          (context.exactProducer !== undefined && recorded.every(([runtimeId]) => context.exactProducer!(runtimeId)))
        const value = values[0]!
        rows.push({ label: outputId, text: companionText(value), tone: exact ? 'value' : 'stale' })
        inline.push({ id: outputId, value, stale: !exact })
      } else {
        rows.push({ label: outputId, text: 'varies', tone: 'muted' })
      }
    } else {
      const first = summaries[0]!
      const typeText = summaries.every((summary) => summary.typeId === first.typeId) ? typeIdDisplayLabel(first.typeId) : 'varies'
      const length =
        first.length !== undefined && summaries.every((summary) => summary.length === first.length)
          ? ` [${first.length}]`
          : ''
      rows.push({ label: outputId, text: `${typeText}${length}`, tone: 'muted' })
    }
  }
  return { rows, inline, stringOutputCount }
}

export interface RecordedTextOutput {
  readonly text: string
  readonly stale?: true
}

/** Exactly one agreed inline string output, or null when attribution/value is ambiguous. */
export function recordedTextOutputForNode(
  node: Pick<SceneNode, 'id' | 'isSubgraph'>,
  context: DataLensContext,
): RecordedTextOutput | null {
  if (node.isSubgraph) return null
  const entries = entriesForNode(node.id, context)
  if (entries === undefined || entries.length === 0) return null
  const projection = projectRecordedOutputs(entries, context)
  if (projection.stringOutputCount !== 1) return null
  const strings = projection.inline.filter(
    (output): output is RecordedInlineOutput & { readonly value: string } => typeof output.value === 'string',
  )
  if (strings.length !== 1) return null
  return strings[0]!.stale ? { text: strings[0]!.value, stale: true } : { text: strings[0]!.value }
}

const activityText = (activity: NodeActivity): string =>
  activity.kind === 'lazy_demand'
    ? activity.status === 'waiting'
      ? activity.requestedInputs.length > 0
        ? `waiting on lazy inputs: ${activity.requestedInputs.join(', ')}`
        : 'waiting on lazy inputs'
      : 'lazy inputs ready'
    : `cache miss (${activity.reason.replaceAll('-', ' ')})`

export function dataPanelForNode(node: SceneNode, context: DataLensContext): readonly DataPanelRow[] | null {
  if (node.isSubgraph) return null
  return deriveDataPanels({ nodes: [node], ...context })[node.id] ?? null
}

export function deriveDataPanels(args: {
  /** Scene nodes of the CURRENT graph view. */
  readonly nodes: readonly { readonly id: string; readonly isSubgraph: boolean }[]
  /** Bound execution's per-node progress (runtime node id keyed). */
  readonly execNodes?: Readonly<Record<string, NodeProgress>> | undefined
  /** Bound execution's non-semantic activity log. */
  readonly activities?: readonly NodeActivity[] | undefined
  /** Occurrence mapping (see deriveCompanions); undefined = abstain. */
  readonly runtimeIdsOf?: ((nodeId: string) => readonly string[]) | undefined
  /** Frozen tab: the document is the run's snapshot (values exact). */
  readonly frozen: boolean
  /** Live-tab exactness oracle (liveExactnessFor); undefined = stale. */
  readonly exactProducer?: ((runtimeId: string) => boolean) | undefined
}): DataPanelMap {
  const panels: Record<string, readonly DataPanelRow[]> = {}
  for (const n of args.nodes) {
    if (n.isSubgraph) continue
    if (args.runtimeIdsOf === undefined) {
      // Unknown instance path: attribution is unknowable, never guessed.
      panels[n.id] = [{ label: '', text: '-', tone: 'muted' }]
      continue
    }
    const runtimeIds = new Set(args.runtimeIdsOf(n.id))
    const entries = entriesForNode(n.id, args)!
    const activity = [...(args.activities ?? [])].reverse().find((item) => runtimeIds.has(item.nodeId))
    if (entries.length === 0) {
      panels[n.id] = activity === undefined
        ? [{ label: '', text: 'not run', tone: 'muted' }]
        : [{ label: 'activity', text: activityText(activity), tone: 'muted' }]
      continue
    }
    const rows: DataPanelRow[] = []
    if (entries.length > 1) rows.push({ label: 'runs', text: String(entries.length), tone: 'muted' })

    const states = new Set(entries.map(([, p]) => p.state))
    if (states.size > 1) {
      rows.push({ label: 'state', text: 'varies', tone: 'muted' })
    } else {
      const state = [...states][0]!
      if (state === 'skipped') {
        rows.push({ label: 'skipped', text: entries[0]![1].skipReason ?? 'absent upstream', tone: 'muted' })
      } else if (state !== 'done') {
        // 'done' is the unremarkable default; cached/running/pending/error
        // are information (error additionally keeps its border + badge).
        rows.push({ label: 'state', text: state, tone: 'muted' })
      }
    }

    if (activity !== undefined) {
      rows.push({ label: 'activity', text: activityText(activity), tone: 'muted' })
    }

    rows.push(...projectRecordedOutputs(entries, args).rows)
    if (rows.length === 0) rows.push({ label: '', text: 'no recorded outputs', tone: 'muted' })
    panels[n.id] = rows
  }
  return panels
}

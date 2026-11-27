import { outputRowKey, type SceneNode } from '@dinkster/canvas'
import type { Diagnostic } from '@dinkster/core'
import type { ExecutionLogEntry } from '@dinkster/client'
import type { NodeProblemKind, NodeProblemLine } from './problem-display.js'

/** What a line in the node's box offers; none of them fetches anything by itself. */
export type ProblemBoxAction = 'set-secret' | 'edit-field' | 'locate-asset' | 'review-model' | 'model-management' | 'model-storage' | 'show-log' | 'dismiss-run'

/** One line in a node's problem box: one cause, with its row's name and its actions. */
export interface ProblemBoxLine {
  readonly key: string
  readonly kind: NodeProblemKind | 'info'
  readonly row?: string
  readonly rowName?: string
  readonly message: string
  readonly actions: readonly ProblemBoxAction[]
  readonly problem?: NodeProblemLine
}

/** A row a problem can belong to, in the order the node draws its rows. */
export interface ProblemBoxRow {
  readonly key: string
  readonly name: string
  /** The row holds a field the user can put the cursor in. */
  readonly field: boolean
}

/** Runtime details remain in Log; the node shows only the message and its input row. */
export function runtimeProblemBoxLines(
  errors: readonly Diagnostic[],
  logs: readonly ExecutionLogEntry[],
  level: 'error' | 'warning' | 'info',
  rows: readonly ProblemBoxRow[],
): readonly ProblemBoxLine[] {
  if (level !== 'error') return logs.filter((entry) => entry.level === level).map((entry) => ({
    key: `log-${entry.seq}`,
    kind: level,
    message: entry.message,
    actions: ['show-log', 'dismiss-run'],
  }))
  return errors.map((diagnostic, index) => {
    let message = diagnostic.runtime?.exceptionMessage ?? diagnostic.message
    const prefix = diagnostic.runtime?.exceptionType
    if (prefix !== undefined && message.startsWith(`${prefix}: `)) message = message.slice(prefix.length + 2)
    if (message.startsWith('execution: ')) message = message.slice('execution: '.length)
    const namedInput = /^input ['"]([^'"]+)['"]: /u.exec(message)
    const input = diagnostic.anchor?.port?.port ?? diagnostic.data?.['inputId'] ?? namedInput?.[1]
    const row = typeof input === 'string' ? rows.find((candidate) => candidate.key === input) : undefined
    if (row !== undefined && namedInput !== null && namedInput[1] === input) message = message.slice(namedInput[0].length)
    return {
      key: `error-${index}`,
      kind: 'error',
      ...(row === undefined ? {} : { row: row.key }),
      message,
      actions: ['show-log', 'dismiss-run'],
      problem: { kind: 'error', diagnostic, ...(row === undefined ? {} : { row: row.key }) },
    }
  })
}

/** The node's rows as problem rows, top to bottom. */
export function problemBoxRows(node: SceneNode): readonly ProblemBoxRow[] {
  const rows: ProblemBoxRow[] = []
  for (const row of node.layout.rows) {
    if (row.kind === 'widget') {
      rows.push({ key: row.valueKey, name: row.name ?? row.label, field: true })
      if (row.inputId !== row.valueKey) rows.push({ key: row.inputId, name: row.name ?? row.label, field: true })
    } else if (row.kind === 'ports') {
      if (row.input !== undefined) rows.push({ key: row.input.portId, name: row.input.name ?? row.input.label, field: false })
      if (row.output !== undefined) rows.push({ key: outputRowKey(row.output.portId), name: row.output.name ?? row.output.label, field: false })
    } else if (row.kind === 'fallback') {
      rows.push({ key: row.label, name: row.label, field: false })
    }
  }
  return rows
}

/**
 * Order a node's problem lines for its box: lines about the node as a whole
 * first, then rows top to bottom, the strongest cause first on each row.
 * A row the node does not draw now (a folded section, a minimized node) keeps
 * its line after the drawn rows, named by `rowName`.
 */
export function problemBoxLines(
  problems: readonly NodeProblemLine[],
  rows: readonly ProblemBoxRow[],
  rowName: (row: string) => string,
  display: (problem: NodeProblemLine) => string = (problem) => problem.diagnostic.message,
): readonly (ProblemBoxLine & { readonly kind: NodeProblemKind; readonly problem: NodeProblemLine })[] {
  const order = new Map<string, number>()
  rows.forEach((row, index) => { if (!order.has(row.key)) order.set(row.key, index) })
  const rank = (problem: NodeProblemLine): number =>
    problem.row === undefined ? -1 : order.get(problem.row) ?? rows.length
  const strength = (problem: NodeProblemLine): number => problem.kind === 'error' ? 0 : 1
  return problems
    .map((problem, index) => ({ problem, index }))
    .sort((a, b) => rank(a.problem) - rank(b.problem) || strength(a.problem) - strength(b.problem) || a.index - b.index)
    .map(({ problem }) => {
      const row = problem.row === undefined ? undefined : rows.find((candidate) => candidate.key === problem.row)
      const diagnostic = problem.diagnostic
      const nodeMessage = diagnostic.data?.['nodeMessage']
      const actions: ProblemBoxAction[] = diagnostic.code === 'secret.required.missing'
        ? ['set-secret']
        : diagnostic.code === 'asset.availability.missing' && typeof diagnostic.data?.['input'] === 'string'
        ? [...(typeof diagnostic.data['kind'] === 'string' && diagnostic.data['kind'].startsWith('model/') ? ['review-model' as const] : []), 'locate-asset']
        : diagnostic.code.startsWith('model.availability.') && typeof diagnostic.data?.['input'] === 'string'
          ? [
            ...(diagnostic.code === 'model.availability.missing' ? ['review-model' as const] : []),
            ...(diagnostic.code === 'model.availability.model-hidden' ? ['model-management' as const] : []),
            ...(diagnostic.code === 'model.availability.folder-disabled' ? ['model-storage' as const] : []),
            'locate-asset',
          ]
        : row?.field === true ? ['edit-field'] : []
      return {
        key: JSON.stringify([problem.row ?? null, diagnostic.code, diagnostic.message]),
        kind: problem.kind,
        ...(problem.row === undefined ? {} : {
          row: problem.row,
          ...(typeof nodeMessage === 'string' ? {} : { rowName: row?.name ?? rowName(problem.row) }),
        }),
        ...(diagnostic.code === 'compile.input.missing' && diagnostic.hiddenRequiredField !== undefined
          ? { rowName: diagnostic.hiddenRequiredField } : {}),
        message: typeof nodeMessage === 'string' ? nodeMessage : display(problem),
        actions,
        problem,
      }
    })
}

import { outputRowKey, type SceneNode } from '@dinkster/canvas'
import type { NodeProblemKind, NodeProblemLine } from './problem-display.js'

/** What a line in the node's box offers; none of them fetches anything by itself. */
export type ProblemBoxAction = 'edit-field' | 'locate-asset'

/** One line in a node's problem box: one cause, with its row's name and its actions. */
export interface ProblemBoxLine {
  readonly key: string
  readonly kind: NodeProblemKind
  readonly row?: string
  readonly rowName?: string
  readonly message: string
  readonly actions: readonly ProblemBoxAction[]
  readonly problem: NodeProblemLine
}

/** A row a problem can belong to, in the order the node draws its rows. */
export interface ProblemBoxRow {
  readonly key: string
  readonly name: string
  /** The row holds a field the user can put the cursor in. */
  readonly field: boolean
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
): readonly ProblemBoxLine[] {
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
      const actions: ProblemBoxAction[] = diagnostic.code === 'asset.availability.missing' && typeof diagnostic.data?.['input'] === 'string'
        ? ['locate-asset']
        : row?.field === true ? ['edit-field'] : []
      return {
        key: JSON.stringify([problem.row ?? null, diagnostic.code, diagnostic.message]),
        kind: problem.kind,
        ...(problem.row === undefined ? {} : { row: problem.row, rowName: row?.name ?? rowName(problem.row) }),
        message: display(problem),
        actions,
        problem,
      }
    })
}


import { describe, expect, it } from 'vitest'
import { outputRowKey, PROBLEM_ERROR_BADGE, PROBLEM_WARNING_BADGE, type BadgePlacement, type SceneNode } from '@dinkster/canvas'
import { diag } from '@dinkster/core'
import { problemBoxPlacement } from '@dinkster/canvas'
import { problemBoxLines, problemBoxRows } from '../src/problem-box.js'
import type { NodeProblemLine } from '../src/problem-display.js'

const widget = (key: string, y: number) => ({ kind: 'widget', y, height: 20, inset: 8, inputId: key, valueKey: key, label: key })
const node = {
  id: 'gen',
  x: 100,
  y: 50,
  layout: {
    height: 140,
    width: 200,
    pins: [],
    rows: [
      { kind: 'ports', y: 30, height: 20, input: { portId: 'model', label: 'model' }, output: { portId: 'image', label: 'IMAGE' } },
      widget('width', 50),
      widget('height', 70),
      widget('steps', 90),
    ],
  },
} as unknown as SceneNode

const line = (kind: 'error' | 'warning', code: string, row?: string): NodeProblemLine => ({
  kind,
  diagnostic: diag(kind, 'compile', code, `${code} message`),
  ...(row === undefined ? {} : { row }),
})

describe('problemBoxLines', () => {
  it('lists the whole node first, then rows top to bottom, strongest first on a row', () => {
    const lines = problemBoxLines([
      line('warning', 'steps.max', 'steps'),
      line('warning', 'width.inferred', 'width'),
      line('error', 'height.positive', 'height'),
      line('error', 'width.positive', 'width'),
      line('warning', 'output.unused', outputRowKey('image')),
      line('error', 'rule.two-fields'),
    ], problemBoxRows(node), (row) => row)
    expect(lines.map((entry) => [entry.rowName ?? null, entry.problem.diagnostic.code])).toEqual([
      [null, 'rule.two-fields'],
      ['IMAGE', 'output.unused'],
      ['width', 'width.positive'],
      ['width', 'width.inferred'],
      ['height', 'height.positive'],
      ['steps', 'steps.max'],
    ])
  })

  it('offers Edit field only on a field and Locate or replace for a missing asset', () => {
    const missing: NodeProblemLine = {
      kind: 'warning',
      row: 'width',
      diagnostic: diag('warning', 'validation', 'asset.availability.missing', 'missing', { data: { input: 'width', digest: 'abc' } }),
    }
    const lines = problemBoxLines([
      line('error', 'model.required', 'model'),
      line('error', 'height.positive', 'height'),
      missing,
      line('error', 'rule.whole'),
    ], problemBoxRows(node), (row) => row)
    expect(lines.map((entry) => [entry.problem.diagnostic.code, entry.actions])).toEqual([
      ['rule.whole', []],
      ['model.required', []],
      ['asset.availability.missing', ['locate-asset']],
      ['height.positive', ['edit-field']],
    ])
  })

  it('keeps a line whose row is not drawn now, after the drawn rows, under its own name', () => {
    const lines = problemBoxLines([line('error', 'hidden.bad', 'denoise'), line('warning', 'steps.max', 'steps')],
      problemBoxRows(node), (row) => `name of ${row}`)
    expect(lines.map((entry) => entry.rowName)).toEqual(['steps', 'name of denoise'])
  })
})

describe('problemBoxPlacement', () => {
  it('hangs below the node and its lowest tab, at least its tabs wide, at screen scale', () => {
    const tab = (x: number, y: number, height: number, badge = PROBLEM_ERROR_BADGE) =>
      ({ x, y, width: 40, height, badge, compact: false }) as BadgePlacement
    const at = problemBoxPlacement(node, [tab(100, 190, 16), tab(144, 192, 18, PROBLEM_WARNING_BADGE)], { x: 10, y: -20, scale: 2 }, 1200)
    // The tabs reach from the node's left edge at 100 to 184, so the box is at least 84 * 2 wide.
    expect(at).toEqual({ x: 100 * 2 + 10, y: 210 * 2 - 20 + 4, maxWidth: 400, minWidth: 84 * 2 })
    const nodeBottomOnScreen = (50 + 140) * 2 - 20
    expect(at!.y).toBeGreaterThan(nodeBottomOnScreen)
  })

  it('limits the box by the screen, not the node or the zoom, and draws none once tabs are not drawn', () => {
    // A narrow node zoomed out and a wide node zoomed in have the same limit.
    expect(problemBoxPlacement(node, [], { x: 0, y: 0, scale: 0.6 }, 1200)?.maxWidth).toBe(400)
    expect(problemBoxPlacement(node, [], { x: 0, y: 0, scale: 3 }, 1200)?.maxWidth).toBe(400)
    // A pane narrower than 400 + 2 * 16 keeps 16 px at each side.
    expect(problemBoxPlacement(node, [], { x: 0, y: 0, scale: 1 }, 300)?.maxWidth).toBe(268)
    expect(problemBoxPlacement(node, [], { x: 0, y: 0, scale: 0.5 }, 1200)).toBeDefined()
    expect(problemBoxPlacement(node, [], { x: 0, y: 0, scale: 0.49 }, 1200)).toBeUndefined()
  })
})

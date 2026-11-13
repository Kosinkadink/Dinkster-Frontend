import { afterEach, describe, expect, it, vi } from 'vitest'
import { renamedNodeHeaderOriginalTitle, resolveCanvasTooltip, TooltipController } from '../src/tooltips.js'
import '../src/locale.js'

afterEach(() => vi.useRealTimers())

describe('TooltipController', () => {
  it('honors delay and provider priority', () => {
    vi.useFakeTimers()
    const controller = new TooltipController(() => 500)
    controller.register({ id: 'first', resolve: () => ({ lines: ['first'] }) })
    controller.register({ id: 'second', resolve: () => ({ lines: ['second'] }) })
    controller.show({}, { x: 1, y: 2 })
    vi.advanceTimersByTime(499)
    expect(controller.visible).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(controller.visible?.lines).toEqual(['first'])
  })

  it('shows Alt detail instantly and reverts to basic on release', () => {
    vi.useFakeTimers()
    const controller = new TooltipController()
    controller.register({ id: 'p', resolve: (_target, opts) => ({ lines: ['basic'], ...(opts.detailed ? { detail: ['detail'] } : {}) }) })
    controller.show({}, { x: 1, y: 2 }, true)
    expect(controller.visible?.detail).toEqual(['detail'])
    controller.setDetailed(false)
    expect(controller.visible?.detail).toBeUndefined()
  })

  it('supports an immediate renamed-header show without changing normal delay', () => {
    vi.useFakeTimers()
    const controller = new TooltipController(() => 500)
    controller.register({ id: 'p', resolve: (target) => ({ lines: [(target as { name: string }).name] }) })
    controller.show({ name: 'normal' }, { x: 0, y: 0 })
    expect(controller.visible).toBeUndefined()
    controller.show({ name: 'renamed' }, { x: 0, y: 0 }, false, true)
    expect(controller.visible?.lines).toEqual(['renamed'])
  })

  it('hideMatching hides only a matching visible tooltip', () => {
    const controller = new TooltipController(() => 0)
    controller.register({ id: 'p', resolve: (target) => ({ lines: [(target as { kind: string }).kind] }) })
    controller.show({ kind: 'dom' }, { x: 0, y: 0 }, true)
    controller.hideMatching((target) => (target as { kind?: string }).kind !== 'dom')
    expect(controller.visible?.lines).toEqual(['dom'])
    controller.show({ kind: 'pin' }, { x: 0, y: 0 }, true)
    controller.hideMatching((target) => (target as { kind?: string }).kind !== 'dom')
    expect(controller.visible).toBeUndefined()
  })

  it('keeps a canvas tooltip visible when a sibling owner invalidates its scene', () => {
    const controller = new TooltipController(() => 0)
    const focused = Symbol('focused')
    const sibling = Symbol('sibling')
    controller.register({ id: 'p', resolve: (target) => ({ lines: [(target as { kind: string }).kind] }) })
    controller.show({ kind: 'pin' }, { x: 0, y: 0 }, true, false, focused)

    controller.hideMatching((target) => (target as { kind?: string }).kind !== 'dom', sibling)
    expect(controller.visible?.lines).toEqual(['pin'])

    controller.hideMatching((target) => (target as { kind?: string }).kind !== 'dom', focused)
    expect(controller.visible).toBeUndefined()
  })

  it('refreshes only the matching visible owned target without reopening a dismissed tooltip', () => {
    vi.useFakeTimers()
    const controller = new TooltipController()
    const owner = Symbol('canvas')
    const oldTarget = { value: 512 }
    const currentTarget = { value: 1024 }
    controller.register({ id: 'value', resolve: (target, opts) => ({
      lines: [String((target as { value: number }).value)],
      ...(opts.detailed ? { detail: ['detail'] } : {}),
    }) })
    controller.show(oldTarget, { x: 13, y: 29 }, true, true, owner)
    controller.refreshTarget(oldTarget, currentTarget, Symbol('other canvas'))
    controller.refreshTarget({ value: 512 }, currentTarget, owner)
    expect(controller.visible?.lines).toEqual(['512'])
    controller.refreshTarget(oldTarget, currentTarget, owner)
    expect(controller.visible).toEqual({ lines: ['1024'], detail: ['detail'], x: 13, y: 29, detailed: true })
    controller.show({ value: 99 }, { x: 1, y: 2 }, false, false, owner)
    controller.refreshTarget(currentTarget, { value: 2048 }, owner)
    expect(controller.visible?.lines).toEqual(['1024'])
    vi.advanceTimersByTime(500)
    expect(controller.visible?.lines).toEqual(['99'])
    controller.hide()
    controller.refreshTarget(currentTarget, { value: 2048 }, owner)
    expect(controller.visible).toBeUndefined()
  })
})

describe('canvas tooltip provider', () => {
  const node = { node: { type: 'Sampler', values: { steps: 20 } }, layout: { title: 'Sampler' } }
  const schema = {
    description: 'Samples a latent image.', pack: 'sampling-pack',
    items: [
      { kind: 'input', id: 'model', tooltip: 'Model used for sampling.' },
      { kind: 'input', id: 'steps', tooltip: 'Number of sampling steps.' },
    ],
  }
  const context = { resolveSchema: () => schema, resolvePack: () => ({ displayName: 'Sampling Pack' }) }

  it('shows toolbox labels and disabled reasons', () => {
    const enabled = { kind: 'toolbox', button: { button: { label: 'Execute up to' } } }
    const disabled = {
      kind: 'toolbox',
      button: { button: { label: 'Execute from onwards', reason: 'no output node is downstream of the selection' } },
    }
    expect(resolveCanvasTooltip(enabled, { detailed: false })?.lines).toEqual(['Execute up to'])
    expect(resolveCanvasTooltip(disabled, { detailed: false })?.lines).toEqual([
      'Execute from onwards',
      'no output node is downstream of the selection',
    ])
  })

  it('adds the input doc string to detailed pin content', () => {
    const target = { kind: 'pin', hit: { node, direction: 'in', portId: 'model', pin: { label: 'model' }, type: { kind: 'concrete', name: 'MODEL' } } }
    expect(resolveCanvasTooltip(target, { detailed: true }, context)?.detail).toEqual(['Model used for sampling.'])
  })

  it('identifies maybe-absent outputs before they are connected', () => {
    const target = {
      kind: 'pin',
      hit: {
        node,
        direction: 'out',
        portId: 'result',
        pin: { label: 'result', maybeAbsent: true },
        type: { kind: 'concrete', name: 'FLOAT' },
      },
    }
    expect(resolveCanvasTooltip(target, { detailed: false }, context)?.lines).toEqual([
      'FLOAT',
      'May produce no value.',
    ])
  })

  it('renders a widget tap hover target as an output tooltip with its widget label and input-id fallback', () => {
    const target = {
      kind: 'widgetTap',
      hit: {
        node: {
          ...node,
          layout: {
            ...node.layout,
            rows: [{ kind: 'widget', inputId: 'steps', label: 'Steps value' }],
          },
        },
        input: 'steps',
        pin: { portId: 'steps', address: { port: 'steps' }, widgetTap: true },
        type: { kind: 'concrete', name: 'core.integer' },
      },
    }
    expect(resolveCanvasTooltip(target, { detailed: false })).toEqual({
      title: 'Output: Steps value',
      lines: ['core.integer'],
    })
    expect(resolveCanvasTooltip({
      ...target,
      hit: { ...target.hit, input: 'missing' },
    }, { detailed: false })).toMatchObject({ title: 'Output: missing' })
  })

  it('warned pin shows its diagnostic messages one per line', () => {
    const target = {
      kind: 'pin',
      hit: { node, direction: 'in', portId: 'model', pin: { label: 'model' }, type: { kind: 'concrete', name: 'MODEL' } },
      diagnostics: [
        { severity: 'warning', message: 'specialization is stale' },
        { severity: 'error', message: 'types do not match' },
      ],
    }
    expect(resolveCanvasTooltip(target, { detailed: false }, context)?.lines).toEqual([
      'MODEL',
      'If absent: Skip (default for required input) - the consumer does not run and its outputs become absent.',
      'specialization is stale',
      'types do not match',
    ])
  })

  it('explains unresolved and inferred match-type pins', () => {
    const unresolved = {
      kind: 'pin',
      hit: {
        node,
        direction: 'in',
        portId: 'item',
        pin: { matchVariable: 'T' },
        type: { kind: 'variable', templateId: 'T' },
      },
    }
    expect(resolveCanvasTooltip(unresolved, { detailed: false }, context)?.lines).toEqual([
      'Match type T: every T port on this node must resolve to the same type.',
    ])

    const inferred = {
      ...unresolved,
      hit: {
        ...unresolved.hit,
        pin: { matchVariable: 'T', inferred: true },
        type: { kind: 'list', element: { kind: 'concrete', name: 'IMAGE' } },
      },
    }
    expect(resolveCanvasTooltip(inferred, { detailed: false }, context)?.lines).toEqual([
      'Resolved to list<IMAGE>.',
      'Match type T: every T port on this node must resolve to the same type.',
    ])
  })

  it('shows every constraint before and after a match type resolves', () => {
    const unresolved = {
      kind: 'pin',
      hit: {
        node,
        direction: 'out',
        portId: 'value',
        pin: {
          matchVariable: 'T',
          matchConstraint: {
            kind: 'variable',
            templateId: 'T',
            allowedTypes: [
              { kind: 'concrete', name: 'IMAGE' },
              { kind: 'concrete', name: 'MASK' },
            ],
          },
        },
        type: {
          kind: 'variable',
          templateId: 'T',
          allowedTypes: [
            { kind: 'concrete', name: 'IMAGE' },
            { kind: 'concrete', name: 'MASK' },
          ],
        },
      },
    }
    expect(resolveCanvasTooltip(unresolved, { detailed: false }, context)?.lines).toEqual([
      'Accepts IMAGE | MASK.',
      'Match type T: every T port on this node must resolve to the same type.',
    ])
    expect(resolveCanvasTooltip({
      ...unresolved,
      hit: { ...unresolved.hit, pin: { ...unresolved.hit.pin, inferred: true }, type: { kind: 'concrete', name: 'IMAGE' } },
    }, { detailed: false }, context)?.lines).toEqual([
      'Resolved to IMAGE; original constraint: IMAGE | MASK.',
      'Match type T: every T port on this node must resolve to the same type.',
    ])
  })

  it('mismatch link hover shows every retained solver diagnostic', () => {
    const target = {
      kind: 'link',
      hit: {
        link: {
          mismatch: true,
          diagnostics: [
            { severity: 'warning', message: 'IMAGE cannot feed LATENT' },
            { severity: 'error', message: 'type variable has no solution' },
          ],
        },
      },
    }
    expect(resolveCanvasTooltip(target, { detailed: false })).toEqual({
      title: 'Type mismatch',
      lines: ['IMAGE cannot feed LATENT', 'type variable has no solution'],
    })
  })

  it('adds numeric constraints and the input doc to detailed widget content', () => {
    const target = { kind: 'widget', hit: { node, row: { inputId: 'steps', valueKey: 'steps', label: 'steps', spec: { options: { min: 1, max: 100, step: 1 } } } } }
    expect(resolveCanvasTooltip(target, { detailed: true }, context)?.detail).toEqual([
      'min: 1', 'max: 100', 'step: 1', 'Number of sampling steps.',
    ])
  })

  it('exposes the full stored value and the intrinsic default for clipped numeric rows', () => {
    const row = {
      inputId: 'seed', valueKey: 'seed', label: 'seed',
      spec: { widgetType: 'INT', options: { min: 0 } },
    }
    const unstored = { kind: 'widget', hit: { node: { node: { type: 'Sampler', values: {} } }, row } }
    expect(resolveCanvasTooltip(unstored, { detailed: false })?.lines).toEqual(['Value: 0'])
    const stored = {
      kind: 'widget',
      hit: { node: { node: { type: 'Sampler', values: { seed: 9007199254740991 } } }, row },
    }
    expect(resolveCanvasTooltip(stored, { detailed: false })?.lines)
      .toEqual(['Value: 9007199254740991'])
  })

  it.each([
    ['expected', 'Current expected value: 1.30'],
    ['cached', 'Retained last-resolved value: 1.30'],
    ['stale', 'Stale/unproven value: 1.30'],
  ] as const)('names the %s connected display state and dormant stored value truthfully', (state, line) => {
    const row = {
      inputId: 'cfg', valueKey: 'cfg', label: 'cfg',
      spec: { widgetType: 'FLOAT', options: { step: 0.01 } },
    }
    const target = {
      kind: 'widget', connected: true,
      hit: { node: { node: { type: 'Sampler', values: { cfg: 8 } } }, row },
      companion: { value: 1.3, state },
    }
    expect(resolveCanvasTooltip(target, { detailed: false })?.lines).toEqual([
      line,
      'Dormant stored value under connection: 8.00',
    ])
  })

  it('describes a connected controller as inert instead of advertising activation', () => {
    const target = {
      kind: 'controller', connected: true,
      hit: { row: { controllerMode: 'randomize', spec: { controller: 'after_generate' } } },
    }
    const detail = resolveCanvasTooltip(target, { detailed: true })?.detail?.[0]
    expect(detail).toContain('Connected controls are inert.')
    expect(detail).not.toContain('Click to choose')
  })

  it('adds schema description and source pack to detailed node-header content', () => {
    const target = { kind: 'header', hit: { node } }
    expect(resolveCanvasTooltip(target, { detailed: true }, context)?.detail).toEqual([
      'Samples a latent image.', 'Source pack: Sampling Pack',
    ])
  })

  it('shows the original display name for a renamed node header', () => {
    const target = {
      kind: 'header',
      hit: { node: { ...node, node: { ...node.node, title: 'My Sampler' }, layout: { title: 'My Sampler' } } },
    }
    expect(resolveCanvasTooltip(target, { detailed: false }, context)).toMatchObject({
      title: 'My Sampler',
      lines: ['Original: Sampler'],
    })
    expect(renamedNodeHeaderOriginalTitle(target, context)).toBe('Sampler')
  })

  it('shows the unknown node type on an unrecognized node header', () => {
    const unknown = {
      kind: 'header',
      hit: {
        node: {
          node: { type: 'Missing.Type', title: 'Custom' },
          layout: { title: 'Custom' },
          unrecognized: true,
          missingSchema: true,
        },
      },
    }
    expect(resolveCanvasTooltip(unknown, { detailed: false })).toMatchObject({
      title: 'Custom',
      lines: ['Unknown node type: Missing.Type'],
    })
    expect(resolveCanvasTooltip(unknown, { detailed: true })?.detail).toEqual(['Schema unavailable'])
  })

  it('uses a document-derived subgraph display name for equal and custom titles', () => {
    const subgraphContext = { resolveSchema: () => ({ displayName: 'Reusable Stage' }) }
    const subgraphNode = (title: string) => ({
      kind: 'header',
      hit: {
        node: {
          node: { type: '#sub1', title },
          layout: { title },
        },
      },
    })
    expect(renamedNodeHeaderOriginalTitle(subgraphNode('Reusable Stage'), subgraphContext)).toBeUndefined()
    expect(renamedNodeHeaderOriginalTitle(subgraphNode('Custom Stage'), subgraphContext)).toBe('Reusable Stage')
    expect(resolveCanvasTooltip(subgraphNode('Custom Stage'), { detailed: false }, subgraphContext)?.lines)
      .toEqual(['Original: Reusable Stage'])
  })

})

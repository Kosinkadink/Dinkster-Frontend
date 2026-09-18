import { afterEach, describe, expect, it, vi } from 'vitest'
import { nodeHeaderTooltipImmediate, renamedNodeHeaderOriginalTitle, resolveCanvasTooltip, TooltipController } from '../src/tooltips.js'
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

  it('hideMatching cancels only matching pending candidates', () => {
    vi.useFakeTimers()
    const controller = new TooltipController(() => 500)
    controller.register({ id: 'p', resolve: (target) => ({ lines: [(target as { kind: string }).kind] }) })
    controller.show({ kind: 'dom' }, { x: 0, y: 0 })
    controller.hideMatching((target) => (target as { kind?: string }).kind !== 'dom')
    vi.advanceTimersByTime(500)
    expect(controller.visible?.lines).toEqual(['dom'])
    controller.show({ kind: 'pin' }, { x: 0, y: 0 })
    controller.hideMatching((target) => (target as { kind?: string }).kind !== 'dom')
    vi.advanceTimersByTime(500)
    // The pin candidate was cancelled; the visible dom tooltip survives.
    expect(controller.visible?.lines).toEqual(['dom'])
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

  it('keeps a pending canvas tooltip when a sibling owner invalidates its scene', () => {
    vi.useFakeTimers()
    const controller = new TooltipController(() => 500)
    const focused = Symbol('focused')
    const sibling = Symbol('sibling')
    controller.register({ id: 'p', resolve: (target) => ({ lines: [(target as { kind: string }).kind] }) })
    controller.show({ kind: 'pin' }, { x: 0, y: 0 }, false, false, focused)

    controller.hideMatching((target) => (target as { kind?: string }).kind !== 'dom', sibling)
    vi.advanceTimersByTime(500)
    expect(controller.visible?.lines).toEqual(['pin'])
  })

  it('hides immediately and unregister removes a provider', () => {
    const controller = new TooltipController(() => 0)
    const unregister = controller.register({ id: 'p', resolve: () => ({ lines: ['text'] }) })
    controller.show({}, { x: 0, y: 0 }, true)
    expect(controller.visible).toBeDefined()
    controller.hide()
    expect(controller.visible).toBeUndefined()
    unregister()
    controller.show({}, { x: 0, y: 0 }, true)
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

  it('explains explicit and required-ness-default absence policies on consumer inputs', () => {
    const items = [
      { kind: 'input', id: 'requiredDefault', type: { kind: 'concrete', name: 'FLOAT' }, optional: false },
      { kind: 'input', id: 'optionalDefault', type: { kind: 'concrete', name: 'FLOAT' }, optional: true },
      { kind: 'input', id: 'accepted', type: { kind: 'concrete', name: 'FLOAT' }, optional: true, onAbsent: 'accept' },
      { kind: 'input', id: 'failed', type: { kind: 'concrete', name: 'FLOAT' }, optional: false, onAbsent: 'fail' },
      { kind: 'input', id: 'explicitSkip', type: { kind: 'concrete', name: 'FLOAT' }, optional: true, onAbsent: 'skip' },
      { kind: 'input', id: 'explicitOmit', type: { kind: 'concrete', name: 'FLOAT' }, optional: true, onAbsent: 'omit' },
    ]
    const policyContext = { resolveSchema: () => ({ items }) }
    const linesFor = (portId: string) => resolveCanvasTooltip({
      kind: 'pin',
      hit: { node, direction: 'in', portId, pin: {}, type: { kind: 'concrete', name: 'FLOAT' } },
    }, { detailed: false }, policyContext)?.lines

    expect(linesFor('requiredDefault')).toContain('If absent: Skip (default for required input) - the consumer does not run and its outputs become absent.')
    expect(linesFor('optionalDefault')).toContain('If absent: Omit (default for optional input) - the input is treated as unconnected, using its default when present and the same cache entry.')
    expect(linesFor('accepted')).toContain('If absent: Accept (declared by schema) - the consumer runs with no value.')
    expect(linesFor('failed')).toContain('If absent: Fail (declared by schema) - execution stops and reports the absence origin.')
    expect(linesFor('explicitSkip')).toContain('If absent: Skip (declared by schema) - the consumer does not run and its outputs become absent.')
    expect(linesFor('explicitOmit')).toContain('If absent: Omit (declared by schema) - the input is treated as unconnected, using its default when present and the same cache entry.')
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
      '[warning] specialization is stale',
      '[error] types do not match',
    ])
  })

  it('presents core.combo inputs and outputs as COMBO', () => {
    const comboInput = {
      kind: 'pin',
      hit: { node, direction: 'in', portId: 'mode', pin: {}, type: { kind: 'concrete', name: 'core.combo' } },
    }
    const comboOutput = {
      kind: 'pin',
      hit: { node, direction: 'out', portId: 'choice', pin: {}, type: { kind: 'concrete', name: 'core.combo' } },
    }
    expect(resolveCanvasTooltip(comboInput, { detailed: false }, context)?.lines).toEqual(['COMBO (string with choices)'])
    expect(resolveCanvasTooltip(comboOutput, { detailed: false }, context)?.lines).toEqual(['COMBO (string with choices)'])
  })

  it('shows the ComfyUI display alias for reroutes on native dinkster types', () => {
    const aliased = { kind: 'reroute', hit: { reroute: { typeName: 'dinkster.latent' } } }
    const unaliased = { kind: 'reroute', hit: { reroute: { typeName: 'custom.thing' } } }
    const untyped = { kind: 'reroute', hit: { reroute: {} } }
    expect(resolveCanvasTooltip(aliased, { detailed: false })?.lines).toEqual(['LATENT'])
    expect(resolveCanvasTooltip(unaliased, { detailed: false })?.lines).toEqual(['custom.thing'])
    expect(resolveCanvasTooltip(untyped, { detailed: false })?.lines).toEqual(['Any'])
  })

  it('pin tooltips on native dinkster types show the alias with the canonical id', () => {
    const target = {
      kind: 'pin',
      hit: { node, direction: 'in', portId: 'clip', pin: {}, type: { kind: 'concrete', name: 'dinkster.clip' } },
    }
    expect(resolveCanvasTooltip(target, { detailed: false }, context)?.lines).toEqual(['CLIP (dinkster.clip)'])
  })

  it('keeps an unmarked string pin tooltip plain', () => {
    const target = {
      kind: 'pin',
      hit: { node, direction: 'in', portId: 'text', pin: {}, type: { kind: 'concrete', name: 'core.string' } },
    }
    expect(resolveCanvasTooltip(target, { detailed: false }, context)?.lines).toEqual(['core.string'])
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

  it('keeps wrappers in a resolved match-type constraint', () => {
    const constraint = {
      kind: 'list',
      element: {
        kind: 'variable',
        templateId: 'T',
        allowedTypes: [{ kind: 'concrete', name: 'IMAGE' }, { kind: 'concrete', name: 'MASK' }],
      },
    }
    const target = {
      kind: 'pin',
      hit: {
        node,
        direction: 'out',
        portId: 'items',
        pin: { matchVariable: 'T', matchConstraint: constraint, inferred: true },
        type: { kind: 'list', element: { kind: 'concrete', name: 'IMAGE' } },
      },
    }
    expect(resolveCanvasTooltip(target, { detailed: false }, context)?.lines).toEqual([
      'Resolved to list<IMAGE>; original constraint: list<IMAGE | MASK>.',
      'Match type T: every T port on this node must resolve to the same type.',
    ])
  })

  it('describes Any as an independent wildcard', () => {
    const target = {
      kind: 'pin',
      hit: { node, direction: 'in', portId: 'any', pin: {}, type: { kind: 'wildcard' } },
    }
    expect(resolveCanvasTooltip(target, { detailed: false }, context)?.lines).toEqual([
      'Any type; this port accepts values independently and does not determine other ports.',
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
      lines: ['[warning] IMAGE cannot feed LATENT', '[error] type variable has no solution'],
    })
  })

  it('healthy link hover has no tooltip', () => {
    const target = { kind: 'link', hit: { link: { typeName: 'IMAGE' } } }
    expect(resolveCanvasTooltip(target, { detailed: false })).toBeUndefined()
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

  it('names a connected dormant stored value and formats it through the descriptor', () => {
    const row = {
      inputId: 'cfg', valueKey: 'cfg', label: 'cfg',
      spec: { widgetType: 'FLOAT', options: { step: 0.1 } },
    }
    const target = {
      kind: 'widget', connected: true,
      hit: { node: { node: { type: 'Sampler', values: { cfg: 8 } } }, row },
    }
    expect(resolveCanvasTooltip(target, { detailed: false })?.lines)
      .toEqual(['Dormant stored value under connection: 8.0'])
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

  it('advertises F1 on documented node headers', () => {
    const target = { kind: 'header', hit: { node } }
    const documented = { ...context, resolveSchema: () => ({ ...schema, hasDocs: true }) }
    expect(resolveCanvasTooltip(target, { detailed: false }, documented)?.lines).toEqual([
      'Sampler', 'Press F1 for full help.',
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

  it('keeps recognized equal-name headers on the normal tooltip path', () => {
    const equal = {
      kind: 'header',
      hit: { node: { ...node, node: { ...node.node, title: 'Sampler' } } },
    }
    expect(renamedNodeHeaderOriginalTitle(equal, context)).toBeUndefined()
    expect(resolveCanvasTooltip(equal, { detailed: false }, context)?.lines).toEqual(['Sampler'])
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

  it('shows an equal-name unrecognized header immediately without affecting recognized headers', () => {
    const unknown = {
      kind: 'header',
      hit: { node: { node: { type: 'Missing.Type', title: 'Missing.Type' }, layout: { title: 'Missing.Type' }, unrecognized: true } },
    }
    const legacyMissing = {
      kind: 'header',
      hit: { node: { node: { type: 'Legacy.Missing', title: 'Legacy.Missing' }, layout: { title: 'Legacy.Missing' }, missingSchema: true } },
    }
    const recognized = {
      kind: 'header',
      hit: { node: { node: { type: 'Sampler', title: 'Sampler' }, layout: { title: 'Sampler' } } },
    }
    const renamed = {
      kind: 'header',
      hit: { node: { node: { type: 'Sampler', title: 'My Sampler' }, layout: { title: 'My Sampler' } } },
    }
    expect(nodeHeaderTooltipImmediate(unknown)).toBe(true)
    expect(nodeHeaderTooltipImmediate(legacyMissing)).toBe(true)
    expect(nodeHeaderTooltipImmediate(recognized, context)).toBe(false)
    expect(nodeHeaderTooltipImmediate(renamed, context)).toBe(true)
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

  it('derives region header explanations from the occurrence contract', () => {
    const header = (region: Record<string, unknown>) => ({
      kind: 'header',
      hit: { node: { node: { type: '#body', region }, layout: { title: 'Region' } } },
    })
    expect(resolveCanvasTooltip(header({ kind: 'map', elementPorts: ['item'], binding: 'cross' }), { detailed: false }))
      .toEqual({ title: 'Map region', lines: ['Runs once per item from item using cross binding and gathers outputs.'] })
    expect(resolveCanvasTooltip(header({ kind: 'fold', elementPorts: ['item'], statePorts: ['state'] }), { detailed: false })?.lines)
      .toEqual(['Reduces items from item through loop state state.'])
    expect(resolveCanvasTooltip(header({ kind: 'while', statePorts: ['state'], continueOutput: 'continue', maxIterations: 12 }), { detailed: false })?.lines)
      .toEqual(['Repeats state state while continue is true, up to 12 iterations.'])
    expect(resolveCanvasTooltip(header({
      kind: 'map', elementPorts: ['item'], maxIterations: 8,
      outputRoles: { batches: { kind: 'flatten' }, state: { kind: 'state', statePort: 'seed' } },
    }), { detailed: false })?.lines).toEqual([
      'Runs once per item from item using zip binding, up to 8 iterations. Outputs: batches flattened; state carries seed state.',
    ])
    expect(resolveCanvasTooltip(header({
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'], binding: 'broadcast', maxIterations: 4,
    }), { detailed: false })?.lines).toEqual([
      'Reduces items from item through loop state state using broadcast binding, up to 4 iterations.',
    ])
  })

  it('uses a badge summary for basic content and primary lines for detail', () => {
    const target = { kind: 'badge', tooltip: { summary: 'Sampling Pack', detail: ['pack sampling-pack (SP)'] } }
    expect(resolveCanvasTooltip(target, { detailed: false })?.lines).toEqual(['Sampling Pack'])
    expect(resolveCanvasTooltip(target, { detailed: true })?.detail).toEqual(['pack sampling-pack (SP)'])
  })
})

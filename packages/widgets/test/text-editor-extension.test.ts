import { describe, expect, it, vi } from 'vitest'
import {
  EmbeddingAndLoraCompletionProvider,
  LiveEmbeddingAndLoraInventoryProvider,
  SchemaTextCompletionProvider,
  TextWidgetEditorExtensionRegistry,
  type TextCompletionChoiceSource,
  type TextWidgetEditorContext,
  type TextWidgetEditorExtension,
} from '../src/text-editor-extension.js'

const context = (multiline = true): TextWidgetEditorContext => ({
  graphId: 'g0',
  nodeId: 'n0',
  inputId: 'text',
  nodeType: 'comfy.CLIPTextEncode',
  spec: { widgetType: 'STRING', options: { multiline } },
})

const extension = (id: string, supports = true): TextWidgetEditorExtension => ({
  id,
  supports: () => supports,
  complete: () => [],
})

describe('TextWidgetEditorExtensionRegistry', () => {
  it('refuses duplicate ids without replacing the registered provider', () => {
    const registry = new TextWidgetEditorExtensionRegistry()
    const first = extension('pack.complete')
    registry.register(first)
    expect(() => registry.register(extension('pack.complete'))).toThrow("text editor extension 'pack.complete' already registered")
    expect(registry.providersFor(context())).toEqual([first])
  })

  it('uses provider identity for disposal and makes stale disposers no-ops', () => {
    const registry = new TextWidgetEditorExtensionRegistry()
    const first = extension('pack.complete')
    const disposeFirst = registry.register(first)
    disposeFirst()
    const second = extension('pack.complete')
    registry.register(second)
    disposeFirst()
    expect(registry.providersFor(context())).toEqual([second])
  })

  it('returns supporting providers in stable registration order', () => {
    const registry = new TextWidgetEditorExtensionRegistry()
    const first = extension('pack.first')
    const hidden = extension('pack.hidden', false)
    const second = extension('pack.second')
    registry.register(first)
    registry.register(hidden)
    registry.register(second)
    expect(registry.providersFor(context())).toEqual([first, second])
  })

  it('isolates a provider whose supports check throws', () => {
    const registry = new TextWidgetEditorExtensionRegistry()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    registry.register({
      ...extension('pack.failure'),
      supports: () => { throw new Error('supports failed') },
    })
    const healthy = extension('pack.healthy')
    registry.register(healthy)
    expect(registry.providersFor(context())).toEqual([healthy])
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })
})

describe('EmbeddingAndLoraCompletionProvider', () => {
  const provider = new EmbeddingAndLoraCompletionProvider({
    embeddings: ['cats', 'castle', 'dogs'],
    loras: ['cinematic', 'portrait'],
  })

  it('supports both STRING views', () => {
    expect(provider.supports(context())).toBe(true)
    expect(provider.supports(context(false))).toBe(true)
    expect(provider.supports({ ...context(), spec: { widgetType: 'INT', options: { multiline: true } } })).toBe(false)
  })

  it('completes embedding tokens from the caret back to whitespace', () => {
    const text = 'prompt embedding:ca suffix'
    expect(provider.complete({
      ...context(), text, caret: 19, trigger: 'a', signal: new AbortController().signal,
    })).toEqual([
      { id: 'embedding:cats', label: 'embedding:cats', detail: 'Embedding', replacement: { start: 7, end: 19, text: 'embedding:cats' } },
      { id: 'embedding:castle', label: 'embedding:castle', detail: 'Embedding', replacement: { start: 7, end: 19, text: 'embedding:castle' } },
    ])
    const compatibilityText = 'embedding:\uff23A'
    expect(provider.complete({
      ...context(), text: compatibilityText, caret: compatibilityText.length, trigger: 'A', signal: new AbortController().signal,
    })).toEqual([
      { id: 'embedding:cats', label: 'embedding:cats', detail: 'Embedding', replacement: { start: 0, end: 12, text: 'embedding:cats' } },
      { id: 'embedding:castle', label: 'embedding:castle', detail: 'Embedding', replacement: { start: 0, end: 12, text: 'embedding:castle' } },
    ])
  })

  it('completes LoRA tokens and stops scanning at newlines', () => {
    const text = 'prompt\n<lora:ci'
    expect(provider.complete({
      ...context(), text, caret: text.length, trigger: 'i', signal: new AbortController().signal,
    })).toEqual([
      { id: 'lora:cinematic', label: '<lora:cinematic:1.0>', detail: 'LoRA', replacement: { start: 7, end: 15, text: '<lora:cinematic:1.0>' } },
    ])
  })

  it('returns no completions for unrelated or aborted requests', () => {
    const controller = new AbortController()
    controller.abort()
    expect(provider.complete({ ...context(), text: 'embedding:c', caret: 11, trigger: 'c', signal: controller.signal })).toEqual([])
    expect(provider.complete({ ...context(), text: 'plain', caret: 5, trigger: 'n', signal: new AbortController().signal })).toEqual([])
  })
})

describe('SchemaTextCompletionProvider', () => {
  const provider = new SchemaTextCompletionProvider()
  const schemaContext: TextWidgetEditorContext = {
    ...context(false),
    inputFamilyMembers: { values: ['a', 'b'] },
    spec: {
      widgetType: 'STRING',
      options: { multiline: false },
      textCompletions: {
        items: [
          { value: 'sin', label: 'sin()', insertText: 'sin()', detail: 'Function', kind: 'identifier' },
          { value: '**', label: '**', insertText: '**', detail: 'Operator', kind: 'operator' },
        ],
        inputFamilies: ['values'],
      },
    },
  }

  it('supports only STRING widgets with schema completion metadata', () => {
    expect(provider.supports(schemaContext)).toBe(true)
    expect(provider.supports(context(false))).toBe(false)
    expect(provider.supports({ ...schemaContext, spec: { ...schemaContext.spec, widgetType: 'INT' } })).toBe(false)
  })

  it('replaces the complete identifier token around a middle caret', () => {
    expect(provider.complete({
      ...schemaContext,
      text: 'siSuffix + a',
      caret: 2,
      trigger: 'i',
      signal: new AbortController().signal,
    })).toEqual([{
      id: 'schema:identifier:sin:0',
      label: 'sin()',
      detail: 'Function',
      replacement: { start: 0, end: 8, text: 'sin()' },
    }])
  })

  it('filters operators by their token range and includes live family members', () => {
    expect(provider.complete({
      ...schemaContext,
      text: 'a *+ b',
      caret: 3,
      trigger: '*',
      signal: new AbortController().signal,
    })).toEqual([{
      id: 'schema:operator:**:1',
      label: '**',
      detail: 'Operator',
      replacement: { start: 2, end: 4, text: '**' },
    }])
    expect(provider.complete({
      ...schemaContext,
      text: 'b',
      caret: 1,
      trigger: 'b',
      signal: new AbortController().signal,
    })).toContainEqual({
      id: 'schema:identifier:b:3',
      label: 'b',
      detail: 'Input',
      replacement: { start: 0, end: 1, text: 'b' },
    })
  })

  it('returns no candidates after cancellation', () => {
    const controller = new AbortController()
    controller.abort()
    expect(provider.complete({
      ...schemaContext,
      text: 's',
      caret: 1,
      trigger: 's',
      signal: controller.signal,
    })).toEqual([])
  })
})

describe('LiveEmbeddingAndLoraInventoryProvider', () => {
  const catalogs: Readonly<Record<string, readonly string[]>> = {
    '/api/choices/comfy.files.embeddings': ['cats', 'castle', 'dogs'],
    '/api/choices/comfy.files.loras': ['\uff23inematic', 'portrait'],
  }
  const source = {
    choices: vi.fn(async (route: '/api/choices/comfy.files.embeddings' | '/api/choices/comfy.files.loras') => catalogs[route] ?? []),
  }
  const scoped = (
    choiceSource: TextCompletionChoiceSource,
    isCurrent: () => boolean = () => true,
  ) => ({ capture: () => ({ id: 'tab-1/backend-1', source: choiceSource, isCurrent }) })

  it('loads lazily and returns immutable typed embedding inventory with filter and rank inputs', async () => {
    source.choices.mockClear()
    const provider = new LiveEmbeddingAndLoraInventoryProvider(scoped(source))
    expect(source.choices).not.toHaveBeenCalled()
    const text = 'prompt embedding:ca suffix'
    const request = provider.load({ text, caret: 19, signal: new AbortController().signal })
    expect(request?.loading).toEqual({ status: 'loading', scopeId: 'tab-1/backend-1', query: 'ca' })
    expect(Object.isFrozen(request?.loading)).toBe(true)
    const settled = await request?.settled
    expect(settled).toEqual({
      status: 'ready',
      scopeId: 'tab-1/backend-1',
      query: 'ca',
      items: [
        {
          completion: { id: 'embedding:cats', label: 'embedding:cats', detail: 'Embedding', replacement: { start: 7, end: 19, text: 'embedding:cats' } },
          filterText: 'cats', sourceOrder: 0,
        },
        {
          completion: { id: 'embedding:castle', label: 'embedding:castle', detail: 'Embedding', replacement: { start: 7, end: 19, text: 'embedding:castle' } },
          filterText: 'castle', sourceOrder: 1,
        },
        {
          completion: { id: 'embedding:dogs', label: 'embedding:dogs', detail: 'Embedding', replacement: { start: 7, end: 19, text: 'embedding:dogs' } },
          filterText: 'dogs', sourceOrder: 2,
        },
      ],
    })
    expect(Object.isFrozen(settled)).toBe(true)
    expect(settled?.status === 'ready' && Object.isFrozen(settled.items)).toBe(true)
    expect(source.choices).toHaveBeenLastCalledWith('/api/choices/comfy.files.embeddings', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }))
  })

  it('normalizes filter text, preserves replacement text, and forwards refresh', async () => {
    const provider = new LiveEmbeddingAndLoraInventoryProvider(scoped(source))
    const text = 'prompt\n<lora:\uff23I'
    const controller = new AbortController()
    const settled = await provider.load({ text, caret: text.length, signal: controller.signal, refresh: true })?.settled
    expect(settled?.status).toBe('ready')
    if (settled?.status !== 'ready') throw new Error('expected ready inventory')
    expect(settled.query).toBe('ci')
    expect(settled.items[0]).toEqual({
      completion: {
        id: 'lora:\uff23inematic', label: '<lora:\uff23inematic:1.0>', detail: 'LoRA',
        replacement: { start: 7, end: 15, text: '<lora:\uff23inematic:1.0>' },
      },
      filterText: 'cinematic', sourceOrder: 0,
    })
    expect(source.choices).toHaveBeenLastCalledWith('/api/choices/comfy.files.loras', {
      signal: controller.signal,
      refresh: true,
    })
  })

  it('returns explicit empty and error states without stale fallback', async () => {
    const failure = new Error('inventory unavailable')
    const changingSource = {
      choices: vi.fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(failure),
    }
    const provider = new LiveEmbeddingAndLoraInventoryProvider(scoped(changingSource))
    await expect(provider.load({
      text: 'embedding:c', caret: 11, signal: new AbortController().signal,
    })?.settled).resolves.toEqual({ status: 'empty', scopeId: 'tab-1/backend-1', query: 'c' })
    await expect(provider.load({
      text: 'embedding:c', caret: 11, signal: new AbortController().signal,
    })?.settled).resolves.toEqual({ status: 'error', scopeId: 'tab-1/backend-1', query: 'c', message: failure.message })
  })

  it('does not capture inventory for unrelated or pre-aborted requests', () => {
    const scopes = { capture: vi.fn(() => ({ id: 'unused', source, isCurrent: () => true })) }
    const provider = new LiveEmbeddingAndLoraInventoryProvider(scopes)
    const controller = new AbortController()
    controller.abort()
    expect(provider.load({ text: 'embedding:c', caret: 11, signal: controller.signal })).toBeUndefined()
    expect(provider.load({ text: 'plain', caret: 5, signal: new AbortController().signal })).toBeUndefined()
    expect(scopes.capture).not.toHaveBeenCalled()
  })

  it('revalidates an opaque scope id after publication', () => {
    let current = true
    const provider = new LiveEmbeddingAndLoraInventoryProvider(scoped(source, () => current))
    expect(provider.isScopeCurrent('tab-1/backend-1')).toBe(true)
    expect(provider.isScopeCurrent('tab-1/backend-2')).toBe(false)
    current = false
    expect(provider.isScopeCurrent('tab-1/backend-1')).toBe(false)
  })

  it('refuses cancelled, superseded, and changed-scope results', async () => {
    const resolvers: ((names: readonly string[]) => void)[] = []
    let current = true
    const delayedSource = {
      choices: vi.fn(() => new Promise<readonly string[]>((resolve) => resolvers.push(resolve))),
    }
    const provider = new LiveEmbeddingAndLoraInventoryProvider(scoped(delayedSource, () => current))
    const cancelled = new AbortController()
    const cancelledResult = provider.load({ text: 'embedding:c', caret: 11, signal: cancelled.signal })!.settled
    cancelled.abort()
    resolvers[0]!(['cats'])
    await expect(cancelledResult).resolves.toBeUndefined()

    const old = provider.load({ text: 'embedding:c', caret: 11, signal: new AbortController().signal })!.settled
    const fresh = provider.load({ text: 'embedding:d', caret: 11, signal: new AbortController().signal })!.settled
    resolvers[1]!(['cats'])
    resolvers[2]!(['dogs'])
    await expect(old).resolves.toBeUndefined()
    await expect(fresh).resolves.toMatchObject({ status: 'ready', query: 'd' })

    const invalidated = provider.load({ text: 'embedding:c', caret: 11, signal: new AbortController().signal })!.settled
    expect(provider.load({ text: 'plain', caret: 5, signal: new AbortController().signal })).toBeUndefined()
    resolvers[3]!(['cats'])
    await expect(invalidated).resolves.toBeUndefined()

    const changed = provider.load({ text: '<lora:p', caret: 7, signal: new AbortController().signal })!.settled
    current = false
    resolvers[4]!(['portrait'])
    await expect(changed).resolves.toBeUndefined()
  })
})

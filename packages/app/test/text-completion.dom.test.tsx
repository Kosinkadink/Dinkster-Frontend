// @vitest-environment happy-dom

import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTextWidgetEditorExtensionRegistry,
  LiveEmbeddingAndLoraInventoryProvider,
  type TextCompletion,
  type TextWidgetEditorExtension,
} from '@dinkster/widgets'
import type { AppState, Tab } from '../src/app-state.js'
import { WidgetEditor, type WidgetEditorState } from '../src/WidgetEditor.js'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const completion = (
  id: string,
  label: string,
  start: number,
  end: number,
  text: string,
): TextCompletion => ({ id, label, replacement: { start, end, text } })

function mountEditor(
  extensions: readonly TextWidgetEditorExtension[],
  liveEmbeddingAndLoraInventory = new LiveEmbeddingAndLoraInventoryProvider({ capture: () => undefined }),
  edOverrides: Partial<WidgetEditorState> = {},
) {
  const root = document.createElement('div')
  document.body.append(root)
  const textEditorExtensionRegistry = createTextWidgetEditorExtensionRegistry()
  const disposers = extensions.map((extension) => textEditorExtensionRegistry.register(extension))
  const store = {
    revision: 0,
    doc: {
      graphs: {
        g0: { nodes: { n0: { type: 'comfy.CLIPTextEncode', values: { text: '' } } } },
      },
    },
  }
  const tab = { store } as unknown as Tab
  const dispatchTo = vi.fn((_tab: Tab, _invocation: unknown) => {
    store.revision += 1
    return { ok: true, diagnostics: [] }
  })
  const app = {
    backendForTab: () => ({ protocol: 'v1' }),
    dispatchTo,
    liveEmbeddingAndLoraInventory,
    textEditorExtensionRegistry,
    widgetRegistry: { kind: () => undefined },
    widgetRegistryForTab: () => app.widgetRegistry,
  } as unknown as AppState
  const ed: WidgetEditorState = {
    tab,
    graphId: 'g0',
    target: { kind: 'input', nodeId: 'n0', valueKey: 'text' },
    label: 'Text',
    spec: { widgetType: 'STRING', options: { multiline: true } },
    multiline: true,
    rect: { x: 20, y: 20, width: 220, height: 90 },
    initial: '',
    ...edOverrides,
  }
  const [open, setOpen] = createSignal(true)
  const unmount = render(() => (
    <Show when={open()}>
      <WidgetEditor
        app={app}
        ed={ed}
        viewport={() => ({ x: 0, y: 0, scale: 1 })}
        onClose={() => setOpen(false)}
      />
    </Show>
  ), root)
  const textarea = root.querySelector<HTMLInputElement | HTMLTextAreaElement>('textarea, input')!
  const input = (value: string, caret = value.length) => {
    textarea.value = value
    textarea.setSelectionRange(caret, caret)
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: value.at(caret - 1) ?? null }))
  }
  const key = (value: string, options: KeyboardEventInit = {}) => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }))
  }
  const flush = async () => {
    await Promise.resolve()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
  }
  return { root, textarea, input, key, flush, store, dispatchTo, disposers, unmount }
}

const staticExtension = (items: readonly TextCompletion[]): TextWidgetEditorExtension => ({
  id: 'test.static',
  supports: () => true,
  complete: () => items,
})

describe('multiline text suggestion surface', () => {
  it('loads live embedding inventory without a static extension and applies its exact replacement', async () => {
    let resolve!: (names: readonly string[]) => void
    const choices = vi.fn(() => new Promise<readonly string[]>((done) => { resolve = done }))
    const inventory = new LiveEmbeddingAndLoraInventoryProvider({
      capture: () => ({ id: 'tab:backend', source: { choices }, isCurrent: () => true }),
    })
    const mounted = mountEditor([], inventory)

    mounted.input('prefix embedding:ca suffix', 19)
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading suggestions...')
    expect(choices).toHaveBeenCalledWith('/api/choices/comfy.files.embeddings', {
      signal: expect.any(AbortSignal),
    })
    resolve(['castle', 'cats'])
    await mounted.flush()

    expect(document.querySelectorAll('[data-testid="suggestion-option"]')).toHaveLength(2)
    expect(document.querySelector('[data-testid="suggestion-option"]')?.textContent).toContain('embedding:castle')
    mounted.key('Enter')
    expect(mounted.textarea.value).toBe('prefix embedding:castle suffix')
    expect(mounted.textarea.selectionStart).toBe(23)
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('refuses a published live completion after its tab or backend scope changes', async () => {
    let current = true
    const inventory = new LiveEmbeddingAndLoraInventoryProvider({
      capture: () => ({
        id: 'tab:backend',
        source: { choices: async () => ['cats'] },
        isCurrent: () => current,
      }),
    })
    const mounted = mountEditor([], inventory)

    mounted.input('embedding:ca')
    await mounted.flush()
    expect(document.querySelector('[data-testid="suggestion-option"]')).not.toBeNull()
    current = false
    mounted.key('Enter')
    expect(mounted.textarea.value).toBe('embedding:ca')
    expect(document.querySelector('[data-testid="suggestion-surface"]')).toBeNull()
    mounted.unmount()
  })

  it('gives recognized live tokens precedence and retains extension fallback for other text', async () => {
    const supports = vi.fn(() => true)
    const complete = vi.fn(() => [completion('extension', 'Extension result', 0, 5, 'extension')])
    const extension: TextWidgetEditorExtension = {
      id: 'test.extension',
      supports,
      complete,
    }
    const inventory = new LiveEmbeddingAndLoraInventoryProvider({
      capture: () => ({
        id: 'tab:backend',
        source: { choices: async () => ['cats'] },
        isCurrent: () => true,
      }),
    })
    const mounted = mountEditor([extension], inventory)

    mounted.input('embedding:ca')
    await mounted.flush()
    expect(document.querySelector('[data-testid="suggestion-option"]')?.textContent).toContain('embedding:cats')
    expect(supports).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    mounted.key('Enter')
    expect(mounted.textarea.value).toBe('embedding:cats')
    expect(supports).not.toHaveBeenCalled()

    mounted.input('plain')
    await mounted.flush()
    expect(supports).toHaveBeenCalledTimes(2)
    expect(complete).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-testid="suggestion-option"]')?.textContent).toContain('Extension result')
    mounted.unmount()
  })

  it('aborts and dismisses live inventory when the caret leaves a recognized token', async () => {
    let signal!: AbortSignal
    let resolve!: (names: readonly string[]) => void
    const inventory = new LiveEmbeddingAndLoraInventoryProvider({
      capture: () => ({
        id: 'tab:backend',
        source: {
          choices: (_route, options) => {
            signal = options.signal
            return new Promise<readonly string[]>((done) => { resolve = done })
          },
        },
        isCurrent: () => true,
      }),
    })
    const mounted = mountEditor([], inventory)

    mounted.input('embedding:ca')
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading suggestions...')
    mounted.input('ordinary text')
    expect(signal.aborted).toBe(true)
    expect(document.querySelector('[data-testid="suggestion-surface"]')).toBeNull()
    resolve(['cats'])
    await mounted.flush()
    expect(document.querySelector('[data-testid="suggestion-surface"]')).toBeNull()
    mounted.unmount()
  })

  it('opens for matching completions and applies the replacement range at the caret', async () => {
    const mounted = mountEditor([
      staticExtension([completion('embed-cats', 'embedding:cats', 7, 19, 'embedding:cats')]),
    ])
    mounted.input('prefix embedding:ca suffix', 19)
    await mounted.flush()

    const surface = document.querySelector('[data-testid="suggestion-surface"]')
    const option = document.querySelector('[data-testid="suggestion-option"]')
    expect(surface).not.toBeNull()
    expect(option?.textContent).toContain('embedding:cats')
    expect(mounted.textarea.getAttribute('aria-controls')).toBe(surface?.querySelector('[role="listbox"]')?.id)
    expect(mounted.textarea.getAttribute('aria-activedescendant')).toBe(option?.id)
    expect(surface?.querySelector('[role="status"]')?.textContent).toContain('1 suggestion')
    mounted.key('Tab')
    expect(mounted.textarea.value).toBe('prefix embedding:cats suffix')
    expect(mounted.textarea.selectionStart).toBe(21)
    expect(mounted.textarea.selectionEnd).toBe(21)
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('closes on Escape without mutating the draft or committing', async () => {
    const mounted = mountEditor([staticExtension([completion('a', 'A', 0, 1, 'accepted')])])
    mounted.input('draft')
    await mounted.flush()
    mounted.key('Escape')
    await mounted.flush()
    expect(document.querySelector('[data-testid="suggestion-surface"]')).toBeNull()
    expect(mounted.textarea.value).toBe('draft')
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(mounted.textarea)
    mounted.unmount()
  })

  it.each(['Tab', 'Enter'] as const)('accepts the highlighted completion with %s', async (key) => {
    const mounted = mountEditor([staticExtension([
      completion('a', 'First', 0, 1, 'first'),
      completion('b', 'Second', 0, 1, 'second'),
    ])])
    mounted.input('x')
    await mounted.flush()
    mounted.key('ArrowDown')
    mounted.key(key)
    expect(mounted.textarea.value).toBe('second')
    expect(document.querySelector('[data-testid="suggestion-surface"]')).toBeNull()
    mounted.unmount()
  })

  it('uses ArrowUp and ArrowDown to wrap the highlighted completion', async () => {
    const mounted = mountEditor([staticExtension([
      completion('a', 'First', 0, 1, 'first'),
      completion('b', 'Second', 0, 1, 'second'),
    ])])
    mounted.input('x')
    await mounted.flush()
    mounted.key('ArrowUp')
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain('Second')
    mounted.key('ArrowDown')
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain('First')
    mounted.unmount()
  })

  it('ignores completion keyboard handling while an IME composition is active', async () => {
    const mounted = mountEditor([staticExtension([completion('a', 'A', 0, 1, 'accepted')])])
    mounted.input('x')
    await mounted.flush()
    mounted.key('Tab', { isComposing: true })
    expect(mounted.textarea.value).toBe('x')
    expect(document.querySelector('[data-testid="suggestion-surface"]')).not.toBeNull()
    mounted.unmount()
  })

  it('discards stale async resolutions after a newer edit', async () => {
    const resolvers: ((items: readonly TextCompletion[]) => void)[] = []
    const extension: TextWidgetEditorExtension = {
      id: 'test.async',
      supports: () => true,
      complete: () => new Promise((resolve) => resolvers.push(resolve)),
    }
    const mounted = mountEditor([extension])
    mounted.input('a')
    mounted.input('ab')
    resolvers[1]!([completion('new', 'New', 0, 2, 'new')])
    await mounted.flush()
    expect(document.querySelector('[data-testid="suggestion-option"]')?.textContent).toContain('New')
    resolvers[0]!([completion('old', 'Old', 0, 1, 'old')])
    await mounted.flush()
    expect(document.body.textContent).not.toContain('Old')
    mounted.unmount()
  })

  it('replaces published results with an accessible loading state while a request is pending', async () => {
    let calls = 0
    const mounted = mountEditor([{
      id: 'test.requery',
      supports: () => true,
      complete: () => {
        calls += 1
        return calls === 1
          ? [completion('first', 'First result', 0, 1, 'first')]
          : new Promise<readonly TextCompletion[]>(() => {})
      },
    }])
    mounted.input('x')
    await mounted.flush()
    expect(document.querySelector('[data-testid="suggestion-surface"]')).not.toBeNull()
    mounted.input('xy')
    const surface = document.querySelector('[data-testid="suggestion-surface"]')
    expect(surface?.querySelector('[role="listbox"]')?.getAttribute('aria-busy')).toBe('true')
    expect(surface?.querySelector('[role="status"]')?.textContent).toContain('Loading suggestions...')
    expect(surface?.querySelectorAll('[role="option"]')).toHaveLength(0)
    mounted.key('Tab')
    expect(mounted.textarea.value).toBe('xy')
    mounted.unmount()
  })

  it('dismisses a pending state with Escape and restores the unchanged textarea', async () => {
    const mounted = mountEditor([{
      id: 'test.pending',
      supports: () => true,
      complete: () => new Promise<readonly TextCompletion[]>(() => {}),
    }])
    mounted.input('draft')
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading suggestions...')
    mounted.key('Escape')
    await mounted.flush()
    expect(document.querySelector('[data-testid="suggestion-surface"]')).toBeNull()
    expect(mounted.textarea.value).toBe('draft')
    expect(document.activeElement).toBe(mounted.textarea)
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('discards an async resolution after its provider is disposed', async () => {
    let resolve!: (items: readonly TextCompletion[]) => void
    const mounted = mountEditor([{
      id: 'test.disposed',
      supports: () => true,
      complete: () => new Promise((done) => { resolve = done }),
    }])
    mounted.input('x')
    mounted.disposers[0]!()
    resolve([completion('late', 'Disposed result', 0, 1, 'late')])
    await mounted.flush()
    expect(document.querySelector('[data-testid="suggestion-surface"]')).toBeNull()
    mounted.unmount()
  })

  it('refuses an already published result after its provider is disposed', async () => {
    const mounted = mountEditor([staticExtension([completion('old', 'Old result', 0, 1, 'old')])])
    mounted.input('x')
    await mounted.flush()
    expect(document.querySelector('[data-testid="suggestion-surface"]')).not.toBeNull()
    mounted.disposers[0]!()
    mounted.key('Tab')
    expect(mounted.textarea.value).toBe('x')
    expect(document.querySelector('[data-testid="suggestion-surface"]')).toBeNull()
    mounted.unmount()
  })

  it('isolates a failing provider and keeps successful provider results', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mounted = mountEditor([
      { id: 'test.failure', supports: () => true, complete: () => { throw new Error('provider failed') } },
      staticExtension([completion('ok', 'Working result', 0, 1, 'ok')]),
    ])
    mounted.input('x')
    await mounted.flush()
    expect(document.querySelector('[data-testid="suggestion-option"]')?.textContent).toContain('Working result')
    expect(error).toHaveBeenCalledOnce()
    mounted.unmount()
  })

  it('keeps acceptance local and advances the document revision exactly once on commit', async () => {
    const mounted = mountEditor([staticExtension([completion('a', 'Accepted', 0, 1, 'accepted')])])
    const before = mounted.store.revision
    mounted.input('x')
    await mounted.flush()
    mounted.key('Tab')
    expect(mounted.store.revision).toBe(before)
    mounted.key('Enter', { ctrlKey: true })
    expect(mounted.store.revision).toBe(before + 1)
    expect(mounted.dispatchTo).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo.mock.calls[0]?.[1]).toMatchObject({
      command: 'text.splice',
      params: { graphId: 'g0', nodeId: 'n0', inputId: 'text', offset: 0, deleteCount: 0, insert: 'accepted' },
    })
    mounted.unmount()
  })
})

describe('text editor views and invalid drafts', () => {
  it('offers and commits completions from the single-line view', async () => {
    const mounted = mountEditor(
      [staticExtension([completion('sine', 'sin', 0, 2, 'sin')])],
      undefined,
      {
        spec: { widgetType: 'STRING', options: { multiline: false } },
        multiline: false,
      },
    )

    expect(mounted.textarea.tagName).toBe('INPUT')
    expect(mounted.root.querySelector('[data-testid="widget-editor"]')?.getAttribute('data-editor-surface')).toBe('popover')
    mounted.input('si')
    await mounted.flush()
    expect(document.querySelector('[data-testid="suggestion-option"]')?.textContent).toContain('sin')
    mounted.key('Tab')
    expect(mounted.textarea.value).toBe('sin')
    mounted.key('Enter')
    expect(mounted.dispatchTo).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo.mock.calls[0]?.[1]).toMatchObject({
      command: 'text.splice',
      params: { graphId: 'g0', nodeId: 'n0', inputId: 'text', offset: 0, deleteCount: 0, insert: 'sin' },
    })
    mounted.unmount()
  })

  it('commits an invalid expression without presenting editor validation', async () => {
    const mounted = mountEditor(
      [{
        id: 'test.expression',
        supports: () => true,
        complete: (request) => {
          if (request.text === 's') return [completion('sin', 'sin()', 0, 1, 'sin(a)')]
          if (request.text === 'a +') return [completion('plus', '+', 2, 3, '+')]
          return []
        },
      }],
    )

    mounted.input('s')
    await mounted.flush()
    expect(mounted.textarea.hasAttribute('aria-invalid')).toBe(false)
    mounted.key('Enter')
    expect(mounted.textarea.value).toBe('sin(a)')
    expect(document.querySelector('[role="alert"]')).toBeNull()

    mounted.input('a +')
    await mounted.flush()
    expect(mounted.textarea.hasAttribute('aria-invalid')).toBe(false)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    mounted.key('Enter', { ctrlKey: true })
    expect(mounted.dispatchTo).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo.mock.calls[0]?.[1]).toMatchObject({
      command: 'text.splice',
      params: { graphId: 'g0', nodeId: 'n0', inputId: 'text', offset: 0, deleteCount: 0, insert: 'a +' },
    })
    expect(document.querySelector('[data-testid="widget-editor"]')).toBeNull()
    mounted.unmount()
  })
})

// @vitest-environment happy-dom

import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState, Tab } from '../src/app-state.js'
import {
  clampComboHighlight,
  COMBO_RENDER_CAP,
  comboMenuEntries,
  comboRenderWindow,
  filterComboOptions,
  scrollComboHighlightIntoView,
} from '../src/combo-search.js'
import { WidgetEditor, type WidgetEditorState } from '../src/WidgetEditor.js'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'

const options = [
  { value: 'dinkster.alpha', label: 'Alpha Model', info: 'Fast baseline', folder: 'Models/Fast' },
  { value: 'dinkster.beta', label: 'BETA Decoder', info: 'Detailed decoder', folder: 'Models/Quality' },
  { value: 'dinkster.gamma', label: 'Gamma Model' },
]

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const scrollSpy = () => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: () => {},
  })
  return vi.spyOn(Element.prototype, 'scrollIntoView')
}

const activeOptionRoot = (): ParentNode => {
  const root = document.createElement('div')
  const option = document.createElement('div')
  option.className = 'combo-menu-entry combo-option active'
  root.append(option)
  return root
}

const flushMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await new Promise<void>((resolve) => queueMicrotask(resolve))
}

const mountEditor = (ed: WidgetEditorState, appOverrides: Partial<AppState> = {}) => {
  const root = document.createElement('div')
  const outside = document.createElement('button')
  document.body.append(root)
  document.body.append(outside)
  const dispatchTo = vi.fn()
  const onClose = vi.fn()
  const [open, setOpen] = createSignal(true)
  const app = {
    backendForTab: () => ({ protocol: 'v1', scopedClient: { remoteChoiceAuthority: () => 0 } }),
    backendsTick: { get: () => 0, subscribe: () => () => {} },
    dispatchTo,
    widgetValueMutationGeneration: () => 0,
    widgetRegistry: { kind: () => undefined },
    widgetRegistryForTab: () => app.widgetRegistry,
    ...appOverrides,
  } as unknown as AppState
  const unmount = render(() => (
    <Show when={open()}>
      <WidgetEditor
        app={app}
        ed={ed}
        viewport={() => ({ x: 0, y: 0, scale: 1 })}
        onClose={() => { onClose(); setOpen(false) }}
      />
    </Show>
  ), root)
  return { root, outside, dispatchTo, onClose, unmount }
}

const optionLabels = (root: ParentNode): string[] =>
  [...root.querySelectorAll<HTMLElement>('.combo-option')].map((row) => row.textContent ?? '')

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const editorState = (spec: WidgetEditorState['spec'], initial: WidgetEditorState['initial']): WidgetEditorState => ({
  tab: {} as Tab,
  graphId: 'g0',
  target: { kind: 'input', nodeId: 'n0', valueKey: 'choice' },
  label: 'Choice',
  spec,
  multiline: false,
  rect: { x: 20, y: 20, width: 180, height: 24 },
  initial,
})

describe('combo search', () => {
  it('MULTI_COMBO preserves order and duplicate multiplicity and commits empty arrays', async () => {
    const mounted = mountEditor(editorState({
      widgetType: 'MULTI_COMBO',
      options: { options: ['alpha', 'beta'], chip: true },
    }, ['beta', 'alpha', 'beta']))
    await flushMicrotasks()

    expect([...mounted.root.querySelectorAll<HTMLElement>('[data-testid="multi-combo-value"]')].map((row) => row.textContent)).toEqual(['beta', 'alpha', 'beta'])
    expect(mounted.root.querySelector('[data-testid="multi-combo-dropdown"]')?.getAttribute('data-chip')).toBe('true')
    mounted.root.querySelectorAll<HTMLElement>('[data-testid="multi-combo-option"]')[1]!.click()
    expect([...mounted.root.querySelectorAll<HTMLElement>('[data-testid="multi-combo-value"]')].map((row) => row.textContent)).toEqual(['beta', 'alpha', 'beta', 'beta'])
    mounted.root.querySelector<HTMLElement>('[data-testid="multi-combo-clear"]')!.click()
    mounted.root.querySelector<HTMLElement>('[data-testid="multi-combo-apply"]')!.click()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: 'node.setValue', params: expect.objectContaining({ value: [] }),
    }))
    mounted.unmount()
  })

  it('MULTI_COMBO keeps static OOV values visible and marks remote snapshot misses as warnings', async () => {
    const staticMounted = mountEditor(editorState({
      widgetType: 'MULTI_COMBO', options: { options: ['alpha'] },
    }, ['outside']))
    await flushMicrotasks()
    expect(staticMounted.root.querySelector('[data-testid="multi-combo-value"]')?.getAttribute('data-oov')).toBe('error')
    staticMounted.unmount()

    const request = deferred<readonly string[]>()
    const remoteChoices = vi.fn(() => request.promise)
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const remoteMounted = mountEditor(editorState({
      widgetType: 'MULTI_COMBO', options: {}, remote: { route: '/api/choices/providers' },
    }, ['outside']), {
      backendForTab: () => ({ scopedClient }),
    } as unknown as Partial<AppState>)
    request.resolve(['remote-a'])
    await flushMicrotasks()
    await flushMicrotasks()
    expect(remoteMounted.root.querySelector('[data-testid="multi-combo-dropdown"]')?.getAttribute('data-remote')).toBe('ready')
    expect(remoteMounted.root.querySelector('[data-testid="multi-combo-value"]')?.getAttribute('data-oov')).toBe('warning')
    expect(remoteChoices).toHaveBeenCalledWith('/api/choices/providers', expect.objectContaining({ refresh: false }))
    remoteMounted.unmount()
  })

  it('MULTI_COMBO commits edits while retaining an authoritative static OOV value', async () => {
    const widgetRegistry = createWidgetRegistry()
    registerCoreWidgets(widgetRegistrationDoors(widgetRegistry))
    const mounted = mountEditor(editorState({
      widgetType: 'MULTI_COMBO', options: { options: ['alpha'] },
    }, ['outside']), { widgetRegistry } as Partial<AppState>)
    await flushMicrotasks()
    mounted.root.querySelector<HTMLElement>('[data-testid="multi-combo-option"]')!.click()
    mounted.root.querySelector<HTMLElement>('[data-testid="multi-combo-apply"]')!.click()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: 'node.setValue', params: expect.objectContaining({ value: ['outside', 'alpha'] }),
    }))
    expect(mounted.onClose).toHaveBeenCalledOnce()
    mounted.unmount()
  })

  it('MULTI_COMBO refresh policy commits one list and closes the synchronized editor', async () => {
    const initial = deferred<readonly string[]>()
    const refresh = deferred<readonly string[]>()
    const remoteChoices = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise)
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const tab = {
      store: { doc: { graphs: { g0: { nodes: { n0: { values: { choice: ['old'] } } } } } } },
    } as unknown as Tab
    const mounted = mountEditor({ ...editorState({
      widgetType: 'MULTI_COMBO', options: {},
      remote: { route: '/api/choices/models', refreshButton: true, controlAfterRefresh: 'last' },
    }, ['old']), tab }, { backendForTab: () => ({ scopedClient }) } as unknown as Partial<AppState>)
    initial.resolve(['old'])
    await flushMicrotasks()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="multi-combo-refresh"]')!.click()
    refresh.resolve(['new-a', 'new-b'])
    await flushMicrotasks()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(tab, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n0', inputId: 'choice', value: ['new-b'] },
    })
    expect(mounted.onClose).toHaveBeenCalledOnce()
    mounted.unmount()
  })

  it('MULTI_COMBO refresh policy preserves an intervening local draft edit', async () => {
    const initial = deferred<readonly string[]>()
    const refresh = deferred<readonly string[]>()
    const remoteChoices = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise)
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const tab = {
      store: { doc: { graphs: { g0: { nodes: { n0: { values: { choice: ['old'] } } } } } } },
    } as unknown as Tab
    const mounted = mountEditor({ ...editorState({
      widgetType: 'MULTI_COMBO', options: {},
      remote: { route: '/api/choices/models', refreshButton: true, controlAfterRefresh: 'first' },
    }, ['old']), tab }, { backendForTab: () => ({ scopedClient }) } as unknown as Partial<AppState>)
    initial.resolve(['old', 'draft'])
    await flushMicrotasks()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="multi-combo-refresh"]')!.click()
    mounted.root.querySelectorAll<HTMLButtonElement>('[data-testid="multi-combo-option"]')[1]!.click()
    refresh.resolve(['new-a'])
    await flushMicrotasks()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    expect(mounted.onClose).not.toHaveBeenCalled()
    expect([...mounted.root.querySelectorAll<HTMLElement>('[data-testid="multi-combo-value"]')].map((row) => row.textContent))
      .toEqual(['old', 'draft'])
    mounted.unmount()
  })

  it('MULTI_COMBO refresh policy rejects an edit then exact draft revert', async () => {
    const initial = deferred<readonly string[]>()
    const refresh = deferred<readonly string[]>()
    const remoteChoices = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise)
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const tab = {
      store: { doc: { graphs: { g0: { nodes: { n0: { values: { choice: ['old'] } } } } } } },
    } as unknown as Tab
    const mounted = mountEditor({ ...editorState({
      widgetType: 'MULTI_COMBO', options: {},
      remote: { route: '/api/choices/models', refreshButton: true, controlAfterRefresh: 'first' },
    }, ['old']), tab }, { backendForTab: () => ({ scopedClient }) } as unknown as Partial<AppState>)
    initial.resolve(['draft'])
    await flushMicrotasks()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="multi-combo-refresh"]')!.click()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="multi-combo-option"]')!.click()
    mounted.root.querySelectorAll<HTMLButtonElement>('[data-testid="multi-combo-value"]')[1]!.click()
    refresh.resolve(['new-a'])
    await flushMicrotasks()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    expect(mounted.onClose).not.toHaveBeenCalled()
    expect([...mounted.root.querySelectorAll<HTMLElement>('[data-testid="multi-combo-value"]')].map((row) => row.textContent))
      .toEqual(['old'])
    mounted.unmount()
  })

  it('preserves option order for an empty query', () => {
    expect(filterComboOptions(options, '')).toBe(options)
  })

  it('filters searchable text by a case-insensitive substring', () => {
    expect(filterComboOptions(options, ' MODEL ')).toEqual(options)
    expect(filterComboOptions(options, 'beta')).toEqual([options[1]])
  })

  it('filters presentation metadata and canonical values without changing results', () => {
    expect(filterComboOptions(options, 'baseline')).toEqual([options[0]])
    expect(filterComboOptions(options, 'quality')).toEqual([options[1]])
    expect(filterComboOptions(options, 'dinkster.gamma')).toEqual([options[2]])
  })

  it('exposes direct folder children and global leaf matches while searching', () => {
    expect(comboMenuEntries(options, [], '')).toEqual([
      { kind: 'folder', label: 'Models', path: ['Models'] },
      { kind: 'option', option: options[2] },
    ])
    expect(comboMenuEntries(options, ['Models'], '')).toEqual([
      { kind: 'folder', label: 'Fast', path: ['Models', 'Fast'] },
      { kind: 'folder', label: 'Quality', path: ['Models', 'Quality'] },
    ])
    expect(comboMenuEntries(options, ['Models', 'Fast'], '')).toEqual([
      { kind: 'option', option: options[0] },
    ])
    expect(comboMenuEntries(options, ['Models'], 'gamma')).toEqual([
      { kind: 'option', option: options[2] },
    ])
  })

  it('keeps keyboard highlights inside the filtered list', () => {
    expect(clampComboHighlight(4, 2)).toBe(1)
    expect(clampComboHighlight(-1, 2)).toBe(0)
    expect(clampComboHighlight(4, 0)).toBe(0)
  })

  it('handles empty options and filters with no matches', () => {
    expect(filterComboOptions([], '')).toEqual([])
    const filtered = filterComboOptions(options, 'not present')
    expect(filtered).toEqual([])
    expect(clampComboHighlight(2, filtered.length)).toBe(0)
  })

  it('matches labels regardless of query or label casing', () => {
    expect(filterComboOptions(options, 'BeTa')).toEqual([options[1]])
    expect(filterComboOptions(options, 'decoder')).toEqual([options[1]])
  })

  it('does not scroll a pointer-highlighted option into view', () => {
    const scrollIntoView = scrollSpy()
    const root = activeOptionRoot()

    scrollComboHighlightIntoView(root, 'pointer')

    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('scrolls a keyboard-highlighted option into view', () => {
    const scrollIntoView = scrollSpy()
    const root = activeOptionRoot()

    scrollComboHighlightIntoView(root, 'keyboard')

    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('scrolls a programmatically highlighted option into view', () => {
    const scrollIntoView = scrollSpy()

    scrollComboHighlightIntoView(activeOptionRoot(), 'programmatic')

    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('renders source-gated scrolling through WidgetEditor interactions', async () => {
    const scrollIntoView = scrollSpy()
    const values = Array.from({ length: 30 }, (_, index) => `option-${index}`)
    const ed: WidgetEditorState = {
      tab: {} as Tab,
      graphId: 'g0',
      target: { kind: 'input', nodeId: 'n0', valueKey: 'choice' },
      label: 'Choice',
      spec: { widgetType: 'COMBO', options: { options: values } },
      multiline: false,
      rect: { x: 20, y: 20, width: 180, height: 24 },
      initial: values[20],
    }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <WidgetEditor
        app={{
          backendForTab: () => ({ protocol: 'v1', scopedClient: { remoteChoiceAuthority: () => 0 } }),
          backendsTick: { get: () => 0, subscribe: () => () => {} },
        } as unknown as AppState}
        ed={ed}
        viewport={() => ({ x: 0, y: 0, scale: 1 })}
        onClose={() => {}}
      />
    ), root)

    await flushMicrotasks()
    expect(root.querySelector('.combo-option.active')?.textContent).toBe(values[20])
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    scrollIntoView.mockClear()
    const option = root.querySelectorAll<HTMLElement>('.combo-option')[2]!
    option.dispatchEvent(new MouseEvent('mouseenter'))
    await flushMicrotasks()
    expect(option.classList.contains('active')).toBe(true)
    expect(scrollIntoView).not.toHaveBeenCalled()

    const search = root.querySelector<HTMLInputElement>('[data-testid="combo-search"]')!
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await flushMicrotasks()
    expect(root.querySelector('.combo-option.active')?.textContent).toBe(values.at(-1))
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    unmount()
  })

  it('commits a static option selected in the DOM and preserves a numeric value', async () => {
    const mounted = mountEditor(editorState(
      { widgetType: 'COMBO', options: { options: ['alpha', [7, 'Seven']] } },
      'alpha',
    ))
    await flushMicrotasks()

    const rows = mounted.root.querySelectorAll<HTMLElement>('.combo-option')
    expect([...rows].map((row) => row.textContent)).toEqual(['alpha', 'Seven'])
    rows[1]!.click()

    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: 'node.setValue',
      params: expect.objectContaining({ value: 7 }),
    }))
    expect(typeof mounted.dispatchTo.mock.calls[0]![1].params.value).toBe('number')
    mounted.unmount()
  })

  it('selects a DynamicCombo option on its direct owner', async () => {
    const mounted = mountEditor({
      ...editorState({ widgetType: 'COMBO', options: { options: ['fit', 'crop'] } }, 'fit'),
      target: {
        kind: 'input',
        nodeId: 'resize',
        valueKey: 'choice',
        selector: { construct: 'choice', ancestors: [] },
      },
    })
    await flushMicrotasks()

    mounted.root.querySelectorAll<HTMLButtonElement>('[data-testid="combo-option"]')[1]!.click()

    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), {
      command: 'dynamic.selectOption',
      params: { graphId: 'g0', nodeId: 'resize', construct: 'choice', option: 'crop' },
    })
    mounted.unmount()
  })

  it('selects a DynamicCombo option on a forwarded ancestor occurrence', async () => {
    const mounted = mountEditor({
      ...editorState({ widgetType: 'COMBO', options: { options: ['fit', 'crop'] } }, 'fit'),
      target: {
        kind: 'input',
        nodeId: 'derived-resize',
        valueKey: 'choice',
        selector: {
          construct: 'derived-choice',
          ancestors: [],
          owner: {
            graphId: 'root',
            nodeId: 'wrapper',
            construct: 'forwarded-choice',
            ancestors: [{ construct: 'regions', member: 'left' }],
          },
        },
      },
    })
    await flushMicrotasks()

    mounted.root.querySelectorAll<HTMLButtonElement>('[data-testid="combo-option"]')[1]!.click()

    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), {
      command: 'dynamic.selectOption',
      params: {
        graphId: 'root',
        nodeId: 'wrapper',
        construct: 'forwarded-choice',
        option: 'crop',
        ancestors: [{ construct: 'regions', member: 'left' }],
      },
    })
    mounted.unmount()
  })

  it('renders labels and info, navigates folders, and commits the canonical value', async () => {
    const mounted = mountEditor(editorState({
      widgetType: 'COMBO',
      options: { options: [
        { value: 'dinkster.plain', label: 'plain', info: 'Root option' },
        { value: 'dinkster.euler', label: 'euler', info: 'Euler sampler', folder: 'Solvers/Basic' },
      ] },
    }, 'dinkster.plain'))
    await flushMicrotasks()

    expect(optionLabels(mounted.root)).toEqual(['plainRoot option'])
    expect(mounted.root.querySelector('.combo-option-info')?.textContent).toBe('Root option')
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="combo-folder"]')!.click()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="combo-folder"]')!.click()
    expect(optionLabels(mounted.root)).toEqual(['eulerEuler sampler'])
    expect(mounted.root.querySelector('.combo-option-info')?.textContent).toBe('Euler sampler')
    expect(mounted.root.querySelector('[data-testid="combo-folder-navigation"]')?.textContent).toContain('Solvers / Basic')
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="combo-option"]')!.click()

    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      params: expect.objectContaining({ value: 'dinkster.euler' }),
    }))
    mounted.unmount()
  })

  it('edits input-family labels by stable member id and selects the stable value', async () => {
    const mounted = mountEditor({
      ...editorState({
        widgetType: 'COMBO',
        optionSource: { inputFamily: 'values' },
        options: { options: [
          { value: 'd0', label: 'Default' },
          { value: '\u0000m7', label: 'Background' },
          { value: '\u0000m2', label: 'Subject' },
        ] },
      }, '\u0000m7'),
      target: {
        kind: 'input',
        nodeId: 'route',
        valueKey: 'name',
        inputFamilyOwner: {
          graphId: 'root', nodeId: 'instance', construct: 'branches',
          memberIds: { '\u0000m7': 'm7', '\u0000m2': 'm2' },
        },
      },
    })
    await flushMicrotasks()

    expect(mounted.root.querySelector('[data-testid="input-family-labels"]')?.textContent)
      .toContain('Stable ID: m7')
    expect(mounted.root.querySelector('[data-testid="input-family-label-d0"]')).toBeNull()
    const label = mounted.root.querySelector<HTMLInputElement>('[data-testid="input-family-label-m7"]')!
    label.value = 'Backdrop'
    label.dispatchEvent(new InputEvent('input', { bubbles: true }))
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="input-family-label-apply"]')!.click()

    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), {
      command: 'dynamic.labelMembers',
      params: {
        graphId: 'root', nodeId: 'instance', construct: 'branches',
        labels: { m7: 'Backdrop', m2: 'Subject' },
      },
    })
    mounted.unmount()

    const selection = mountEditor(editorState({
      widgetType: 'COMBO',
      optionSource: { inputFamily: 'values' },
      options: { options: [{ value: 'm7', label: 'Backdrop' }, { value: 'm2', label: 'Subject' }] },
    }, 'm7'))
    await flushMicrotasks()
    selection.root.querySelectorAll<HTMLButtonElement>('[data-testid="combo-option"]')[1]!.click()
    expect(selection.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: 'node.setValue',
      params: expect.objectContaining({ value: 'm2' }),
    }))
    selection.unmount()
  })

  it('rejects duplicate input-family labels before dispatch', async () => {
    const mounted = mountEditor(editorState({
      widgetType: 'COMBO',
      optionSource: { inputFamily: 'values' },
      options: { options: [{ value: 'm0', label: 'First' }, { value: 'm1', label: 'Second' }] },
    }, 'm0'))
    await flushMicrotasks()

    const label = mounted.root.querySelector<HTMLInputElement>('[data-testid="input-family-label-m1"]')!
    label.value = 'First'
    label.dispatchEvent(new InputEvent('input', { bubbles: true }))

    expect(mounted.root.querySelector('[data-testid="input-family-label-error"]')?.textContent)
      .toBe('Duplicate branch labels are not allowed')
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-testid="input-family-label-apply"]')!.disabled).toBe(true)
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="input-family-label-apply"]')!.click()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('opens and backs out of folders from the search keyboard', async () => {
    const mounted = mountEditor(editorState({
      widgetType: 'COMBO',
      options: { options: [{ value: 'dinkster.euler', label: 'euler', folder: 'Solvers' }] },
    }, 'dinkster.euler'))
    await flushMicrotasks()
    const search = mounted.root.querySelector<HTMLInputElement>('[data-testid="combo-search"]')!
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(optionLabels(mounted.root)).toEqual(['euler'])
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
    expect(mounted.root.querySelector('[data-testid="combo-folder"]')?.textContent).toContain('Solvers')
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('MULTI_COMBO displays labels while committing canonical values', async () => {
    const mounted = mountEditor(editorState({
      widgetType: 'MULTI_COMBO',
      options: { options: [{ value: 'dinkster.euler', label: 'euler' }] },
    }, ['dinkster.euler']))
    await flushMicrotasks()
    expect(mounted.root.querySelector('[data-testid="multi-combo-value"]')?.textContent).toBe('euler')
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="multi-combo-option"]')!.click()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="multi-combo-apply"]')!.click()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      params: expect.objectContaining({ value: ['dinkster.euler', 'dinkster.euler'] }),
    }))
    mounted.unmount()
  })

  it('remote COMBO transitions loading static fallback to ready remote replacement', async () => {
    const request = deferred<readonly string[]>()
    const remoteChoices = vi.fn(() => request.promise)
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const mounted = mountEditor(editorState({
      widgetType: 'COMBO',
      options: { options: ['static-fallback'] },
      remote: { route: '/api/choices/models', refreshButton: true },
    }, 'selected-oov'), {
      backendForTab: () => ({ scopedClient }),
      completeComboRefresh: () => {},
    } as unknown as Partial<AppState>)

    expect(optionLabels(mounted.root)).toEqual(['selected-oov', 'static-fallback'])
    expect(mounted.root.querySelector('.combo-status')?.textContent).toContain('loading')
    request.resolve(['remote-b', 'remote-a'])
    await flushMicrotasks()
    expect(optionLabels(mounted.root)).toEqual(['selected-oov', 'remote-b', 'remote-a'])
    expect(remoteChoices).toHaveBeenCalledWith('/api/choices/models', expect.objectContaining({ refresh: false }))
    mounted.unmount()
  })

  it.each([
    ['COMBO', 'filtered', 'combo-search', 'remote-refresh', 'match'],
    ['COMBO', 'unfiltered', 'combo-search', 'remote-refresh', ''],
    ['MULTI_COMBO', 'filtered', 'multi-combo-search', 'multi-combo-refresh', 'match'],
    ['MULTI_COMBO', 'unfiltered', 'multi-combo-search', 'multi-combo-refresh', ''],
  ] as const)('remote %s keeps a valid highlight when %s refresh results shrink', async (widgetType, _kind, searchId, refreshId, query) => {
    const initial = deferred<readonly string[]>()
    const refresh = deferred<readonly string[]>()
    const remoteChoices = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refresh.promise)
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const mounted = mountEditor(editorState({
      widgetType,
      options: {},
      remote: { route: '/api/choices/models', refreshButton: true },
    }, widgetType === 'COMBO' ? 'match-a' : []), {
      backendForTab: () => ({ scopedClient }),
      prepareComboRefresh: () => undefined,
      completeComboRefresh: () => {},
    } as unknown as Partial<AppState>)

    initial.resolve(['match-a', 'match-b', 'match-c', 'match-d'])
    await flushMicrotasks()
    const search = mounted.root.querySelector<HTMLInputElement>(`[data-testid="${searchId}"]`)!
    if (query !== '') {
      search.value = query
      search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    }
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(mounted.root.querySelector('.combo-option.active')?.textContent).toBe('match-d')

    mounted.root.querySelector<HTMLButtonElement>(`[data-testid="${refreshId}"]`)!.click()
    refresh.resolve(['match-a', 'match-b'])
    await flushMicrotasks()

    const active = mounted.root.querySelector<HTMLElement>('.combo-option.active')
    expect(active?.textContent).toBe('match-b')
    expect(active?.getAttribute('aria-selected')).toBe('true')
    mounted.unmount()
  })

  it('remote COMBO refresh failure becomes stale and preserves the last good remote list', async () => {
    const first = deferred<readonly string[]>()
    const refresh = deferred<readonly string[]>()
    const remoteChoices = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(refresh.promise)
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const mounted = mountEditor(editorState({
      widgetType: 'COMBO',
      options: { options: ['static-fallback'] },
      remote: { route: '/api/choices/models', refreshButton: true },
    }, 'remote-a'), {
      backendForTab: () => ({ scopedClient }),
      prepareComboRefresh: () => undefined,
      completeComboRefresh: () => {},
    } as unknown as Partial<AppState>)
    first.resolve(['remote-a', 'remote-b'])
    await flushMicrotasks()

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="remote-refresh"]')!.click()
    refresh.reject(new Error('offline'))
    await flushMicrotasks()
    expect(optionLabels(mounted.root)).toEqual(['remote-a', 'remote-b'])
    expect(mounted.root.querySelector('.combo-status')?.textContent).toContain('stale')
    mounted.unmount()
  })

  it.each([
    ['first', 'new-a'],
    ['last', 'new-c'],
  ] as const)('manual refresh policy %s publishes then applies one CAS value write', async (controlAfterRefresh, expected) => {
    const initial = deferred<readonly string[]>()
    const refresh = deferred<readonly string[]>()
    const remoteChoices = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refresh.promise)
    const completeComboRefresh = vi.fn()
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const tab = {
      store: { doc: { graphs: { g0: { nodes: { n0: { values: { choice: 'old' } } } } } } },
    } as unknown as Tab
    const ed = { ...editorState({
      widgetType: 'COMBO', options: {},
      remote: {
        route: '/api/choices/models', refreshButton: true, controlAfterRefresh,
        timeoutMs: 3210, maxRetries: 1, refreshMs: 99,
      },
    }, 'old'), tab }
    const mounted = mountEditor(ed, {
      backendForTab: () => ({ scopedClient }),
      prepareComboRefresh: vi.fn(), completeComboRefresh,
    } as unknown as Partial<AppState>)
    initial.resolve(['old'])
    await flushMicrotasks()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="remote-refresh"]')!.click()
    refresh.resolve(['new-a', 'new-b', 'new-c'])
    await flushMicrotasks()

    expect(optionLabels(mounted.root)).toEqual(['old', 'new-a', 'new-b', 'new-c'])
    expect(remoteChoices).toHaveBeenLastCalledWith('/api/choices/models', expect.objectContaining({
      refresh: true, timeoutMs: 3210, maxRetries: 1, refreshMs: 99,
    }))
    expect(mounted.dispatchTo).toHaveBeenCalledTimes(1)
    expect(mounted.dispatchTo).toHaveBeenCalledWith(tab, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n0', inputId: 'choice', value: expected },
    })
    expect(completeComboRefresh).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('manual refresh policy preserves an intervening user edit and automatic demand never advances', async () => {
    const initial = deferred<readonly string[]>()
    const refresh = deferred<readonly string[]>()
    const remoteChoices = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refresh.promise)
    const values = { choice: 'old' }
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const tab = {
      store: { doc: { graphs: { g0: { nodes: { n0: { values } } } } } },
    } as unknown as Tab
    const mounted = mountEditor({ ...editorState({
      widgetType: 'COMBO', options: {},
      remote: { route: '/api/choices/models', refreshButton: true, controlAfterRefresh: 'first' },
    }, 'old'), tab }, {
      backendForTab: () => ({ scopedClient }),
      prepareComboRefresh: vi.fn(), completeComboRefresh: vi.fn(),
    } as unknown as Partial<AppState>)
    initial.resolve(['automatic-a', 'automatic-b'])
    await flushMicrotasks()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="remote-refresh"]')!.click()
    values.choice = 'user-edit'
    refresh.resolve(['new-a', 'new-b'])
    await flushMicrotasks()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('manual refresh policy rejects an ABA edit generation even when the value returns', async () => {
    const initial = deferred<readonly string[]>()
    const refresh = deferred<readonly string[]>()
    const remoteChoices = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refresh.promise)
    const values = { choice: 'old' }
    let generation = 0
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const tab = { store: { doc: { graphs: { g0: { nodes: { n0: { values } } } } } } } as unknown as Tab
    const mounted = mountEditor({ ...editorState({
      widgetType: 'COMBO', options: {},
      remote: { route: '/api/choices/models', refreshButton: true, controlAfterRefresh: 'first' },
    }, 'old'), tab }, {
      backendForTab: () => ({ scopedClient }),
      widgetValueMutationGeneration: () => generation,
    } as unknown as Partial<AppState>)
    initial.resolve(['old'])
    await flushMicrotasks()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="remote-refresh"]')!.click()
    values.choice = 'other'
    generation += 1
    values.choice = 'old'
    generation += 1
    refresh.resolve(['new-a'])
    await flushMicrotasks()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('manual refresh policy writes the family owner through materialization in one batch', async () => {
    const remoteChoices = vi.fn()
      .mockResolvedValueOnce(['old'])
      .mockResolvedValueOnce(['new-a'])
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const tab = {
      store: { doc: { graphs: { ownerGraph: { nodes: { owner: { values: { canonical: 'old' } } } } } } },
    } as unknown as Tab
    const base = editorState({
      widgetType: 'COMBO', options: {},
      remote: { route: '/api/choices/models', refreshButton: true, controlAfterRefresh: 'first' },
    }, 'old')
    const mounted = mountEditor({
      ...base, tab,
      target: {
        kind: 'input', nodeId: 'display', valueKey: 'displayed',
        familyOwner: { graphId: 'ownerGraph', nodeId: 'owner', valueKey: 'canonical' },
        materialize: [{ construct: 'family', members: ['m1'] }],
      },
    }, { backendForTab: () => ({ scopedClient }) } as unknown as Partial<AppState>)
    await flushMicrotasks()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="remote-refresh"]')!.click()
    await flushMicrotasks()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(tab, expect.objectContaining({
      command: 'batch',
      params: expect.objectContaining({ invocations: [
        expect.objectContaining({ command: 'dynamic.materialize' }),
        { command: 'node.setValue', params: {
          graphId: 'ownerGraph', nodeId: 'owner', inputId: 'canonical', value: 'new-a',
        } },
      ] }),
    }))
    mounted.unmount()
  })

  it('remote COMBO permanent initial failure is unavailable with fallback and authoritative OOV value', async () => {
    const remoteChoices = vi.fn(async () => { throw new Error('remote choices shape: duplicate string') })
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const mounted = mountEditor(editorState({
      widgetType: 'COMBO',
      options: { options: ['static-fallback'] },
      remote: { route: '/api/choices/models', refreshButton: true },
    }, 'selected-oov'), {
      backendForTab: () => ({ scopedClient }),
    } as unknown as Partial<AppState>)
    await flushMicrotasks()

    expect(optionLabels(mounted.root)).toEqual(['selected-oov', 'static-fallback'])
    expect(mounted.root.querySelector('.combo-status')?.textContent).toContain('unavailable')
    const selected = mounted.root.querySelector<HTMLElement>('.combo-option')!
    selected.click()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      params: expect.objectContaining({ value: 'selected-oov' }),
    }))
    mounted.unmount()
  })

  it('remote COMBO leaves loading after current authority abort and can demand again', async () => {
    const first = deferred<readonly string[]>()
    const remoteChoices = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(['remote-after-invalidation'])
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => 0 }
    const mounted = mountEditor(editorState({
      widgetType: 'COMBO',
      options: { options: ['static-fallback'] },
      remote: { route: '/api/choices/models', refreshButton: true },
    }, 'selected-oov'), {
      backendForTab: () => ({ scopedClient }),
      completeComboRefresh: () => {},
    } as unknown as Partial<AppState>)
    first.reject(new DOMException('schema generation changed', 'AbortError'))
    await flushMicrotasks()
    expect(mounted.root.querySelector('.combo-status')?.textContent).toContain('unavailable')

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="remote-refresh"]')!.click()
    await flushMicrotasks()
    await flushMicrotasks()
    expect(optionLabels(mounted.root)).toEqual(['selected-oov', 'remote-after-invalidation'])
    expect(remoteChoices).toHaveBeenCalledTimes(2)
    mounted.unmount()
  })

  it('remote COMBO retires ready options when backend choice authority changes', async () => {
    let authority = 0
    let notify = (_value: number): void => {}
    const remoteChoices = vi.fn()
      .mockResolvedValueOnce(['retired-remote'])
      .mockRejectedValueOnce(new Error('schema refetch failed'))
    const scopedClient = { remoteChoices, remoteChoiceAuthority: () => authority }
    const mounted = mountEditor(editorState({
      widgetType: 'COMBO',
      options: { options: ['static-fallback'] },
      remote: { route: '/api/choices/models', refreshButton: true },
    }, 'selected-oov'), {
      backendForTab: () => ({ scopedClient }),
      backendsTick: {
        get: () => authority,
        subscribe: (listener: (value: number) => void) => {
          notify = listener
          return () => {}
        },
      },
      completeComboRefresh: () => {},
    } as unknown as Partial<AppState>)
    await flushMicrotasks()
    expect(optionLabels(mounted.root)).toEqual(['selected-oov', 'retired-remote'])

    authority += 1
    notify(authority)
    await flushMicrotasks()
    expect(mounted.root.querySelector('[data-testid="combo-dropdown"]')?.getAttribute('data-remote')).toBe('static')
    expect(optionLabels(mounted.root)).toEqual(['selected-oov', 'static-fallback'])

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="remote-refresh"]')!.click()
    await flushMicrotasks()
    expect(mounted.root.querySelector('.combo-status')?.textContent).toContain('unavailable')
    expect(optionLabels(mounted.root)).toEqual(['selected-oov', 'static-fallback'])
    mounted.unmount()
  })

  it('moves the static highlight with ArrowDown and ArrowUp and commits it with Enter', async () => {
    const mounted = mountEditor(editorState(
      { widgetType: 'COMBO', options: { options: ['alpha', [7, 'Seven'], 'gamma'] } },
      'alpha',
    ))
    await flushMicrotasks()
    const search = mounted.root.querySelector<HTMLInputElement>('[data-testid="combo-search"]')!

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(mounted.root.querySelector('.combo-option.active')?.textContent).toBe('Seven')
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      params: expect.objectContaining({ value: 7 }),
    }))
    expect(typeof mounted.dispatchTo.mock.calls[0]![1].params.value).toBe('number')
    mounted.unmount()
  })

  it('keeps a static COMBO popover open on blur and leaves Escape dismissal to CanvasHost', async () => {
    const mounted = mountEditor(editorState(
      { widgetType: 'COMBO', options: { options: ['alpha', 'beta'] } },
      'alpha',
    ))
    await flushMicrotasks()
    const search = mounted.root.querySelector<HTMLInputElement>('[data-testid="combo-search"]')!
    search.focus()
    mounted.outside.focus()
    expect(mounted.onClose).not.toHaveBeenCalled()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(mounted.onClose).not.toHaveBeenCalled()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('renders an empty static COMBO and Enter cannot commit a value', async () => {
    const mounted = mountEditor(editorState({ widgetType: 'COMBO', options: { options: [] } }, undefined))
    await flushMicrotasks()
    expect(mounted.root.querySelector('.combo-status')?.textContent).toBe('No matching options')

    mounted.root.querySelector<HTMLInputElement>('[data-testid="combo-search"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    expect(mounted.onClose).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('drops non-finite static COMBO options instead of rendering uncommittable rows', async () => {
    const mounted = mountEditor(editorState({ widgetType: 'COMBO', options: { options: [NaN, Infinity] } }, undefined))
    await flushMicrotasks()
    expect(mounted.root.querySelectorAll('.combo-option')).toHaveLength(0)
    expect(mounted.root.querySelector('.combo-status')?.textContent).toBe('No matching options')
    mounted.unmount()
  })

  it('clamps FLOAT editor commits to min and max without quantizing to step', async () => {
    for (const [raw, expected] of [['-20', -2], ['20', 3], ['1.25', 1.25]] as const) {
      const mounted = mountEditor(editorState(
        { widgetType: 'FLOAT', options: { min: -2, max: 3, step: 1 } },
        0,
      ))
      await flushMicrotasks()
      const input = mounted.root.querySelector<HTMLInputElement>('.widget-editor input')!
      input.value = raw
      mounted.root.querySelector<HTMLButtonElement>('[data-testid="widget-editor-commit"]')!.click()
      expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        params: expect.objectContaining({ value: expected }),
      }))
      mounted.unmount()
    }
  })

  it('commits an unbounded FLOAT as-is and still refuses non-finite input', async () => {
    const mounted = mountEditor(editorState({ widgetType: 'FLOAT', options: { step: 1 } }, 0))
    await flushMicrotasks()
    const input = mounted.root.querySelector<HTMLInputElement>('.widget-editor input')!
    const commit = mounted.root.querySelector<HTMLButtonElement>('[data-testid="widget-editor-commit"]')!
    input.value = 'Infinity'
    commit.click()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    expect(mounted.root.querySelector('[data-testid="widget-editor-error"]')?.textContent).toBe('Enter a finite number.')

    input.value = '20.25'
    commit.click()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      params: expect.objectContaining({ value: 20.25 }),
    }))
    mounted.unmount()
  })

  it('commits nested object and array values through the raw JSON fallback', async () => {
    for (const [raw, expected] of [
      ['{"nested":{"enabled":true,"items":[1,2]}}', { nested: { enabled: true, items: [1, 2] } }],
      ['[1,{"name":"two"},[3]]', [1, { name: 'two' }, [3]]],
    ] as const) {
      const state = { ...editorState(undefined, null), multiline: true }
      const mounted = mountEditor({ ...state, target: { kind: 'valueSource', valueSourceId: 'v0' } })
      await flushMicrotasks()
      const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.widget-editor textarea')!
      textarea.value = raw
      mounted.root.querySelector<HTMLButtonElement>('[data-testid="widget-editor-commit"]')!.click()
      expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        params: expect.objectContaining({ value: expected }),
      }))
      mounted.unmount()
    }
  })

  it('keeps raw JSON edits open on blur and leaves Escape dismissal to CanvasHost', async () => {
    const state = { ...editorState(undefined, { stored: true }), multiline: true }
    const mounted = mountEditor({ ...state, target: { kind: 'valueSource', valueSourceId: 'v0' } })
    await flushMicrotasks()
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>('.widget-editor textarea')!
    textarea.value = '{"stored":false}'
    textarea.focus()
    mounted.outside.focus()
    expect(mounted.onClose).not.toHaveBeenCalled()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(mounted.onClose).not.toHaveBeenCalled()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.unmount()
  })
})

describe('combo render window', () => {
  const step = Math.floor(COMBO_RENDER_CAP / 2)

  it('returns the full range for lists at or under the cap', () => {
    expect(comboRenderWindow(0, 0)).toEqual({ start: 0, end: 0, hiddenBefore: 0, hiddenAfter: 0 })
    expect(comboRenderWindow(3, 2)).toEqual({ start: 0, end: 3, hiddenBefore: 0, hiddenAfter: 0 })
    expect(comboRenderWindow(COMBO_RENDER_CAP, COMBO_RENDER_CAP - 1))
      .toEqual({ start: 0, end: COMBO_RENDER_CAP, hiddenBefore: 0, hiddenAfter: 0 })
  })

  it('always contains the highlight and renders exactly the cap for oversized lists', () => {
    const total = 1000
    for (const index of [0, step - 1, step, 2 * step - 1, 2 * step, 500, 899, 999]) {
      const window = comboRenderWindow(total, index)
      expect(window.start).toBeLessThanOrEqual(index)
      expect(window.end).toBeGreaterThan(index)
      expect(window.end - window.start).toBe(COMBO_RENDER_CAP)
      expect(window.hiddenBefore).toBe(window.start)
      expect(window.hiddenAfter).toBe(total - window.end)
    }
  })

  it('keeps the window identical inside a half-cap block and shifts across the boundary', () => {
    const total = 1000
    expect(comboRenderWindow(total, 2 * step)).toEqual(comboRenderWindow(total, 3 * step - 1))
    expect(comboRenderWindow(total, 3 * step - 1)).not.toEqual(comboRenderWindow(total, 3 * step))
  })

  it('clamps the window at the tail and clamps out-of-range highlights', () => {
    const tail = comboRenderWindow(1000, 999)
    expect(tail).toEqual({ start: 1000 - COMBO_RENDER_CAP, end: 1000, hiddenBefore: 1000 - COMBO_RENDER_CAP, hiddenAfter: 0 })
    expect(comboRenderWindow(1000, 5000)).toEqual(tail)
    expect(comboRenderWindow(1000, -5)).toEqual(comboRenderWindow(1000, 0))
  })

  it('still contains the highlight at cap 1', () => {
    expect(comboRenderWindow(10, 5, 1)).toEqual({ start: 5, end: 6, hiddenBefore: 5, hiddenAfter: 4 })
  })

  it('caps rendered rows for a huge COMBO and keeps a deep initial value visible with paging rows', async () => {
    const values = Array.from({ length: 1000 }, (_, index) => `option-${index}`)
    const mounted = mountEditor(editorState({ widgetType: 'COMBO', options: { options: values } }, 'option-500'))
    await flushMicrotasks()

    expect(mounted.root.querySelectorAll('.combo-option')).toHaveLength(COMBO_RENDER_CAP)
    expect(mounted.root.querySelector('.combo-option.active')?.textContent).toBe('option-500')
    expect(mounted.root.querySelector('[data-testid="combo-earlier"]')?.textContent).toBe('300 earlier options')
    expect(mounted.root.querySelector('[data-testid="combo-more"]')?.textContent).toBe('400 more options - type to narrow')
    mounted.unmount()
  })

  it('paging rows jump the highlight across the window boundary', async () => {
    const values = Array.from({ length: 1000 }, (_, index) => `option-${index}`)
    const mounted = mountEditor(editorState({ widgetType: 'COMBO', options: { options: values } }, 'option-500'))
    await flushMicrotasks()

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="combo-more"]')!.click()
    await flushMicrotasks()
    expect(mounted.root.querySelector('.combo-option.active')?.textContent).toBe('option-600')
    expect(optionLabels(mounted.root)[0]).toBe('option-450')

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="combo-earlier"]')!.click()
    await flushMicrotasks()
    expect(mounted.root.querySelector('.combo-option.active')?.textContent).toBe('option-449')
    expect(optionLabels(mounted.root)[0]).toBe('option-150')
    mounted.unmount()
  })

  it('arrow keys inside a block move the highlight without rebuilding rows', async () => {
    const values = Array.from({ length: 1000 }, (_, index) => `option-${index}`)
    const mounted = mountEditor(editorState({ widgetType: 'COMBO', options: { options: values } }, 'option-500'))
    await flushMicrotasks()
    const search = mounted.root.querySelector<HTMLInputElement>('[data-testid="combo-search"]')!
    const firstRow = mounted.root.querySelector<HTMLElement>('.combo-option')!

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flushMicrotasks()
    expect(mounted.root.querySelector('.combo-option.active')?.textContent).toBe('option-501')
    expect(mounted.root.querySelector<HTMLElement>('.combo-option')).toBe(firstRow)
    mounted.unmount()
  })

  it('pointer hover over a rendered row never shifts the window', async () => {
    const values = Array.from({ length: 1000 }, (_, index) => `option-${index}`)
    const mounted = mountEditor(editorState({ widgetType: 'COMBO', options: { options: values } }, 'option-500'))
    await flushMicrotasks()
    const firstRow = mounted.root.querySelector<HTMLElement>('.combo-option')!
    expect(firstRow.textContent).toBe('option-300')

    // Re-anchoring on hover would rebuild the rows starting at option-150,
    // moving the list under the stationary pointer.
    firstRow.dispatchEvent(new MouseEvent('mouseenter'))
    await flushMicrotasks()
    expect(mounted.root.querySelector('.combo-option.active')?.textContent).toBe('option-300')
    expect(mounted.root.querySelector<HTMLElement>('.combo-option')).toBe(firstRow)
    expect(mounted.root.querySelector('[data-testid="combo-earlier"]')?.textContent).toBe('300 earlier options')
    mounted.unmount()
  })

  it('narrowing the query below the cap renders every match without paging rows', async () => {
    const values = Array.from({ length: 1000 }, (_, index) => `option-${index}`)
    const mounted = mountEditor(editorState({ widgetType: 'COMBO', options: { options: values } }, 'option-500'))
    await flushMicrotasks()
    const search = mounted.root.querySelector<HTMLInputElement>('[data-testid="combo-search"]')!

    search.value = 'option-99'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flushMicrotasks()
    // option-99 plus option-990 through option-999
    expect(mounted.root.querySelectorAll('.combo-option')).toHaveLength(11)
    expect(mounted.root.querySelector('[data-testid="combo-earlier"]')).toBeNull()
    expect(mounted.root.querySelector('[data-testid="combo-more"]')).toBeNull()
    mounted.unmount()
  })

  it('caps MULTI_COMBO rows through the same menu', async () => {
    const values = Array.from({ length: 1000 }, (_, index) => `option-${index}`)
    const mounted = mountEditor(editorState({ widgetType: 'MULTI_COMBO', options: { options: values } }, []))
    await flushMicrotasks()

    expect(mounted.root.querySelectorAll('[data-testid="multi-combo-option"]')).toHaveLength(COMBO_RENDER_CAP)
    expect(mounted.root.querySelector('[data-testid="combo-more"]')).not.toBeNull()
    mounted.unmount()
  })
})

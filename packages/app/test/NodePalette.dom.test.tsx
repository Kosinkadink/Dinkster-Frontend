// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCatalog, setLocale, type WidgetRegistry } from '@dinkster/core'
import { typeIdDisplayLabel } from '@dinkster/canvas'
import { NodePalette, SearchableTypeFilter, type PaletteEntry } from '../src/NodePalette.js'
import '../src/locale.js'

const rankSearchCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('@dinkster/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dinkster/core')>()
  return {
    ...actual,
    rankSearch: ((...args: Parameters<typeof actual.rankSearch>) => {
      rankSearchCalls.count++
      return actual.rankSearch(...args)
    }) as typeof actual.rankSearch,
  }
})

const key = (target: Element, value: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

const flushMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await new Promise<void>((resolve) => queueMicrotask(resolve))
}

afterEach(() => {
  document.body.replaceChildren()
  setLocale('en')
})

const paletteEntry = (type: string, name: string, category: string): PaletteEntry => ({
  type,
  name,
  category,
  description: `${name} description`,
  pack: 'Test pack',
  kind: 'utility',
  fields: [{ text: name, weight: 3 }, { text: category, weight: 1 }],
})

const widgetRegistry = {
  kind: () => undefined,
  viewsFor: () => [],
} as unknown as WidgetRegistry

const mountPalette = (entries: readonly PaletteEntry[] | (() => readonly PaletteEntry[]), options?: {
  readonly anchor?: { readonly x: number; readonly y: number }
  readonly bounds?: { readonly width: number; readonly height: number }
  readonly onCommit?: (entry: PaletteEntry) => void
  readonly onHelp?: (entry: PaletteEntry) => void
  readonly onClose?: () => void
}) => {
  const readEntries: () => readonly PaletteEntry[] = typeof entries === 'function' ? entries : () => entries
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => (
    <NodePalette
      anchor={{
        x: options?.anchor?.x ?? 80,
        y: options?.anchor?.y ?? 60,
        worldX: 10,
        worldY: 20,
      }}
      entries={() => [...readEntries()]}
      recentTypes={() => []}
      widgetRegistry={widgetRegistry}
      bounds={() => options?.bounds ?? { width: 800, height: 600 }}
      onCommit={options?.onCommit ?? (() => {})}
      {...(options?.onHelp === undefined ? {} : { onHelp: options.onHelp })}
      onClose={options?.onClose ?? (() => {})}
    />
  ), root)
  return { root, dispose }
}

describe('NodePalette type disclosure', () => {
  it('owns disclosure, search, keyboard toggle, and Escape focus without incidental commits', async () => {
    const commits = vi.fn()
    const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
    const root = document.createElement('div')
    document.body.append(root)
    render(() => (
      <SearchableTypeFilter
        label="Input"
        testid="palette-input-filter"
        options={['IMAGE', 'LATENT', 'MODEL']}
        selected={selected()}
        onChange={(value) => { commits(value); setSelected(value) }}
      />
    ), root)

    const composite = root.querySelector<HTMLElement>('[data-testid="palette-input-filter"]')!
    const trigger = composite.querySelector<HTMLButtonElement>('button')!
    expect(composite.querySelector('details, summary, input[type="checkbox"]')).toBeNull()
    expect(trigger.textContent).toContain('Input: Any type')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-controls')).toBeTruthy()

    trigger.click()
    await flushMicrotasks()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!
    expect(panel).not.toBeNull()
    const search = panel.querySelector<HTMLInputElement>('input')!
    expect(search.getAttribute('aria-label')).toBe('Search input types')
    expect(search.placeholder).toBe('Search types...')
    expect(document.activeElement).toBe(search)

    search.value = 'lat'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(panel.querySelectorAll('[role="checkbox"]')).toHaveLength(1)
    expect(panel.textContent).toContain('LATENT')
    expect(commits).not.toHaveBeenCalled()
    key(search, 'ArrowDown')
    const latent = panel.querySelector<HTMLElement>('[role="checkbox"]')!
    expect(document.activeElement).toBe(latent)
    expect(latent.getAttribute('aria-checked')).toBe('false')
    expect(commits).not.toHaveBeenCalled()

    key(latent, 'Enter')
    expect(commits).toHaveBeenCalledOnce()
    expect([...commits.mock.calls[0]![0]]).toEqual(['LATENT'])
    expect(latent.getAttribute('aria-checked')).toBe('true')
    expect(trigger.textContent).toContain('Input: 1 selected')

    key(latent, 'Escape')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)

    key(trigger, 'Enter')
    await flushMicrotasks()
    trigger.focus()
    key(trigger, 'Escape')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('shows display aliases for canonical options while committing the canonical value', async () => {
    const commits = vi.fn()
    const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
    const root = document.createElement('div')
    document.body.append(root)
    render(() => (
      <SearchableTypeFilter
        label="Input"
        testid="palette-input-filter"
        options={['dinkster.clip', 'list<dinkster.latent>', 'comfy.IMAGE']}
        selected={selected()}
        onChange={(value) => { commits(value); setSelected(value) }}
        labelOf={typeIdDisplayLabel}
      />
    ), root)

    const composite = root.querySelector<HTMLElement>('[data-testid="palette-input-filter"]')!
    const trigger = composite.querySelector<HTMLButtonElement>('button')!
    trigger.click()
    await flushMicrotasks()
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!
    // Rows show the alias, never the raw dinkster id.
    expect(panel.textContent).toContain('CLIP')
    expect(panel.textContent).toContain('list<LATENT>')
    expect(panel.textContent).not.toContain('dinkster.clip')

    // Searching by the alias finds the option; committing selects the
    // CANONICAL value, which is what the port filters match against.
    const search = panel.querySelector<HTMLInputElement>('input')!
    search.value = 'clip'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(panel.querySelectorAll('[role="checkbox"]')).toHaveLength(1)
    panel.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click()
    expect([...commits.mock.calls[0]![0]]).toEqual(['dinkster.clip'])

    // Searching by the canonical id also still works.
    search.value = 'dinkster.latent'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(panel.querySelectorAll('[role="checkbox"]')).toHaveLength(1)
    expect(panel.textContent).toContain('list<LATENT>')
  })

  it('keeps both instances independent and lets an outside pointerdown reach its target', async () => {
    const inputChange = vi.fn()
    const outputChange = vi.fn()
    const outside = vi.fn()
    const root = document.createElement('div')
    const outsideButton = document.createElement('button')
    outsideButton.addEventListener('pointerdown', outside)
    document.body.append(root, outsideButton)
    render(() => (
      <>
        <SearchableTypeFilter label="Input" testid="input" options={['IMAGE']} selected={new Set()} onChange={inputChange} />
        <SearchableTypeFilter label="Output" testid="output" options={['LATENT']} selected={new Set()} onChange={outputChange} />
      </>
    ), root)

    const inputTrigger = root.querySelector<HTMLButtonElement>('[data-testid="input"] button')!
    const outputTrigger = root.querySelector<HTMLButtonElement>('[data-testid="output"] button')!
    key(inputTrigger, 'Enter')
    await flushMicrotasks()
    expect(inputTrigger.getAttribute('aria-expanded')).toBe('true')
    expect(outputTrigger.getAttribute('aria-expanded')).toBe('false')
    expect(inputChange).not.toHaveBeenCalled()
    expect(outputChange).not.toHaveBeenCalled()

    outputTrigger.focus()
    expect(inputTrigger.getAttribute('aria-expanded')).toBe('false')
    expect(outputTrigger.getAttribute('aria-expanded')).toBe('false')

    inputTrigger.click()
    await flushMicrotasks()
    outsideButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    expect(inputTrigger.getAttribute('aria-expanded')).toBe('false')
    expect(outside).toHaveBeenCalledOnce()
    expect(document.activeElement).not.toBe(inputTrigger)
  })
})

describe('NodePalette search surface', () => {
  it('updates an open palette and type filter when the active locale changes', async () => {
    registerCatalog('de-DE', {
      'palette.action.addNode': '[Knoten hinzufugen]',
      'palette.announcement.results': '[{count} Treffer; {index}/{count}: {name}]',
      'palette.category.mostRelevant': '[Beste Treffer]',
      'palette.category.navigation': '[Knotenkategorien]',
      'palette.filter.input': '[Eingang]',
      'palette.filter.output': '[Ausgang]',
      'palette.filter.resultKinds': '[Ergebnisarten]',
      'palette.kind.blueprints': '[Vorlagen]',
      'palette.ports.declaredInputs': '[Deklarierte Eingange]',
      'palette.ports.declaredOutputs': '[Deklarierte Ausgange]',
      'palette.port.required': '[erforderlich]',
      'palette.preview.aria': '[Vorschau: {name}]',
      'palette.results.available': '[Verfugbare Knoten]',
      'palette.search.addNodePlaceholder': '[Knoten suchen...]',
      'palette.tags': '[Stichworte]',
      'palette.typeFilter.any': '[Alle Typen]',
      'palette.typeFilter.dialog': '[Typfilter: {label}]',
      'palette.typeFilter.search': '[Suche Typen: {direction}]',
      'palette.typeFilter.searchPlaceholder': '[Typen suchen...]',
    })
    const blueprint = {
      ...paletteEntry('proof.blueprint', 'Proof blueprint', 'Proof'),
      kind: 'blueprint',
      blueprint: {
        packId: 'proof-pack',
        descriptor: {
          id: 'proof-blueprint',
          name: 'Proof blueprint',
          digest: `sha256:${'1'.repeat(64)}`,
          boundaryInputs: ['IMAGE'],
          boundaryOutputs: ['LATENT'],
          tags: ['proof'],
        },
      },
    } as const satisfies PaletteEntry
    const { root, dispose } = mountPalette([blueprint, paletteEntry('proof.utility', 'Proof utility', 'Proof')])
    try {
      await flushMicrotasks()
      const dialog = root.querySelector<HTMLElement>('[data-testid="node-palette"]')!
      const search = root.querySelector<HTMLInputElement>('[data-testid="palette-search"]')!
      const inputFilter = root.querySelector<HTMLElement>('[data-testid="palette-input-filter"]')!
      inputFilter.querySelector<HTMLButtonElement>('button')!.click()
      await flushMicrotasks()
      expect(dialog.getAttribute('aria-label')).toBe('Add a node')
      expect(search.placeholder).toBe('Add a node...')
      expect(inputFilter.textContent).toContain('Input: Any type')

      setLocale('de-DE')

      expect(dialog.getAttribute('aria-label')).toBe('[Knoten hinzufugen]')
      expect(search.placeholder).toBe('[Knoten suchen...]')
      expect(root.querySelector('[data-testid="palette-categories"]')?.getAttribute('aria-label')).toBe('[Knotenkategorien]')
      expect(root.querySelector('[data-testid="palette-kinds"]')?.getAttribute('aria-label')).toBe('[Ergebnisarten]')
      expect(root.querySelector('[data-kind="blueprint"]')?.textContent).toBe('[Vorlagen]')
      expect(root.querySelector('.search-result-group-header')?.textContent).toContain('[Verfugbare Knoten]')
      expect(root.querySelector('[data-testid="palette-preview"]')?.getAttribute('aria-label')).toBe('[Vorschau: Proof blueprint]')
      expect(root.querySelector('[data-testid="palette-preview"]')?.textContent).toContain('[Deklarierte Eingange]')
      expect(root.querySelector('[data-testid="palette-preview"]')?.textContent).toContain('[Deklarierte Ausgange]')
      expect(root.querySelector('[data-testid="palette-preview"]')?.textContent).toContain('[erforderlich]')
      expect(root.querySelector('[data-testid="palette-preview"]')?.textContent).toContain('[Stichworte]')
      expect(inputFilter.textContent).toContain('[Eingang]: [Alle Typen]')
      const filterDialog = inputFilter.querySelector<HTMLElement>('[role="dialog"]')!
      expect(filterDialog.getAttribute('aria-label')).toBe('[Typfilter: [Eingang]]')
      expect(filterDialog.querySelector<HTMLInputElement>('input')?.placeholder).toBe('[Typen suchen...]')
      expect(filterDialog.querySelector<HTMLInputElement>('input')?.getAttribute('aria-label')).toBe('[Suche Typen: [eingang]]')
      expect(root.querySelector('[role="status"]')?.textContent).toBe('[2 Treffer; 1/2: Proof blueprint]')
    } finally {
      dispose()
    }
  })

  it('keeps an option-only listbox, input-owned keyboard selection, and empty state separation', async () => {
    const commits = vi.fn()
    const { root, dispose } = mountPalette([
      paletteEntry('alpha', 'Alpha', 'Image'),
      paletteEntry('beta', 'Beta', 'Latent'),
      paletteEntry('gamma', 'Gamma', 'Utility'),
    ], { onCommit: commits })
    try {
      await flushMicrotasks()
      const dialog = root.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!
      const input = root.querySelector<HTMLInputElement>('[data-testid="palette-search"]')!
      const listbox = document.getElementById(input.getAttribute('aria-controls')!)!
      const options = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')]

      expect(dialog.getAttribute('aria-label')).toBe('Add a node')
      expect(options).toHaveLength(3)
      expect([...listbox.querySelectorAll('[role="group"]')]).toHaveLength(1)
      expect(options.every((option) => listbox.contains(option))).toBe(true)
      expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id)
      expect(document.activeElement).toBe(input)
      expect(commits).not.toHaveBeenCalled()

      key(input, 'ArrowDown')
      expect(input.getAttribute('aria-activedescendant')).toBe(options[1]!.id)
      expect(document.activeElement).toBe(input)
      expect(commits).not.toHaveBeenCalled()
      key(input, 'Enter')
      expect(commits).toHaveBeenCalledOnce()
      expect(commits).toHaveBeenCalledWith(expect.objectContaining({ type: 'beta' }))

      input.value = 'no matching node'
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
      expect(listbox.querySelector('[role="option"]')).toBeNull()
      expect(input.getAttribute('aria-activedescendant')).toBeNull()
      const empty = root.querySelector<HTMLElement>('[data-search-state="empty"]')!
      expect(empty.textContent).toContain('No matching nodes')
      expect(listbox.contains(empty)).toBe(false)
    } finally {
      dispose()
    }
  })

  it('restores the first active option when a live catalog populates an empty result set', async () => {
    const commits = vi.fn()
    const [entries, setEntries] = createSignal<readonly PaletteEntry[]>([
      paletteEntry('alpha', 'Alpha', 'Image'),
    ])
    const { root, dispose } = mountPalette(entries, { onCommit: commits })
    try {
      await flushMicrotasks()
      const input = root.querySelector<HTMLInputElement>('[data-testid="palette-search"]')!
      input.value = 'late arrival'
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
      expect(input.getAttribute('aria-activedescendant')).toBeNull()

      key(input, 'ArrowDown')
      setEntries([paletteEntry('late', 'Late arrival', 'Utility')])
      await flushMicrotasks()

      const option = root.querySelector<HTMLElement>('[role="option"]')!
      expect(option.getAttribute('aria-selected')).toBe('true')
      expect(input.getAttribute('aria-activedescendant')).toBe(option.id)
      key(input, 'Enter')
      expect(commits).toHaveBeenCalledOnce()
      expect(commits).toHaveBeenCalledWith(expect.objectContaining({ type: 'late' }))
    } finally {
      dispose()
    }
  })

  it('opens with its top edge centered on the anchor point and clamps at edges', async () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return this.classList.contains('node-palette') ? 320 : 120 },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() { return this.classList.contains('node-palette') ? 240 : 32 },
    })
    const centered = mountPalette([paletteEntry('alpha', 'Alpha', 'Image/Loaders')], {
      anchor: { x: 400, y: 60 },
      bounds: { width: 800, height: 600 },
    })
    const nearEdge = mountPalette([paletteEntry('alpha', 'Alpha', 'Image/Loaders')], {
      anchor: { x: 10, y: 60 },
      bounds: { width: 800, height: 600 },
    })
    try {
      await flushMicrotasks()
      const dialog = centered.root.querySelector<HTMLElement>('[data-testid="node-palette"]')!
      expect(dialog.style.left).toBe('240px')
      expect(dialog.style.top).toBe('60px')
      const clamped = nearEdge.root.querySelector<HTMLElement>('[data-testid="node-palette"]')!
      expect(clamped.style.left).toBe('4px')
      expect(clamped.style.top).toBe('60px')
    } finally {
      centered.dispose()
      nearEdge.dispose()
      if (width === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)['offsetWidth']
      else Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width)
      if (height === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)['offsetHeight']
      else Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height)
    }
  })

  it('bounds the shared floating surface and traps sequential focus within the modal palette', async () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    const clientRects = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getClientRects')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return this.classList.contains('node-palette') ? 320 : 120 },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() { return this.classList.contains('node-palette') ? 240 : 32 },
    })
    Object.defineProperty(HTMLElement.prototype, 'getClientRects', {
      configurable: true,
      value(this: HTMLElement) {
        return (this.style.display === 'none' ? [] : [{}]) as unknown as DOMRectList
      },
    })
    const { root, dispose } = mountPalette([
      paletteEntry('alpha', 'Alpha', 'Image/Loaders'),
      paletteEntry('beta', 'Beta', 'Image/Transforms'),
    ], { anchor: { x: 235, y: 175 }, bounds: { width: 240, height: 180 } })
    try {
      await flushMicrotasks()
      const dialog = root.querySelector<HTMLElement>('[data-testid="node-palette"]')!
      const input = root.querySelector<HTMLInputElement>('[data-testid="palette-search"]')!
      expect(dialog.style.left).toBe('4px')
      expect(dialog.style.top).toBe('4px')
      expect(dialog.style.maxWidth).toBe('232px')
      expect(dialog.style.maxHeight).toBe('172px')

      const hidden = document.createElement('button')
      hidden.style.display = 'none'
      dialog.append(hidden)
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0)
      const last = focusable.at(-1)!
      last.focus()
      key(last, 'Tab')
      expect(document.activeElement).toBe(input)
      const shiftTab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(shiftTab)
      expect(document.activeElement).toBe(last)
    } finally {
      dispose()
      if (width === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)['offsetWidth']
      else Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width)
      if (height === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)['offsetHeight']
      else Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height)
      if (clientRects === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)['getClientRects']
      else Object.defineProperty(HTMLElement.prototype, 'getClientRects', clientRects)
    }
  })

  it('exposes expandable category hierarchy and selected category state without claiming tree keyboard semantics', async () => {
    const { root, dispose } = mountPalette([
      paletteEntry('alpha', 'Alpha', 'Image/Loaders'),
      paletteEntry('beta', 'Beta', 'Image/Transforms'),
    ])
    try {
      await flushMicrotasks()
      const categories = root.querySelector<HTMLElement>('[aria-label="Node categories"]')!
      expect(categories.getAttribute('role')).toBeNull()
      const expand = categories.querySelector<HTMLButtonElement>('[aria-label="Expand Image"]')!
      expect(expand.getAttribute('aria-expanded')).toBe('false')
      expect(expand.getAttribute('aria-controls')).toBeNull()
      expand.click()
      expect(expand.getAttribute('aria-expanded')).toBe('true')
      expect(document.getElementById(expand.getAttribute('aria-controls')!)?.textContent).toContain('Loaders')
      const loaders = [...categories.querySelectorAll<HTMLButtonElement>('[data-testid="palette-category"]')]
        .find((button) => button.textContent?.includes('Loaders'))!
      loaders.click()
      expect(loaders.getAttribute('aria-pressed')).toBe('true')
    } finally {
      dispose()
    }
  })

  it('filters and ranks the corpus exactly once per keystroke', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => paletteEntry(`test.node_${i}`, `Node ${i}`, 'testing'))
    const { root, dispose } = mountPalette(entries)
    try {
      await flushMicrotasks()
      const input = root.querySelector<HTMLInputElement>('[data-testid="palette-search"]')!
      const typeChar = (value: string): void => {
        input.value = value
        input.dispatchEvent(new InputEvent('input', { bubbles: true }))
      }
      rankSearchCalls.count = 0
      typeChar('n')
      await flushMicrotasks()
      expect(rankSearchCalls.count).toBe(1)
      typeChar('no')
      await flushMicrotasks()
      expect(rankSearchCalls.count).toBe(2)
      expect(root.querySelectorAll('[data-testid="palette-item"]').length).toBeGreaterThan(0)
    } finally {
      dispose()
    }
  })

  it('offers full help only for a documented node and invokes it without placing the node', async () => {
    const onCommit = vi.fn()
    const onHelp = vi.fn()
    const documented = {
      ...paletteEntry('test.documented', 'Documented', 'testing'),
      schema: {
        type: 'test.documented', displayName: 'Documented', category: 'testing', pack: 'test-pack',
        items: [], hasDocs: true,
      },
    } as unknown as PaletteEntry
    const { root, dispose } = mountPalette([documented], { onCommit, onHelp })
    try {
      await flushMicrotasks()
      const help = root.querySelector<HTMLButtonElement>('.preview-help')!
      expect(help.textContent).toBe('Help')
      registerCatalog('de-DE', { 'nodeHelp.action.help': '[Hilfe]' })
      setLocale('de-DE')
      expect(help.textContent).toBe('[Hilfe]')
      help.click()
      expect(onHelp).toHaveBeenCalledWith(documented)
      expect(onCommit).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })
})

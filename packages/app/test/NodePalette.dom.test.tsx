// @vitest-environment happy-dom
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCatalog, setLocale, type WidgetRegistry } from '@dinkster/core'
import { NodePalette, type PaletteAnchor, type PaletteEntry } from '../src/NodePalette.js'
import '../src/locale.js'

const key = (target: Element, value: string): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
}
const flush = async () => { await new Promise<void>((resolve) => queueMicrotask(resolve)) }
afterEach(() => { document.body.replaceChildren(); setLocale('en') })

const entry = (type: string, name: string, category = 'Image', input = 'IMAGE', output = 'LATENT'): PaletteEntry => ({
  type, name, category, description: `${name} description`, pack: 'Test pack', kind: 'node',
  schema: { type, displayName: name, category, source: 'v3', isOutputNode: false, body: [
    { kind: 'input', id: 'picture', type: { kind: 'concrete', name: input }, optional: false },
    { kind: 'output', id: 'result', type: { kind: 'concrete', name: output } },
  ] },
  fields: [{ text: name, weight: 3 }, { text: category, weight: 1 }],
})
const mount = (entries: () => PaletteEntry[], options: {
  anchor?: PaletteAnchor; recent?: readonly string[]; onCommit?: (entry: PaletteEntry) => void; onHelp?: (entry: PaletteEntry) => void
  onRemoveLinkDrop?: () => void; bounds?: { width: number; height: number }
} = {}) => {
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <NodePalette entries={entries}
    anchor={options.anchor ?? { x: 80, y: 60, worldX: 10, worldY: 20 }}
    recentTypes={() => options.recent ?? []} widgetRegistry={{ kind: () => undefined, viewsFor: () => [] } as unknown as WidgetRegistry}
    bounds={() => options.bounds ?? { width: 800, height: 600 }} onCommit={options.onCommit ?? (() => {})}
    {...(options.onHelp === undefined ? {} : { onHelp: options.onHelp })}
    onRemoveLinkDrop={options.onRemoveLinkDrop ?? (() => {})} onClose={() => {}} />, root)
  const input = root.querySelector<HTMLInputElement>('[role="combobox"]')!
  const search = (query: string) => { input.value = query; input.dispatchEvent(new InputEvent('input', { bubbles: true })) }
  return { root, input, search, dispose }
}
const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[role="option"]')]
const button = (root: HTMLElement, name: string) => [...root.querySelectorAll<HTMLButtonElement>('button')]
  .find((element) => element.getAttribute('aria-label') === name || element.textContent === name)!

describe('NodePalette shared search', () => {
  it('browses recent entries and categories, then owns keyboard selection without an incidental commit', async () => {
    const commit = vi.fn()
    const alpha = entry('alpha', 'Alpha', 'Image/Loaders')
    const beta = entry('beta', 'Beta', 'Image/Transforms')
    const view = mount(() => [alpha, beta], { recent: ['beta'], onCommit: commit })
    try {
      await flush()
      expect(document.activeElement).toBe(view.input)
      expect(rows(view.root).map((row) => row.textContent)).toEqual(['BetaImage / Transforms', 'Image2'])
      key(view.input, 'ArrowDown')
      key(view.input, 'Enter')
      expect(commit).not.toHaveBeenCalled()
      expect(button(view.root, 'All categories')).toBeTruthy()
      expect(rows(view.root).map((row) => row.dataset.key)).toEqual(['entry:beta', 'entry:alpha'])
      key(view.input, 'ArrowDown')
      key(view.input, 'Enter')
      expect(commit).toHaveBeenCalledExactlyOnceWith(alpha)
      button(view.root, 'All categories').click()
      expect(rows(view.root).at(-1)?.dataset.key).toBe('category:Image')
    } finally { view.dispose() }
  })

  it('updates an empty query result from a live corpus and keeps input/listbox ownership', async () => {
    const [entries, setEntries] = createSignal([entry('alpha', 'Alpha')])
    const commit = vi.fn()
    const view = mount(entries, { onCommit: commit })
    try {
      view.search('Late arrival')
      const list = document.getElementById(view.input.getAttribute('aria-controls')!)!
      expect(rows(view.root)).toHaveLength(0)
      expect(view.input.hasAttribute('aria-activedescendant')).toBe(false)
      expect(view.root.textContent).toContain('No matching nodes')
      const late = entry('late', 'Late arrival')
      setEntries([late])
      await flush()
      const option = rows(view.root)[0]!
      expect(list.contains(option)).toBe(true)
      expect(view.input.getAttribute('aria-activedescendant')).toBe(option.id)
      expect(option.getAttribute('aria-selected')).toBe('true')
      key(view.input, 'Enter')
      expect(commit).toHaveBeenCalledExactlyOnceWith(late)
    } finally { view.dispose() }
  })

  it('keeps ordered requirement chips, all-of matching and independent query/removal behavior', async () => {
    const both = entry('both', 'Both node')
    const multiInput = { ...both, schema: { ...both.schema!, body: [...both.schema!.body,
      { kind: 'input' as const, id: 'text', type: { kind: 'concrete' as const, name: 'STRING' }, optional: false },
    ] } }
    const view = mount(() => [entry('image', 'Image node'), entry('text', 'Text node', 'Text', 'STRING', 'STRING'), entry('mixed', 'Mixed node', 'Text', 'STRING', 'LATENT'), multiInput])
    try {
      view.search('node')
      button(view.root, 'Takes').click()
      await flush()
      button(view.root, 'Takes IMAGE').click()
      expect(rows(view.root).map((row) => row.dataset.key)).toEqual(['entry:image', 'entry:both'])
      button(view.root, 'Gives').click()
      await flush()
      button(view.root, 'Gives LATENT').click()
      button(view.root, 'Takes').click()
      await flush()
      button(view.root, 'Takes STRING').click()
      const chips = () => [...view.root.querySelectorAll('.dinkster-search-chip')].map((chip) => chip.getAttribute('aria-label'))
      expect(chips()).toEqual(['Takes IMAGE', 'Gives LATENT', 'Takes STRING'])
      expect(rows(view.root).map((row) => row.dataset.key)).toEqual(['entry:both'])
      key(view.input, 'Backspace')
      expect(chips()).toHaveLength(3)
      view.search('')
      key(view.input, 'Backspace')
      expect(chips()).toEqual(['Takes IMAGE', 'Gives LATENT'])
      expect(rows(view.root).map((row) => row.dataset.key)).toEqual(['entry:image', 'entry:both'])
      view.search('in:STRING node')
      expect(rows(view.root).map((row) => row.dataset.key)).toEqual(['entry:both'])
      button(view.root, 'Remove Takes IMAGE').click()
      expect(chips()).toEqual(['Gives LATENT'])
      expect(document.activeElement).toBe(view.input)
      expect(view.input.value).toBe('in:STRING node')
      expect(rows(view.root).map((row) => row.dataset.key)).toEqual(['entry:mixed', 'entry:both'])
      const trigger = button(view.root, 'Gives')
      expect(trigger.title).toBe('Gives')
      expect(trigger.textContent).toContain('Gives')
    } finally { view.dispose() }
  })

  it('lists only compatible installed wire targets and removes the pending wire without placing anything', () => {
    const commit = vi.fn()
    const remove = vi.fn()
    const image = entry('image', 'Image node')
    const blueprint: PaletteEntry = { type: 'blueprint:p/b', name: 'Image blueprint', category: 'Blueprints', kind: 'blueprint',
      blueprint: { packId: 'p', descriptor: { id: 'b', name: 'Image blueprint', digest: `sha256:${'1'.repeat(64)}`, boundaryInputs: ['IMAGE'] } },
      fields: [{ text: 'Image blueprint', weight: 3 }] }
    const remote = { ...entry('remote', 'Remote node'), install: { kind: 'host', action: 'node.previewInstall', params: { type: 'remote', backendId: 'b', schemaKey: 'k' } } } as const satisfies PaletteEntry
    const view = mount(() => [image, entry('text', 'Text node', 'Text', 'STRING'), remote, blueprint], {
      anchor: { x: 10, y: 10, worldX: 0, worldY: 0, linkDrop: { seeking: 'in', anchorType: { kind: 'concrete', name: 'IMAGE' } } as PaletteAnchor['linkDrop'] & {} },
      onCommit: commit, onRemoveLinkDrop: remove,
    })
    try {
      expect(rows(view.root).map((row) => row.dataset.key)).toEqual(['entry:image', 'entry:blueprint:p/b'])
      expect(rows(view.root)[0]!.textContent).toContain('into picture')
      expect(view.root.querySelector('[aria-label="Takes IMAGE"]')).toBeTruthy()
      button(view.root, 'Remove connection constraint').click()
      expect(remove).toHaveBeenCalledOnce()
      expect(commit).not.toHaveBeenCalled()
      key(view.input, 'Enter')
      expect(commit).toHaveBeenCalledExactlyOnceWith(image)
    } finally { view.dispose() }
  })

  it('keeps catalog-only activation distinct from ordinary placement', () => {
    const remote: PaletteEntry = { ...entry('remote', 'Remote node'), install: { kind: 'host', action: 'node.previewInstall', params: { type: 'remote', backendId: 'b', schemaKey: 'k' } } }
    const commit = vi.fn()
    const view = mount(() => [remote], { onCommit: commit })
    try {
      view.search('Remote')
      expect(rows(view.root)[0]!.textContent).toContain('Not installed')
      key(view.input, 'Enter')
      expect(commit).toHaveBeenCalledExactlyOnceWith(remote)
    } finally { view.dispose() }
  })

  it('switches kind tabs and updates open labels with the locale', () => {
    const node = entry('n', 'Node')
    const utility: PaletteEntry = { ...entry('u', 'Utility'), kind: 'utility' }
    const view = mount(() => [node, entry('n2', 'Another node'), utility])
    try {
      view.search('')
      key(view.input, 'Tab')
      view.search('kind:utility')
      expect(rows(view.root)).toHaveLength(0)
      button(view.root, 'All').click()
      expect(rows(view.root).map((row) => row.dataset.key)).toEqual(['entry:u'])
      registerCatalog('de-DE', {
        'palette.action.addNode': '[Add]', 'palette.filter.takes': '[Takes]', 'palette.search.addNodePlaceholder': '[Search]',
        'palette.announcement.results': '[Results] {count} / {index}: {name}',
        'palette.announcement.noMatches': '[No matches] {query}',
      })
      setLocale('de-DE')
      expect(view.input.getAttribute('aria-label')).toBe('[Add]')
      expect(view.input.placeholder).toBe('[Search]')
      expect(button(view.root, '[Takes]')).toBeTruthy()
      view.search('Node')
      const announcement = () => view.root.querySelector('.dinkster-search-status[role="status"]')?.textContent
      expect(announcement()).toBe('[Results] 2 / 1: Node')
      key(view.input, 'ArrowDown')
      expect(announcement()).toBe('[Results] 2 / 2: Another node')
      view.search('missing')
      expect(announcement()).toBe('[No matches] missing')
    } finally { view.dispose() }
  })

  it('offers help without placement and clamps the measured surface at canvas edges', async () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 320 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 240 })
    const help = vi.fn()
    const commit = vi.fn()
    const documented = entry('docs', 'Documented')
    const view = mount(() => [{ ...documented, schema: { ...documented.schema!, hasDocs: true } }], {
      anchor: { x: 235, y: 175, worldX: 0, worldY: 0 }, bounds: { width: 240, height: 180 }, onCommit: commit, onHelp: help,
    })
    try {
      view.search('Documented')
      await flush()
      const dialog = view.root.querySelector<HTMLElement>('[data-testid="node-palette"]')!
      expect([dialog.style.left, dialog.style.top, dialog.style.maxWidth, dialog.style.maxHeight]).toEqual(['4px', '4px', '232px', '172px'])
      button(view.root, 'Help').click()
      expect(help).toHaveBeenCalledOnce()
      expect(commit).not.toHaveBeenCalled()
    } finally {
      view.dispose()
      if (width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)['offsetWidth']
      if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)['offsetHeight']
    }
  })
})

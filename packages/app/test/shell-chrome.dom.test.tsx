// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { createSignal, onCleanup } from 'solid-js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  asPromptId,
  coreMenuContributions,
  createMenuRegistry,
  registerCatalog,
  setLocale,
  type NodeSchema,
  type ResolvedMenuGroup,
  type WorkflowDocument,
} from '@dinkster/core'
import {
  DinksterAppMenu,
  dispatchAppCommandKey,
} from '../src/App.js'
import {
  ActivityBarButton,
  CustomizeLayoutButton,
  DockZoneHost,
  FloatingPanelHost,
  ShellResizeHandle,
  ShellRegionIcon,
  TransientStatus,
} from '../src/ShellChrome.js'
import { CanvasViewControls } from '../src/CanvasHost.js'
import { ContextMenu } from '../src/ContextMenu.js'
import { CustomizeLayoutDialog } from '../src/CustomizeLayoutDialog.js'
import { APP_EDITOR_KIND, GRAPH_EDITOR_KIND } from '../src/editors.js'
import { AppState, workflowExportFilename } from '../src/app-state.js'
import type { PanelDescriptor } from '../src/panels.js'
import { CommandRegistry, KeybindingRegistry, SettingsRegistry } from '../src/settings.js'
import { canvasMenuContext, resolveNodeMenuGroups } from '../src/menu-target.js'
import { attachDomTooltips, DOM_TOOLTIP_SESSION_GRACE_MS, TooltipController } from '../src/tooltips.js'

afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  setLocale('en')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const click = (element: Element): void => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function menuFixture(saveDisabled = false) {
  const commands = new CommandRegistry()
  const settings = new SettingsRegistry(undefined)
  const keybindings = new KeybindingRegistry(settings)
  const save = vi.fn()
  const register = (id: string, label: string, combo: string, run = vi.fn(), enabled?: () => boolean) => {
    commands.register({ id, label, run, ...(enabled ? { enabled } : {}) })
    keybindings.register({ command: id, combo })
  }
  register('workflow.open', 'Open workflow library', 'Ctrl+O')
  commands.register({ id: 'workflow.importFile', label: 'Import workflow from file', run: vi.fn() })
  register('workflow.save', 'Save workflow', 'Ctrl+S', save, () => !saveDisabled)
  commands.register({ id: 'workflow.export', label: 'Export workflow', run: vi.fn() })
  register('edit.undo', 'Undo', 'Ctrl+Z')
  register('edit.redo', 'Redo', 'Ctrl+Shift+Z')
  register('edit.selectAll', 'Select all', 'Ctrl+A')
  register('view.zoomIn', 'Zoom in', 'Alt+=')
  register('view.zoomOut', 'Zoom out', 'Alt+-')
  register('view.fitSelection', 'Fit view to selection', '.')
  commands.register({ id: 'layout.customize', label: 'Customize layout', run: vi.fn() })
  register('settings.open', 'Open settings', 'Ctrl+,')
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => (
    <DinksterAppMenu commands={commands} keybindings={keybindings} />
  ), root)
  return { root, save, keybindings, dispose }
}

function canvasViewControlsFixture() {
  const root = document.createElement('div')
  document.body.append(root)
  const [activeView, setActiveView] = createSignal<string>(GRAPH_EDITOR_KIND)
  const [viewMenuOpen, setViewMenuOpen] = createSignal(false)
  const [lensMenuOpen, setLensMenuOpen] = createSignal(false)
  const selectView = vi.fn((kind: string) => {
    setActiveView(kind)
    setViewMenuOpen(false)
  })
  const selectLens = vi.fn()
  const setAllNetsDisplay = vi.fn()
  const dispose = render(() => (
    <CanvasViewControls
      drilled={false}
      disabled={false}
      activeView={activeView()}
      activeLens={{ id: 'standard', label: 'Standard' }}
      lenses={[
        { id: 'standard', label: 'Standard', description: 'Default graph presentation.' },
        { id: 'types', label: 'Types', description: 'Show type details.' },
        { id: 'data', label: 'Data', description: 'Show recorded execution data.' },
      ]}
      viewMenuOpen={viewMenuOpen()}
      lensMenuOpen={lensMenuOpen()}
      onToggleViewMenu={() => setViewMenuOpen((open) => !open)}
      onToggleLensMenu={() => setLensMenuOpen((open) => !open)}
      onSelectView={selectView}
      onSelectLens={selectLens}
      onSetAllNetsDisplay={setAllNetsDisplay}
    />
  ), root)
  return { root, selectView, selectLens, setAllNetsDisplay, setViewMenuOpen, setLensMenuOpen, dispose }
}

describe('canvas view controls', () => {
  it('shows the active view name and lists both views', () => {
    const { root, setViewMenuOpen, dispose } = canvasViewControlsFixture()
    expect(root.querySelector('[data-testid="views-switcher"]')?.textContent).toContain('Graph')
    setViewMenuOpen(true)
    const items = [...root.querySelectorAll('.view-menu [role="menuitemradio"]')]
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Graph', 'App view'])
    dispose()
  })

  it('offers graph-wide named-net display actions for all three modes', () => {
    const { root, setAllNetsDisplay, setViewMenuOpen, dispose } = canvasViewControlsFixture()
    setViewMenuOpen(true)
    const noodle = root.querySelector<HTMLButtonElement>('[data-testid="net-display-all-noodle"]')!
    const tags = root.querySelector<HTMLButtonElement>('[data-testid="net-display-all-tags"]')!
    const guide = root.querySelector<HTMLButtonElement>('[data-testid="net-display-all-guide"]')!
    expect(noodle.getAttribute('role')).toBe('menuitem')
    noodle.click()
    tags.click()
    guide.click()
    expect(setAllNetsDisplay.mock.calls.map((call) => call[0])).toEqual(['noodle', 'tags', 'guide'])
    dispose()
  })

  it('switches the editor kind and updates the active view name', () => {
    const { root, selectView, setViewMenuOpen, dispose } = canvasViewControlsFixture()
    setViewMenuOpen(true)
    click([...root.querySelectorAll('.view-menu [role="menuitemradio"]')][1]!)
    expect(selectView).toHaveBeenCalledWith(APP_EDITOR_KIND)
    expect(root.querySelector('[data-testid="views-switcher"]')?.textContent).toContain('App')
    dispose()
  })

  it('titles the lens menu and omits stale app-view content', () => {
    const { root, setLensMenuOpen, dispose } = canvasViewControlsFixture()
    setLensMenuOpen(true)
    expect(root.querySelector('.lens-menu-heading')?.textContent).toBe('Lenses')
    expect(root.textContent).not.toContain('App views - coming soon')
    expect(root.querySelector('[data-testid="views-placeholder"]')).toBeNull()
    dispose()
  })

  it('keeps App view and Data lens reachable from their per-tab menus', () => {
    const { root, selectView, selectLens, setViewMenuOpen, setLensMenuOpen, dispose } = canvasViewControlsFixture()
    setViewMenuOpen(true)
    click([...root.querySelectorAll('.view-menu [role="menuitemradio"]')].find((item) => item.textContent?.includes('App view'))!)
    expect(selectView).toHaveBeenCalledWith(APP_EDITOR_KIND)

    setLensMenuOpen(true)
    click([...root.querySelectorAll('.lens-menu [role="menuitemradio"]')].find((item) => item.textContent?.includes('Data'))!)
    expect(selectLens).toHaveBeenCalledWith('data')
    dispose()
  })

  it('exposes delegated tooltip hints on both controls', () => {
    const { root, dispose } = canvasViewControlsFixture()
    expect(root.querySelector('[data-testid="views-switcher"]')?.getAttribute('data-tooltip-label')).toBe('View: how this tab is edited')
    expect(root.querySelector('[data-testid="lens-switcher"]')?.getAttribute('data-tooltip-label')).toBe('Lens: how the graph is displayed')
    dispose()
  })

  it('reactively translates mounted view chrome without replacing menus or registry-owned lens data', () => {
    registerCatalog('de-DE', {
      'canvas.viewControls.active.graph': '[Diagrammansicht]',
      'canvas.viewControls.heading.lenses': '[Ansichtenlinsen]',
      'canvas.viewControls.heading.namedNets': '[Benannte Netze]',
      'canvas.viewControls.heading.views': '[Editoransichten]',
      'canvas.viewControls.lens.tooltip': '[Diagrammdarstellung wahlen]',
      'canvas.viewControls.namedNets.guides.description': '[Tags mit gestrichelten Leitkurven]',
      'canvas.viewControls.namedNets.guides.label': '[Alle als Tags und Leitkurven]',
      'canvas.viewControls.namedNets.noodles.description': '[Alle Verbindungen als Kurven zeichnen]',
      'canvas.viewControls.namedNets.noodles.label': '[Alle als Kurven]',
      'canvas.viewControls.namedNets.tags.description': '[Nur Set/Get-Tags anzeigen]',
      'canvas.viewControls.namedNets.tags.label': '[Alle als Tags]',
      'canvas.viewControls.view.app': '[App-Ansicht]',
      'canvas.viewControls.view.tooltip': '[Bearbeitungsansicht wahlen]',
      'Standard': '[Nicht ubersetzen]',
    })
    const { root, setViewMenuOpen, setLensMenuOpen, dispose } = canvasViewControlsFixture()
    setViewMenuOpen(true)
    const viewMenu = root.querySelector('.view-menu')!
    const graphItem = viewMenu.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!
    graphItem.focus()

    setLocale('de-DE')

    expect(root.querySelector('[data-testid="views-switcher"]')?.textContent).toContain('[Diagrammansicht]')
    expect(root.querySelector('[data-testid="views-switcher"]')?.getAttribute('data-tooltip-label')).toBeNull()
    expect(root.querySelector('.view-menu')).toBe(viewMenu)
    expect(document.activeElement).toBe(graphItem)
    expect(viewMenu.textContent).toContain('[Editoransichten]')
    expect(viewMenu.textContent).toContain('[App-Ansicht]')
    expect(viewMenu.textContent).toContain('[Benannte Netze]')
    expect(viewMenu.textContent).toContain('[Alle als Kurven][Alle Verbindungen als Kurven zeichnen]')
    expect(viewMenu.textContent).toContain('[Alle als Tags][Nur Set/Get-Tags anzeigen]')
    expect(viewMenu.textContent).toContain('[Alle als Tags und Leitkurven][Tags mit gestrichelten Leitkurven]')

    setViewMenuOpen(false)
    expect(root.querySelector('[data-testid="views-switcher"]')?.getAttribute('data-tooltip-label')).toBe('[Bearbeitungsansicht wahlen]')
    setLensMenuOpen(true)
    const lensMenu = root.querySelector('.lens-menu')!
    expect(lensMenu.textContent).toContain('[Ansichtenlinsen]')
    expect(lensMenu.textContent).toContain('StandardDefault graph presentation.')
    expect(root.querySelector('[data-testid="lens-switcher"]')?.getAttribute('data-tooltip-label')).toBeNull()
    setLensMenuOpen(false)
    expect(root.querySelector('[data-testid="lens-switcher"]')?.getAttribute('data-tooltip-label')).toBe('[Diagrammdarstellung wahlen]')
    dispose()
  })
})

describe('Dinkster app menu', () => {
  it('updates registered command and setting labels from the active locale catalog', () => {
    registerCatalog('de-DE', {
      'command.workflow.open': '[Arbeitsablaufbibliothek offnen]',
      'settings.canvas.grid.visible': '[Punktraster anzeigen]',
      'settings.canvas.scrollBehavior.option.pan': '[Verschieben]',
    })
    const app = new AppState()
    expect(app.commands.get('workflow.open')?.label).toBe('Open workflow library')
    expect(app.settings.list().find((setting) => setting.id === 'canvas.grid.visible')?.name).toBe('Show dot grid')

    setLocale('de-DE')

    expect(app.commands.get('workflow.open')?.label).toBe('[Arbeitsablaufbibliothek offnen]')
    expect(app.settings.list().find((setting) => setting.id === 'canvas.grid.visible')?.name).toBe('[Punktraster anzeigen]')
    expect(app.settings.list().find((setting) => setting.id === 'canvas.scrollBehavior')?.options?.[1]?.label).toBe('[Verschieben]')
    app.dispose()
  })

  it('lists workflow library, file import, save, and export in adjacent groups', () => {
    const { root, dispose } = menuFixture()
    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)

    const items = [...root.querySelectorAll('[data-testid="context-menu-item"]')]
    expect(items.map((item) => item.getAttribute('data-item-id'))).toEqual([
      'workflow.open', 'workflow.importFile', 'workflow.save', 'workflow.export',
      'edit.undo', 'edit.redo', 'edit.selectAll',
      'view.zoomIn', 'view.zoomOut', 'view.fitSelection', 'layout.customize',
      'settings.open',
    ])
    expect(items.slice(0, 4).map((item) => item.querySelector('.menu-label')?.textContent)).toEqual([
      'Open workflow library', 'Import workflow from file', 'Save workflow', 'Export workflow',
    ])
    expect(root.querySelectorAll('.menu-separator')).toHaveLength(4)
    dispose()
  })

  it('shows current shortcut bindings, including overrides, and omits unbound hints', () => {
    const { root, keybindings, dispose } = menuFixture()
    keybindings.set('edit.undo', 'Meta+U')
    keybindings.set('view.fitSelection', null)
    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)

    expect(root.querySelector('[data-item-id="workflow.open"] .menu-hint')?.textContent).toBe('ctrl+o')
    expect(root.querySelector('[data-item-id="edit.undo"] .menu-hint')?.textContent).toBe('meta+u')
    expect(root.querySelector('[data-item-id="view.fitSelection"] .menu-hint')).toBeNull()
    dispose()
  })

  it('dispatches the moved Save action through Arrow and Enter keyboard navigation', async () => {
    const { root, save, dispose } = menuFixture()
    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const menu = root.querySelector('[data-testid="context-menu"]')!
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(save).toHaveBeenCalledOnce()
    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(document.activeElement).toBe(root.querySelector('[data-testid="dinkster-menu-button"]'))
    dispose()
  })

  it('closes with Escape from keyboard navigation', async () => {
    const { root, dispose } = menuFixture()
    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    root.querySelector('[data-testid="context-menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(document.activeElement).toBe(root.querySelector('[data-testid="dinkster-menu-button"]'))
    dispose()
  })

  it('closes on a second trigger click and on an outside pointer press', async () => {
    const { root, dispose } = menuFixture()
    const button = root.querySelector('[data-testid="dinkster-menu-button"]')!
    click(button)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    click(button)
    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()

    click(button)
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()
    dispose()
  })

  it('exposes disabled Save semantics without dispatching it', async () => {
    const { root, save, dispose } = menuFixture(true)
    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const saveItem = root.querySelector('[data-item-id="workflow.save"]')!
    expect(saveItem.getAttribute('aria-disabled')).toBe('true')
    root.querySelector('[data-testid="context-menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    root.querySelector('[data-testid="context-menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(save).not.toHaveBeenCalled()
    dispose()
  })

  it('does not dispatch a disabled command row by mouse', () => {
    const commands = new CommandRegistry()
    const settings = new SettingsRegistry(undefined)
    const keybindings = new KeybindingRegistry(settings)
    const undo = vi.fn()
    commands.register({ id: 'edit.undo', label: 'Undo', run: undo, enabled: () => false })
    keybindings.register({ command: 'edit.undo', combo: 'Ctrl+Z' })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <DinksterAppMenu commands={commands} keybindings={keybindings} />
    ), root)
    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)
    const item = root.querySelector('[data-item-id="edit.undo"]')!
    expect(item.getAttribute('aria-disabled')).toBe('true')
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(undo).not.toHaveBeenCalled()
    dispose()
  })

  it('tracks undo and redo availability from the active document history', () => {
    const app = new AppState()
    const tab = app.createWorkflow()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <DinksterAppMenu
        commands={app.commands}
        keybindings={app.keybindings}
        invalidationSignals={() => [tab.store.document]}
      />
    ), root)

    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)
    expect(root.querySelector('[data-item-id="edit.undo"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(root.querySelector('[data-item-id="edit.redo"]')?.getAttribute('aria-disabled')).toBe('true')
    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)

    expect(tab.store.dispatch({
      command: 'node.add',
      params: { graphId: tab.store.doc.root, type: 'TestNode', position: { x: 0, y: 0 } },
    }).ok).toBe(true)
    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()
    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)
    expect(root.querySelector('[data-item-id="edit.undo"]')?.getAttribute('aria-disabled')).toBe('false')
    root.querySelector('[data-item-id="edit.undo"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)
    expect(root.querySelector('[data-item-id="edit.redo"]')?.getAttribute('aria-disabled')).toBe('false')
    dispose()
  })

  it('disables canvas commands without a bridge and keeps fit enabled with an empty selection', () => {
    const app = new AppState()
    app.createWorkflow()
    const fitSelection = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <DinksterAppMenu
        commands={app.commands}
        keybindings={app.keybindings}
        invalidationSignals={() => [app.canvasBridge]}
      />
    ), root)

    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)
    expect(root.querySelector('[data-item-id="edit.selectAll"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(root.querySelector('[data-item-id="view.fitSelection"]')?.getAttribute('aria-disabled')).toBe('true')
    app.canvasBridge.set({
      selectedNodes: () => [],
      groupMembers: () => undefined,
      deleteSelection: () => {},
      selectAll: () => {},
      setSelectedMode: () => {},
      toggleSelectedCollapsed: () => {},
      zoomBy: () => {},
      fitSelection,
      armNodePlacement: () => false,
    })
    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()

    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)
    const fit = root.querySelector('[data-item-id="view.fitSelection"]')!
    expect(fit.getAttribute('aria-disabled')).toBe('false')
    fit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(fitSelection).toHaveBeenCalledOnce()
    dispose()
  })

  it('dispatches Select all through the current canvas bridge', () => {
    const app = new AppState()
    app.createWorkflow()
    const selectAll = vi.fn()
    app.canvasBridge.set({
      selectedNodes: () => [],
      groupMembers: () => undefined,
      deleteSelection: () => {},
      selectAll,
      setSelectedMode: () => {},
      toggleSelectedCollapsed: () => {},
      zoomBy: () => {},
      fitSelection: () => {},
      armNodePlacement: () => false,
    })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <DinksterAppMenu
        commands={app.commands}
        keybindings={app.keybindings}
        invalidationSignals={() => [app.canvasBridge]}
      />
    ), root)

    click(root.querySelector('[data-testid="dinkster-menu-button"]')!)
    root.querySelector('[data-item-id="edit.selectAll"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    expect(selectAll).toHaveBeenCalledOnce()
    dispose()
  })
})

describe('canvas context menu availability', () => {
  it('marks create empty subgraph aria-disabled and refuses invocation for a frozen tab', () => {
    const registry = createMenuRegistry()
    for (const contribution of coreMenuContributions()) registry.register(contribution)
    const doc = {
      graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
      view: { graphs: { g0: { nodes: {} } } },
    } as unknown as WorkflowDocument
    const groups = resolveNodeMenuGroups(registry, canvasMenuContext({
      doc,
      namedNets: true,
      graphId: 'g0',
      target: { kind: 'canvas' },
      selection: { nodes: [], links: [], reroutes: [], valueSources: [], selectors: [] },
      worldX: 10,
      worldY: 20,
    }), false, false)
    const onInvoke = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <ContextMenu
        menu={{ x: 10, y: 20, worldX: 10, worldY: 20, groups }}
        onInvoke={onInvoke}
        onClose={() => undefined}
      />
    ), root)
    const item = root.querySelector('[data-item-id="core.canvas.createSubgraph"]')!
    expect(item.getAttribute('aria-disabled')).toBe('true')
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onInvoke).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="context-menu"]')).not.toBeNull()
    dispose()
  })
})

describe('cascading context menus', () => {
  const groups: readonly ResolvedMenuGroup[] = [{
    group: '10-test',
    items: [{
      id: 'test.parent',
      label: 'Parent',
      children: [{
        id: 'test.child',
        label: 'Child',
        children: [{
          id: 'test.deep',
          label: 'Deep action',
          action: { kind: 'host', action: 'deep' },
        }],
      }, {
        id: 'test.sibling',
        label: 'Sibling action',
        action: { kind: 'host', action: 'sibling' },
      }],
    }, {
      id: 'test.root-sibling',
      label: 'Root sibling',
      action: { kind: 'host', action: 'root-sibling' },
    }],
  }]

  function fixture(menuGroups: readonly ResolvedMenuGroup[] = groups) {
    const onInvoke = vi.fn()
    const onClose = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <ContextMenu
        menu={{ x: 10, y: 20, worldX: 10, worldY: 20, groups: menuGroups }}
        onInvoke={onInvoke}
        onClose={onClose}
      />
    ), root)
    return { root, onInvoke, onClose, dispose }
  }

  it('renders decorative menu icons and visible accessible shortcut pills', () => {
    const iconGroups: readonly ResolvedMenuGroup[] = [{
      group: '10-test',
      items: [{
        id: 'test.icon',
        label: 'Delete',
        icon: 'trash-2',
        shortcut: 'Ctrl+Delete',
        action: { kind: 'host', action: 'delete' },
      }],
    }]
    const { root, dispose } = fixture(iconGroups)
    const row = root.querySelector('[data-item-id="test.icon"]')!
    expect(row.querySelector('[data-testid="menu-icon"] svg')).not.toBeNull()
    expect(row.querySelector('[data-testid="menu-shortcut"]')?.textContent).toBe('Ctrl+Delete')
    expect(row.textContent).toContain('Ctrl+Delete')
    dispose()
  })

  it('opens child and deeper-child panels on hover and invokes only the terminal row', () => {
    const { root, onInvoke, dispose } = fixture()
    root.querySelector('[data-item-id="test.parent"]')!
      .dispatchEvent(new MouseEvent('mouseenter'))
    expect(root.querySelectorAll('[data-testid="context-submenu"]')).toHaveLength(1)
    expect(onInvoke).not.toHaveBeenCalled()

    root.querySelector('[data-item-id="test.child"]')!
      .dispatchEvent(new MouseEvent('mouseenter'))
    expect(root.querySelectorAll('[data-testid="context-submenu"]')).toHaveLength(2)
    expect(onInvoke).not.toHaveBeenCalled()

    root.querySelector('[data-item-id="test.deep"]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onInvoke).toHaveBeenCalledOnce()
    expect(onInvoke.mock.calls[0]![0]).toMatchObject({ id: 'test.deep' })
    dispose()
  })

  it('keeps an open child panel mounted while hovering its terminal rows', () => {
    const { root, dispose } = fixture()
    root.querySelector('[data-item-id="test.parent"]')!
      .dispatchEvent(new MouseEvent('mouseenter'))
    const childPanel = root.querySelector('[data-testid="context-submenu"]')
    expect(childPanel).not.toBeNull()

    root.querySelector('[data-item-id="test.sibling"]')!
      .dispatchEvent(new MouseEvent('mouseenter'))
    expect(root.querySelector('[data-testid="context-submenu"]')).toBe(childPanel)
    dispose()
  })

  it('keeps an open child owned by its expanded parent when the root highlight moves', () => {
    const { root, dispose } = fixture()
    root.querySelector('[data-item-id="test.parent"]')!
      .dispatchEvent(new MouseEvent('mouseenter'))
    const cascade = root.querySelector('.context-menu-cascade')!
    const childPanel = root.querySelector('[data-menu-depth="1"]')!
    const parent = root.querySelector('[data-item-id="test.parent"]')!
    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))

    expect(root.querySelector('[data-item-id="test.root-sibling"]')!.classList.contains('active')).toBe(true)
    expect(parent.getAttribute('aria-expanded')).toBe('true')
    expect(parent.getAttribute('aria-controls')).toBe(childPanel.id)
    expect(childPanel.getAttribute('aria-labelledby')).toBe(parent.id)
    dispose()
  })

  it('preserves an open panel node and scrollTop until its submenu path closes', async () => {
    const longGroups: readonly ResolvedMenuGroup[] = [{
      group: '10-long',
      items: [{
        id: 'long.parent',
        label: 'Long parent',
        children: [{
          id: 'long.child',
          label: 'Child submenu',
          children: [{ id: 'long.deep', label: 'Deep', action: { kind: 'host', action: 'deep' } }],
        }, ...Array.from({ length: 30 }, (_, index) => ({
          id: `long.leaf-${index}`,
          label: `Leaf ${index}`,
          action: { kind: 'host' as const, action: `leaf-${index}` },
        }))],
      }],
    }]
    const { root, dispose } = fixture(longGroups)
    const cascade = root.querySelector('.context-menu-cascade')!
    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    const childPanel = root.querySelector('[data-menu-depth="1"]') as HTMLDivElement
    childPanel.scrollTop = 72

    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await Promise.resolve()
    expect(root.querySelector('[data-menu-depth="1"]')).toBe(childPanel)
    expect(childPanel.scrollTop).toBe(72)

    root.querySelector('[data-item-id="long.child"]')!
      .dispatchEvent(new MouseEvent('mouseenter'))
    await Promise.resolve()
    expect(root.querySelector('[data-menu-depth="1"]')).toBe(childPanel)
    expect(childPanel.scrollTop).toBe(72)

    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await Promise.resolve()
    expect(root.querySelector('[data-menu-depth="1"]')).toBe(childPanel)
    expect(childPanel.scrollTop).toBe(72)

    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(root.querySelector('[data-menu-depth="1"]')).toBeNull()
    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(root.querySelector('[data-menu-depth="1"]')).not.toBe(childPanel)
    expect((root.querySelector('[data-menu-depth="1"]') as HTMLDivElement).scrollTop).toBe(0)
    dispose()
  })

  it('uses one ARIA menu composite across nested keyboard traversal', async () => {
    const { root, onInvoke, dispose } = fixture()
    await Promise.resolve()
    const cascade = root.querySelector('.context-menu-cascade') as HTMLDivElement
    expect(document.activeElement).toBe(cascade)
    expect(root.querySelectorAll('[role="menu"]')).toHaveLength(1)
    expect(cascade.getAttribute('aria-activedescendant')).toBe('context-menu-item-0-0')

    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(root.querySelectorAll('[data-testid="context-submenu"]')).toHaveLength(1)
    const parent = root.querySelector('[data-item-id="test.parent"]')!
    const childPanel = root.querySelector('[data-menu-depth="1"]')!
    expect(parent.getAttribute('aria-haspopup')).toBe('menu')
    expect(parent.getAttribute('aria-expanded')).toBe('true')
    expect(parent.getAttribute('aria-controls')).toBe(childPanel.id)
    expect(childPanel.getAttribute('role')).toBe('group')
    expect(childPanel.getAttribute('aria-labelledby')).toBe(parent.id)
    expect(cascade.getAttribute('aria-activedescendant')).toBe('context-menu-item-1-0')
    expect(cascade.contains(document.getElementById(cascade.getAttribute('aria-activedescendant')!))).toBe(true)
    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(root.querySelectorAll('[data-testid="context-submenu"]')).toHaveLength(2)
    const child = root.querySelector('[data-item-id="test.child"]')!
    const deepPanel = root.querySelector('[data-menu-depth="2"]')!
    expect(child.getAttribute('aria-expanded')).toBe('true')
    expect(child.getAttribute('aria-controls')).toBe(deepPanel.id)
    expect(deepPanel.getAttribute('aria-labelledby')).toBe(child.id)
    expect(cascade.getAttribute('aria-activedescendant')).toBe('context-menu-item-2-0')
    expect(cascade.contains(document.getElementById(cascade.getAttribute('aria-activedescendant')!))).toBe(true)
    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(root.querySelectorAll('[data-testid="context-submenu"]')).toHaveLength(1)
    expect(child.getAttribute('aria-expanded')).toBe('false')
    expect(child.getAttribute('aria-controls')).toBeNull()
    expect(document.activeElement).toBe(cascade)

    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onInvoke).toHaveBeenCalledOnce()
    expect(onInvoke.mock.calls[0]![0]).toMatchObject({ id: 'test.deep' })
    dispose()
  })

  it('dismisses on Escape and focus departure', () => {
    const first = fixture()
    const cascade = first.root.querySelector('.context-menu-cascade')!
    cascade.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(first.onClose).toHaveBeenCalledWith('escape')
    first.dispose()

    const second = fixture()
    const outside = document.createElement('button')
    document.body.append(outside)
    second.root.querySelector('.context-menu-cascade')!.dispatchEvent(new FocusEvent('focusout', {
      bubbles: true,
      relatedTarget: outside,
    }))
    expect(second.onClose).toHaveBeenCalledWith('focusout')
    second.dispose()
  })
})

describe('workflow file commands', () => {
  it('sanitizes export filenames and falls back for an empty title', () => {
    expect(workflowExportFilename('  My: Flow?/Final.  ')).toBe('My- Flow--Final.json')
    expect(workflowExportFilename('fun-flow-01')).toBe('fun-flow-01.json')
    expect(workflowExportFilename('line\nwith\0controls')).toBe('line-with-controls.json')
    expect(workflowExportFilename('...')).toBe('workflow.json')
  })

  it('exports pretty stamped JSON, triggers a download, and revokes its object URL', async () => {
    const app = new AppState()
    app.tabs.update((tabs) => tabs.map((tab) => tab.id === app.activeTabId.get()
      ? { ...tab, title: 'fun\nflow\0-01' }
      : tab))
    const tab = app.activeTab()!
    const expected = app.exportDocument(tab.id)
    let exportedBlob: Blob | undefined
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (!(blob instanceof Blob)) throw new Error('workflow export did not create a Blob')
      exportedBlob = blob
      return 'blob:workflow-export'
    })
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let download = ''
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      download = this.download
    })

    expect(app.commands.get('workflow.export')?.enabled?.()).toBe(true)
    expect(app.exportWorkflow(tab.id)).toBe(true)
    expect(createUrl).toHaveBeenCalledOnce()
    expect(clickAnchor).toHaveBeenCalledOnce()
    expect(download).toBe('fun-flow--01.json')
    expect(exportedBlob?.type).toBe('application/x-dinkster-workflow+json')
    const text = await exportedBlob!.text()
    expect(text).toContain('\n  "format": "dinkster-workflow"')
    expect(JSON.parse(text)).toEqual(expected)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(revokeUrl).toHaveBeenCalledWith('blob:workflow-export')
  })

  it('revokes a failed export URL and reports the failure visibly', () => {
    vi.useFakeTimers()
    const app = new AppState()
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:failed-export')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('download blocked') })

    expect(app.exportWorkflow(app.activeTab()!.id)).toBe(false)
    expect(app.problems.get().some((problem) => problem.code === 'workflow.exportFailed')).toBe(true)
    expect(app.transientStatus.get()).toContain('download blocked')
    vi.runOnlyPendingTimers()
    expect(revokeUrl).toHaveBeenCalledWith('blob:failed-export')
    expect(document.querySelector('a[download]')).toBeNull()
  })

  it('imports unchanged exported JSON as a new tab without replacing the dirty original', async () => {
    const app = new AppState()
    const original = app.activeTab()!
    expect(app.dispatchTo(original, {
      command: 'node.add',
      params: { graphId: original.store.doc.root, type: 'ImportedTestNode', position: { x: 10, y: 20 } },
    }).ok).toBe(true)
    expect(original.store.canUndo).toBe(true)
    const source = app.exportDocument(original.id)!
    const before = app.tabs.get().length

    expect(await app.importWorkflowFile({
      name: 'local-flow.json',
      text: async () => JSON.stringify(source),
    })).toBe(true)
    expect(app.tabs.get()).toHaveLength(before + 1)
    expect(app.tabs.get()).toContain(original)
    expect(app.isTabDirty(original.id)).toBe(true)
    expect(original.store.canUndo).toBe(true)
    expect(Object.values(original.store.doc.graphs[original.store.doc.root]!.nodes).some((node) => node.type === 'ImportedTestNode')).toBe(true)
    expect(app.activeTab()?.title).toBe('local-flow')
    expect(app.activeTab()?.store.doc).toEqual({
      ...source,
      lineage: expect.stringMatching(`${source.lineage}-import-`),
    })
    expect(app.transientStatus.get()).toBe('Imported local-flow.json')
  })

  it('preserves the document lineage when a local import does not collide', async () => {
    const app = new AppState()
    const source = {
      ...app.exportDocument(app.activeTab()!.id)!,
      lineage: 'lineage-non-colliding-import',
    }
    expect(await app.importWorkflowFile({
      name: 'independent.json',
      text: async () => JSON.stringify(source),
    })).toBe(true)
    expect(app.activeTab()?.store.doc).toEqual(source)
    expect(app.activeTab()?.id).toBe('lineage-non-colliding-import')
  })

  it('reports malformed imported JSON visibly and opens no tab', async () => {
    const app = new AppState()
    const before = app.tabs.get().length

    expect(await app.importWorkflowFile({
      name: 'broken.json',
      text: async () => '{not json',
    })).toBe(false)
    expect(app.tabs.get()).toHaveLength(before)
    expect(app.problems.get().some((problem) => problem.code === 'workflow.importFailed')).toBe(true)
    expect(app.transientStatus.get()).toContain('Could not import broken.json')
  })

  it('reports parseable non-workflow JSON and opens no tab', async () => {
    const app = new AppState()
    const before = app.tabs.get().length
    expect(await app.importWorkflowFile({ name: 'wrong.json', text: async () => '{"hello":"world"}' })).toBe(false)
    expect(app.tabs.get()).toHaveLength(before)
    expect(app.problems.get().length).toBeGreaterThan(0)
    expect(app.transientStatus.get()).toContain('invalid workflow document')
  })

  it('routes full LiteGraph JSON through the existing legacy importer', async () => {
    const app = new AppState()
    const schema: NodeSchema = {
      type: 'UnknownLegacyNode',
      displayName: 'Legacy test node',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [],
    }
    const backend = app.backends.get()[0]!
    backend.registry.set({
      connection: backend.id,
      hash: 'legacy-test',
      schemas: new Map([[schema.type, schema]]),
      diagnostics: [],
      resolve: (type) => type === schema.type ? schema : undefined,
    })
    const legacy = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [{ id: 1, type: 'UnknownLegacyNode', pos: [10, 20], size: [100, 80], widgets_values: [] }],
      links: [],
      groups: [],
      config: {},
      extra: {},
      version: 0.4,
    }
    expect(await app.importWorkflowFile({ name: 'legacy.json', text: async () => JSON.stringify(legacy) })).toBe(true)
    expect(app.activeTab()?.store.doc.format).toBe('dinkster-workflow')
    expect(Object.values(app.activeTab()!.store.doc.graphs[app.activeTab()!.store.doc.root]!.nodes)[0]?.type).toBe('UnknownLegacyNode')
  })

  it('file command creates and cleans up its JSON picker on cancellation', () => {
    const clickInput = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const app = new AppState()
    const addWindowListener = vi.spyOn(window, 'addEventListener')
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    app.commands.get('workflow.importFile')!.run()
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const focusListener = addWindowListener.mock.calls.find(([type]) => type === 'focus')?.[1]
    expect(focusListener).toBeTypeOf('function')
    expect(clickInput).toHaveBeenCalledOnce()
    expect(picker.accept).toBe('.json,application/json')
    expect(picker.hidden).toBe(true)
    picker.dispatchEvent(new Event('cancel'))
    expect(document.querySelector('input[type="file"]')).toBeNull()
    expect(removeWindowListener).toHaveBeenCalledWith('focus', focusListener)
  })

  it('removes the JSON picker on change and routes the selected file through importWorkflowFile', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const app = new AppState()
    const importWorkflowFile = vi.spyOn(app, 'importWorkflowFile').mockResolvedValue(true)
    const addWindowListener = vi.spyOn(window, 'addEventListener')
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    app.commands.get('workflow.importFile')!.run()
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const focusListener = addWindowListener.mock.calls.find(([type]) => type === 'focus')?.[1]
    expect(focusListener).toBeTypeOf('function')
    const file = new File(['{}'], 'picked.json', { type: 'application/json' })
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] })
    picker.dispatchEvent(new Event('change'))

    expect(document.querySelector('input[type="file"]')).toBeNull()
    expect(importWorkflowFile).toHaveBeenCalledOnce()
    expect(importWorkflowFile).toHaveBeenCalledWith(file)
    expect(removeWindowListener).toHaveBeenCalledWith('focus', focusListener)
  })

  it('removes the JSON picker through the window-refocus fallback', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const app = new AppState()
    const addWindowListener = vi.spyOn(window, 'addEventListener')
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    app.commands.get('workflow.importFile')!.run()
    const focusListener = addWindowListener.mock.calls.find(([type]) => type === 'focus')?.[1]
    expect(focusListener).toBeTypeOf('function')
    expect(document.querySelector('input[type="file"]')).not.toBeNull()

    window.dispatchEvent(new Event('focus'))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(document.querySelector('input[type="file"]')).toBeNull()
    expect(removeWindowListener).toHaveBeenCalledWith('focus', focusListener)
  })

  it('leaves no picker elements or window focus listeners after repeated cancellations', () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const app = new AppState()
    const addWindowListener = vi.spyOn(window, 'addEventListener')
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')

    for (let invocation = 0; invocation < 3; invocation++) {
      const addCount = addWindowListener.mock.calls.length
      const removeCount = removeWindowListener.mock.calls.length
      app.commands.get('workflow.importFile')!.run()
      const focusListener = addWindowListener.mock.calls.slice(addCount).find(([type]) => type === 'focus')?.[1]
      expect(focusListener).toBeTypeOf('function')
      document.querySelector<HTMLInputElement>('input[type="file"]')!.dispatchEvent(new Event('cancel'))
      expect(removeWindowListener.mock.calls.slice(removeCount)).toContainEqual(['focus', focusListener])
    }

    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0)
    expect(addWindowListener.mock.calls.filter(([type]) => type === 'focus')).toHaveLength(3)
    expect(removeWindowListener.mock.calls.filter(([type]) => type === 'focus')).toHaveLength(3)
  })

  it('cleans up and reports when the browser refuses to open the file picker', () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => { throw new Error('picker blocked') })
    const app = new AppState()
    const addWindowListener = vi.spyOn(window, 'addEventListener')
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    app.commands.get('workflow.importFile')!.run()
    const focusListener = addWindowListener.mock.calls.find(([type]) => type === 'focus')?.[1]
    expect(focusListener).toBeTypeOf('function')
    expect(document.querySelector('input[type="file"]')).toBeNull()
    expect(removeWindowListener).toHaveBeenCalledWith('focus', focusListener)
    expect(app.problems.get().some((problem) => problem.code === 'workflow.importFailed')).toBe(true)
    expect(app.transientStatus.get()).toContain('picker blocked')
  })

  it('auto-clears transient operation feedback', () => {
    vi.useFakeTimers()
    const app = new AppState()
    app.showTransientStatus('Saved')
    expect(app.transientStatus.get()).toBe('Saved')
    vi.advanceTimersByTime(3_999)
    expect(app.transientStatus.get()).toBe('Saved')
    vi.advanceTimersByTime(1)
    expect(app.transientStatus.get()).toBeUndefined()
  })

  it('keeps transient feedback mounted and updates it as a polite live status', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const [message, setMessage] = createSignal<string | undefined>(undefined)
    const dispose = render(() => <TransientStatus message={message()} />, root)
    const status = root.querySelector('[data-testid="transient-status"]')
    expect(status?.textContent).toBe('')
    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    setMessage('Saved to Native library')
    expect(status?.textContent).toBe('Saved to Native library')
    dispose()
  })

  it('consumes unavailable Ctrl+S and reports why the targeted backend cannot save', async () => {
    const app = new AppState()
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })
    dispatchAppCommandKey(app, event, true)
    await Promise.resolve()
    await Promise.resolve()
    expect(event.defaultPrevented).toBe(true)
    expect(app.transientStatus.get()).toContain('Save requires a Dinkster backend')
  })

  it('consumes unavailable Ctrl+S when it bubbles from an input', async () => {
    const app = new AppState()
    const input = document.createElement('input')
    document.body.append(input)
    const listener = (event: KeyboardEvent): void => dispatchAppCommandKey(app, event, true)
    window.addEventListener('keydown', listener)
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    window.removeEventListener('keydown', listener)
    await Promise.resolve()
    await Promise.resolve()
    expect(event.defaultPrevented).toBe(true)
    expect(app.transientStatus.get()).toContain('Save requires a Dinkster backend')
  })

  it('leaves unavailable Ctrl+S native inside a native text scope', async () => {
    const app = new AppState()
    const scope = document.createElement('section')
    scope.setAttribute('data-native-text-scope', '')
    const summary = document.createElement('summary')
    scope.append(summary)
    document.body.append(scope)
    const listener = (event: KeyboardEvent): void => dispatchAppCommandKey(app, event, true)
    window.addEventListener('keydown', listener)
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    summary.dispatchEvent(event)
    window.removeEventListener('keydown', listener)
    await Promise.resolve()
    await Promise.resolve()
    expect(event.defaultPrevented).toBe(false)
    expect(app.transientStatus.get()).toBeUndefined()
  })

  it('consumes unavailable Ctrl+S while an aria-modal surface is open', async () => {
    const app = new AppState()
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })
    dispatchAppCommandKey(app, event, true)
    await Promise.resolve()
    await Promise.resolve()
    expect(event.defaultPrevented).toBe(true)
    expect(app.transientStatus.get()).toContain('Save requires a Dinkster backend')
  })

  it('explains that Ctrl+S cannot save an execution snapshot', async () => {
    const app = new AppState()
    const live = app.activeTab()!
    const frozen = {
      ...live,
      id: 'frozen:test',
      execution: { connection: app.backends.get()[0]!.id, prompt: asPromptId('frozen-test') },
    }
    app.tabs.update((tabs) => [...tabs, frozen])
    app.activeTabId.set(frozen.id)
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })
    dispatchAppCommandKey(app, event, true)
    await Promise.resolve()
    await Promise.resolve()
    expect(event.defaultPrevented).toBe(true)
    expect(app.transientStatus.get()).toBe('Save is unavailable for an execution snapshot')
  })

  it('dispatches extract and flatten through their registered keyboard shortcuts', () => {
    const app = new AppState()
    const extractSubgraph = vi.fn(() => true)
    const flattenSubgraph = vi.fn(() => true)
    app.canvasBridge.set({
      extractSubgraph,
      flattenSubgraph,
      canExtractSubgraph: () => true,
      canFlattenSubgraph: () => true,
    } as never)
    const extract = new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, shiftKey: true, cancelable: true })
    const flatten = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, cancelable: true })
    dispatchAppCommandKey(app, extract, true)
    dispatchAppCommandKey(app, flatten, true)
    expect(extract.defaultPrevented).toBe(true)
    expect(flatten.defaultPrevented).toBe(true)
    expect(extractSubgraph).toHaveBeenCalledOnce()
    expect(flattenSubgraph).toHaveBeenCalledOnce()
  })
})

describe('Customize layout topbar button', () => {
  it('updates its accessible name while mounted and dispatches layout.customize on activation', () => {
    registerCatalog('de-DE', { 'command.layout.customize': '[Anordnung andern]' })
    const commands = new CommandRegistry()
    const customize = vi.fn()
    commands.register({ id: 'layout.customize', label: 'Customize layout', run: customize })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <CustomizeLayoutButton commands={commands} />, root)

    const button = root.querySelector<HTMLButtonElement>('[data-testid="customize-layout-button"]')!
    expect(button.getAttribute('aria-label')).toBe('Customize layout')
    expect(button.getAttribute('data-tooltip-label')).toBe('Customize layout')
    setLocale('de-DE')
    expect(root.querySelector('[data-testid="customize-layout-button"]')).toBe(button)
    expect(button.getAttribute('aria-label')).toBe('[Anordnung andern]')
    expect(button.getAttribute('data-tooltip-label')).toBe('[Anordnung andern]')
    click(button)
    expect(customize).toHaveBeenCalledOnce()
    dispose()
  })
})

describe('shell region icons', () => {
  it('renders outlined panel regions and fills only the active region', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const [active, setActive] = createSignal(false)
    const [region, setRegion] = createSignal<'left' | 'bottom' | 'right'>('left')
    const dispose = render(() => <ShellRegionIcon region={region()} active={active()} />, root)

    expect(root.querySelectorAll('.shell-region-icon-frame')).toHaveLength(1)
    for (const [next, expected] of [
      ['left', { x: '2', y: '2', width: '5', height: '16' }],
      ['bottom', { x: '2', y: '13', width: '20', height: '5' }],
      ['right', { x: '17', y: '2', width: '5', height: '16' }],
    ] as const) {
      setRegion(next)
      setActive(false)
      const panel = root.querySelector(`[data-region="${next}"]`)!
      expect(panel.getAttribute('data-active')).toBe('false')
      expect(Object.fromEntries(['x', 'y', 'width', 'height'].map((name) => [name, panel.getAttribute(name)]))).toEqual(expected)
      setActive(true)
      expect(panel.getAttribute('data-active')).toBe('true')
      expect(root.querySelectorAll('[data-active="true"]')).toHaveLength(1)
    }
    dispose()
  })
})

describe('left activity rail buttons', () => {
  it('renders the label below its light icon with the full accessible name', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const Icon = () => <svg data-testid="test-rail-icon" />
    const dispose = render(() => (
      <ActivityBarButton
        icon={Icon}
        label="Library"
        accessibleName="Workflow library"
        tooltip="Browse saved workflows"
        pressed={false}
        onActivate={() => {}}
      />
    ), root)

    const button = root.querySelector<HTMLButtonElement>('.sidebar-button')!
    expect(button.getAttribute('aria-label')).toBe('Workflow library')
    expect(button.getAttribute('data-tooltip-label')).toBe('Browse saved workflows')
    expect(button.querySelector('.sidebar-button-label')?.textContent).toBe('Library')
    expect(button.querySelector('.sidebar-button-icon [data-testid="test-rail-icon"]')).not.toBeNull()
    expect(button.querySelector('.sidebar-button-icon')?.getAttribute('aria-hidden')).toBe('true')
    expect(button.firstElementChild?.classList.contains('sidebar-button-icon')).toBe(true)
    expect(button.lastElementChild?.classList.contains('sidebar-button-label')).toBe(true)
    dispose()
  })

  it('keeps every labeled rail action keyboard reachable', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <ActivityBarButton
        label="Settings"
        accessibleName="Settings"
        tooltip="Settings"
        pressed={undefined}
        onActivate={() => {}}
      />
    ), root)

    const button = root.querySelector<HTMLButtonElement>('.sidebar-button')!
    expect(button.tabIndex).toBe(0)
    button.focus()
    expect(document.activeElement).toBe(button)
    dispose()
  })

  it('uses semantic shell tokens for the activity rail, labels, and focus outline', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(css).toMatch(/\.left-sidebar\s*\{[^}]*width:\s*72px;[^}]*flex:\s*0 0 72px;/s)
    expect(css).toMatch(/\.sidebar-button\s*\{[^}]*flex-direction:\s*column;[^}]*min-height:\s*72px;[^}]*font-family:\s*var\(--dinkster-font-family\);/s)
    expect(css).toMatch(/\.sidebar-button-icon svg\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*stroke-width:\s*1\.5;/s)
    expect(css).toMatch(/\.sidebar-button-label\s*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;[^}]*-webkit-line-clamp:\s*2;/s)
    expect(css).toMatch(/\.sidebar-button:focus-visible\s*\{[^}]*outline:\s*var\(--dinkster-focus-ring-width\) solid var\(--dinkster-border-focus\);/s)
  })
})

describe('shared shell panel chrome', () => {
  it('uses edge-aware keyboard directions for the right rail', () => {
    const resize = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <ShellResizeHandle
        region="right"
        label="Resize inspector panels"
        value={300}
        min={240}
        max={560}
        testId="right-resize"
        onPointerDown={() => {}}
        onResize={resize}
      />
    ), root)
    const separator = root.querySelector<HTMLElement>('[data-testid="right-resize"]')!

    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      separator.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }
    expect(resize.mock.calls.map(([value]) => value)).toEqual([316, 284, 240, 560])
    dispose()
  })

  const floatingPanel = (overrides: {
    onOpenWindow?: () => void
    panel?: Partial<PanelDescriptor>
  } = {}) => {
    const root = document.createElement('div')
    document.body.append(root)
    const dock = vi.fn()
    const panel: PanelDescriptor = {
      id: 'queue', title: 'Queue', placement: 'bottom' as const,
      allowedPlacements: ['bottom', 'floating', 'window'] as const, order: 1,
      component: (surface: { placement: string }) => <div data-testid="floating-body">{surface.placement}</div>,
      ...overrides.panel,
    }
    const dispose = render(() => (
      <FloatingPanelHost panel={panel} index={0} onDock={dock} onOpenWindow={overrides.onOpenWindow} />
    ), root)
    const host = root.querySelector<HTMLElement>('[data-testid="floating-panel"]')!
    const header = host.querySelector<HTMLElement>('.floating-panel-header')!
    return { root, host, header, dock, dispose }
  }
  const floatingMenuItems = (root: Element): readonly Element[] =>
    [...root.querySelectorAll('[data-testid="context-menu"] [data-testid="context-menu-item"]')]

  it('renders a live panel indicator in the floating header', () => {
    const [count, setCount] = createSignal(1)
    const { host, dispose } = floatingPanel({ panel: {
      indicator: () => count() === 0
        ? undefined
        : { count: count(), severity: 'info', label: 'Queue ready' },
    } })
    const badge = () => host.querySelector('[data-testid="panel-indicator"]')
    expect(badge()?.getAttribute('data-severity')).toBe('info')
    expect(badge()?.querySelector('.visually-hidden')?.textContent).toBe('Queue ready')
    setCount(0)
    expect(badge()).toBeNull()
    dispose()
  })

  it('hosts a movable floating panel whose placement moves live in the header context menu', () => {
    registerCatalog('de-DE', {
      'shell.chrome.dock': '[Andocken]',
      'shell.chrome.moveToNewWindow': '[In eigenes Fenster]',
    })
    const openWindow = vi.fn()
    const { root, host, header, dock, dispose } = floatingPanel({ onOpenWindow: openWindow })
    const body = root.querySelector('[data-testid="floating-body"]')
    const initial = { left: Number.parseInt(host.style.left), top: Number.parseInt(host.style.top) }
    header.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 60, clientY: 80, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, clientY: 140 }))
    window.dispatchEvent(new PointerEvent('pointerup'))

    expect(root.querySelector('[data-testid="floating-body"]')?.textContent).toBe('floating')
    expect(host.style.left).toBe(`${initial.left + 60}px`)
    expect(host.style.top).toBe(`${initial.top + 60}px`)

    // No pop-out chrome button; the header offers only the Dock action.
    expect(host.querySelector('[aria-label="Move Queue to a new window"]')).toBeNull()
    const dockButton = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Dock')!
    expect(dockButton.classList.contains('shell-panel-header-action')).toBe(true)

    // Right-clicking the header opens the placement menu with both moves.
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 }))
    const items = floatingMenuItems(root)
    expect(items.map((item) => item.getAttribute('data-item-id'))).toEqual(['panel.dock', 'panel.openWindow'])
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Dock', 'Move to new window'])
    setLocale('de-DE')
    expect(root.querySelector('[data-testid="floating-body"]')).toBe(body)
    expect(host.style.left).toBe(`${initial.left + 60}px`)
    expect(host.style.top).toBe(`${initial.top + 60}px`)
    expect(dockButton.textContent).toBe('[Andocken]')
    const translatedItems = floatingMenuItems(root)
    expect(translatedItems).not.toEqual(items)
    expect(translatedItems.map((item) => item.textContent?.trim())).toEqual(['[Andocken]', '[In eigenes Fenster]'])
    translatedItems[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(openWindow).toHaveBeenCalledOnce()
    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()

    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 }))
    floatingMenuItems(root)[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(dock).toHaveBeenCalledOnce()

    dockButton.click()
    expect(dock).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('the floating header menu omits the window move when the host offers none', () => {
    const { root, header, dock, dispose } = floatingPanel()
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 }))
    const items = floatingMenuItems(root)
    expect(items.map((item) => item.getAttribute('data-item-id'))).toEqual(['panel.dock'])
    items[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(dock).toHaveBeenCalledOnce()
    dispose()
  })

  it('right-clicks inside the floating panel content never open the placement menu', () => {
    const { root, host, dispose } = floatingPanel({ onOpenWindow: vi.fn() })
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 })
    host.querySelector('.floating-panel-content')!.dispatchEvent(event)
    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()
    expect(event.defaultPrevented).toBe(false)
    dispose()
  })

  it('opening the header menu stops an active header drag', () => {
    const { root, host, header, dispose } = floatingPanel()
    header.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 60, clientY: 80, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 70, clientY: 90 }))
    const moved = { left: host.style.left, top: host.style.top }
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 70, clientY: 90 }))
    expect(root.querySelector('[data-testid="context-menu"]')).not.toBeNull()
    // Further pointer movement no longer drags the panel under the menu.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 220 }))
    expect(host.style.left).toBe(moved.left)
    expect(host.style.top).toBe(moved.top)
    dispose()
  })

  it('a keyboard contextmenu on the floating header opens the menu and Escape refocuses Dock', () => {
    const openWindow = vi.fn()
    const { root, host, dispose } = floatingPanel({ onOpenWindow: openWindow })
    const dockButton = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Dock')!
    // The context-menu key on the focused Dock button bubbles to the header
    // with no pointer coordinates; the menu anchors to the header instead.
    dockButton.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }))
    const items = floatingMenuItems(root)
    expect(items.map((item) => item.getAttribute('data-item-id'))).toEqual(['panel.dock', 'panel.openWindow'])
    // While the menu is open the panel raises above sibling floating panels
    // so the menu is never painted over.
    expect(host.classList.contains('floating-panel-menu-open')).toBe(true)

    root.querySelector('[data-testid="context-menu"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()
    expect(host.classList.contains('floating-panel-menu-open')).toBe(false)
    expect(document.activeElement).toBe(dockButton)
    expect(openWindow).not.toHaveBeenCalled()
    dispose()
  })
})

describe('Customize layout dialog', () => {
  it('exposes product checked controls and reset', () => {
    const [statusVisible, setStatusVisible] = createSignal(true)
    const reset = vi.fn(() => setStatusVisible(true))
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <CustomizeLayoutDialog
        items={[{
          id: 'status-bar',
          label: 'Status bar',
          checked: statusVisible,
          toggle: () => setStatusVisible((visible) => !visible),
        }]}
        onReset={reset}
      />
    ), root)

    const checkbox = root.querySelector<HTMLButtonElement>('[data-layout-region="status-bar"] [role="checkbox"]')!
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
    checkbox.focus()
    checkbox.click()
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    expect(document.activeElement).toBe(checkbox)
    click(root.querySelector('[data-testid="layout-reset"]')!)
    expect(reset).toHaveBeenCalledOnce()
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
    dispose()
  })

  it('renders only the supported visibility regions supplied by the shell', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const items = ['activity-bar', 'primary-dock', 'bottom-panel', 'right-rail', 'status-bar'].map((id) => ({
      id,
      label: id,
      checked: () => true,
      toggle: () => {},
    }))
    const dispose = render(() => <CustomizeLayoutDialog items={items} onReset={() => {}} />, root)
    expect([...root.querySelectorAll('[data-layout-region]')].map((row) => row.getAttribute('data-layout-region'))).toEqual([
      'activity-bar', 'primary-dock', 'bottom-panel', 'right-rail', 'status-bar',
    ])
    expect(root.textContent).not.toContain('Secondary sidebar')
    expect(root.textContent).not.toContain('Panel alignment')
    dispose()
  })
})

describe('DockZoneHost', () => {
  const zonePanel = (id: string, overrides: Partial<PanelDescriptor> = {}): PanelDescriptor => ({
    id,
    title: `Panel ${id}`,
    placement: 'rail',
    allowedPlacements: ['rail'],
    order: 1,
    component: () => <div data-testid={`zone-body-${id}`}>Body {id}</div>,
    ...overrides,
  })

  function renderZone(
    overrides: Partial<Parameters<typeof DockZoneHost>[0]> & { panels?: PanelDescriptor[] } = {},
  ) {
    const { panels = [zonePanel('one'), zonePanel('two')], ...rest } = overrides
    const [activeId, setActiveId] = createSignal<string | undefined>('one')
    const onRequestClose = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <DockZoneHost
        zone="right"
        ariaLabel="Inspector panels"
        sections={[{ section: 0, panels, activeId: activeId() }]}
        split={0.5}
        onSplitChange={() => {}}
        onActivate={setActiveId}
        onRequestClose={onRequestClose}
        {...rest}
      />
    ), root)
    return { root, panels, activeId, setActiveId, onRequestClose, dispose }
  }

  it('renders one ARIA tab per panel with exactly one visible, always-mounted body', () => {
    const { root, setActiveId, dispose } = renderZone()
    const tabs = [...root.querySelectorAll('[role="tab"]')]
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Panel one', 'Panel two'])
    expect(root.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Inspector panels')

    const bodyOf = (id: string) => root.querySelector(`[data-testid="zone-body-${id}"]`)!.closest('[role="tabpanel"]')!
    expect(bodyOf('one').hasAttribute('hidden')).toBe(false)
    expect(bodyOf('two').hasAttribute('hidden')).toBe(true)

    // Switching tabs hides rather than unmounts, so panel state survives.
    setActiveId('two')
    expect(bodyOf('one').hasAttribute('hidden')).toBe(true)
    expect(bodyOf('two').hasAttribute('hidden')).toBe(false)
    expect(root.querySelector('[data-testid="zone-body-one"]')).not.toBeNull()
    dispose()
  })

  it('activating a tab reports the id; the host stays controlled', () => {
    const { root, activeId, dispose } = renderZone()
    click([...root.querySelectorAll('[role="tab"]')][1]!)
    expect(activeId()).toBe('two')
    dispose()
  })

  it('tab labels are ellipsis-ready spans exposing the full title as a tooltip', () => {
    const { root, dispose } = renderZone()
    const labels = [...root.querySelectorAll('[role="tab"] .tab-title')]
    expect(labels.map((label) => label.textContent)).toEqual(['Panel one', 'Panel two'])
    expect(labels.map((label) => label.getAttribute('data-tooltip-label'))).toEqual(['Panel one', 'Panel two'])
    dispose()
  })

  it('renders a descriptor indicator on its tab, active or not, and clears it at zero', () => {
    const [count, setCount] = createSignal(2)
    const panels = [
      zonePanel('one'),
      zonePanel('two', {
        indicator: () => count() === 0 ? undefined : {
          count: count(),
          severity: 'error' as const,
          label: `${count()} problems, worst severity error`,
        },
      }),
    ]
    const { root, dispose } = renderZone({ panels })
    // Panel two is INACTIVE (one is active): the badge shows anyway.
    const badgeOf = (id: string) => root.querySelector(`[role="tab"][data-tab-id="${id}"] [data-testid="panel-indicator"]`)
    expect(badgeOf('one')).toBeNull()
    const badge = badgeOf('two')!
    expect(badge).not.toBeNull()
    expect(badge.getAttribute('data-severity')).toBe('error')
    expect(badge.querySelector('[aria-hidden="true"]')!.textContent).toBe('2')
    expect(badge.querySelector('.visually-hidden')!.textContent).toBe('2 problems, worst severity error')

    setCount(120)
    expect(badgeOf('two')!.querySelector('[aria-hidden="true"]')!.textContent).toBe('99+')

    // No problems left: the badge disappears entirely.
    setCount(0)
    expect(badgeOf('two')).toBeNull()
    dispose()
  })

  it('an indicator reporting count 0 renders no badge', () => {
    const panels = [
      zonePanel('one', { indicator: () => ({ count: 0, severity: 'info' as const, label: 'nothing' }) }),
      zonePanel('two'),
    ]
    const { root, dispose } = renderZone({ panels })
    expect(root.querySelector('[data-testid="panel-indicator"]')).toBeNull()
    dispose()
  })

  it('host-owned actions follow the ACTIVE panel and gate on allowedPlacements', () => {
    const run = vi.fn()
    const onFloat = vi.fn()
    const onOpenWindow = vi.fn()
    const panels = [
      zonePanel('one', {
        allowedPlacements: ['rail', 'floating', 'window'],
        headerAction: { label: 'Clear', testId: 'zone-clear', run },
      }),
      zonePanel('two'),
    ]
    const { root, setActiveId, dispose } = renderZone({ panels, onFloat, onOpenWindow })
    expect(root.querySelector('[data-testid="zone-clear"]')).not.toBeNull()
    click(root.querySelector('[data-testid="zone-clear"]')!)
    expect(run).toHaveBeenCalledTimes(1)
    // Placement moves are never always-visible chrome buttons; Float and
    // Move to new window live in the tab's context menu.
    expect(root.querySelector('[data-testid="panel-float-one"]')).toBeNull()
    expect(root.querySelector('[data-testid="panel-popout-one"]')).toBeNull()
    expect(onOpenWindow).not.toHaveBeenCalled()

    // Panel two allows only rail: its active chrome offers no header action.
    setActiveId('two')
    expect(root.querySelector('[data-testid="zone-clear"]')).toBeNull()
    dispose()
  })

  const rightClick = (element: Element, init: MouseEventInit = {}): void => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30, ...init }))
  }
  const menuItems = (root: Element): readonly Element[] =>
    [...root.querySelectorAll('[data-testid="context-menu"] [data-testid="context-menu-item"]')]
  const invokeItem = (item: Element): void => {
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  }

  it('right-clicking a tab offers its placement moves in the styled context menu', () => {
    registerCatalog('de-DE', {
      'shell.chrome.float': '[Schweben]',
      'shell.chrome.moveToNewWindow': '[In eigenes Fenster]',
    })
    const onFloat = vi.fn()
    const onOpenWindow = vi.fn()
    const panels = [
      zonePanel('one', { allowedPlacements: ['rail', 'floating', 'window'] }),
      zonePanel('two'),
    ]
    const { root, dispose } = renderZone({ panels, onFloat, onOpenWindow })
    rightClick(root.querySelector('[role="tab"][data-tab-id="one"]')!)
    const items = menuItems(root)
    expect(items.map((item) => item.getAttribute('data-item-id'))).toEqual(['panel.float', 'panel.openWindow'])
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Float', 'Move to new window'])
    setLocale('de-DE')
    const translatedItems = menuItems(root)
    expect(translatedItems).not.toEqual(items)
    expect(translatedItems.map((item) => item.textContent?.trim())).toEqual(['[Schweben]', '[In eigenes Fenster]'])
    invokeItem(translatedItems[0]!)
    expect(onFloat).toHaveBeenCalledWith('one')
    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()

    rightClick(root.querySelector('[role="tab"][data-tab-id="one"]')!)
    invokeItem(menuItems(root)[1]!)
    expect(onOpenWindow).toHaveBeenCalledWith('one')
    dispose()
  })

  it('the context menu targets the right-clicked tab even when inactive', () => {
    const onFloat = vi.fn()
    const panels = [
      zonePanel('one', { allowedPlacements: ['rail', 'floating'] }),
      zonePanel('two', { allowedPlacements: ['rail', 'floating'] }),
    ]
    const { root, activeId, dispose } = renderZone({ panels, onFloat })
    expect(activeId()).toBe('one')
    rightClick(root.querySelector('[role="tab"][data-tab-id="two"]')!)
    invokeItem(menuItems(root)[0]!)
    expect(onFloat).toHaveBeenCalledWith('two')
    dispose()
  })

  it('a tab with no legal placement moves opens no menu and keeps the native event', () => {
    const onFloat = vi.fn()
    const panels = [zonePanel('one', { allowedPlacements: ['rail', 'floating'] }), zonePanel('two')]
    const { root, dispose } = renderZone({ panels, onFloat })
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 })
    root.querySelector('[role="tab"][data-tab-id="two"]')!.dispatchEvent(event)
    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()
    expect(event.defaultPrevented).toBe(false)
    dispose()
  })

  it('right-clicking trailing header actions never opens the placement menu', () => {
    const onFloat = vi.fn()
    const onOpenWindow = vi.fn()
    const panels = [
      zonePanel('one', {
        allowedPlacements: ['rail', 'floating', 'window'],
        headerAction: { label: 'Clear', testId: 'zone-clear', run: vi.fn() },
      }),
      zonePanel('two'),
    ]
    const { root, dispose } = renderZone({ panels, onFloat, onOpenWindow })
    for (const testId of ['zone-clear', 'dock-zone-close']) {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 })
      root.querySelector(`[data-testid="${testId}"]`)!.dispatchEvent(event)
      expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()
      expect(event.defaultPrevented).toBe(false)
    }
    dispose()
  })

  it('right-clicks inside a panel body never open the placement menu', () => {
    const onFloat = vi.fn()
    const panels = [zonePanel('one', { allowedPlacements: ['rail', 'floating'] }), zonePanel('two')]
    const { root, dispose } = renderZone({ panels, onFloat })
    rightClick(root.querySelector('[data-testid="zone-body-one"]')!)
    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()
    dispose()
  })

  it('a keyboard contextmenu event without pointer coordinates opens the menu at the tab', () => {
    const onFloat = vi.fn()
    const panels = [zonePanel('one', { allowedPlacements: ['rail', 'floating'] }), zonePanel('two')]
    const { root, dispose } = renderZone({ panels, onFloat })
    rightClick(root.querySelector('[role="tab"][data-tab-id="one"]')!, { clientX: 0, clientY: 0 })
    const items = menuItems(root)
    expect(items.map((item) => item.getAttribute('data-item-id'))).toEqual(['panel.float'])
    invokeItem(items[0]!)
    expect(onFloat).toHaveBeenCalledWith('one')
    dispose()
  })

  it('the zone close button asks the host to close', () => {
    const { root, onRequestClose, dispose } = renderZone()
    click(root.querySelector('[data-testid="dock-zone-close"]')!)
    expect(onRequestClose).toHaveBeenCalledTimes(1)
    dispose()
  })

  function renderSectionedZone(zone: 'right' | 'bottom' = 'right') {
    const upper = [zonePanel('one'), zonePanel('two')]
    const lower = [zonePanel('three', { allowedPlacements: ['rail', 'floating'] })]
    const [activeUpper, setActiveUpper] = createSignal<string | undefined>('one')
    const onSplitChange = vi.fn()
    const onFloat = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <DockZoneHost
        zone={zone}
        ariaLabel="Inspector panels"
        sections={[
          { section: 0, panels: upper, activeId: activeUpper() },
          { section: 1, panels: lower, activeId: 'three' },
        ]}
        split={0.5}
        onSplitChange={onSplitChange}
        onActivate={setActiveUpper}
        onRequestClose={vi.fn()}
        onFloat={onFloat}
      />
    ), root)
    return { root, onSplitChange, onFloat, dispose }
  }

  it('renders two sections as independent tablists with half-specific labels', () => {
    const { root, dispose } = renderSectionedZone()
    const tablists = [...root.querySelectorAll('[role="tablist"]')]
    expect(tablists.map((list) => list.getAttribute('aria-label'))).toEqual([
      'Inspector panels upper section',
      'Inspector panels lower section',
    ])
    expect(root.querySelector('[data-testid="dock-zone-section-right-0"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="dock-zone-section-right-1"]')).not.toBeNull()
    // Each section shows its own active body at the same time.
    const bodyOf = (id: string) => root.querySelector(`[data-testid="zone-body-${id}"]`)!.closest('[role="tabpanel"]')!
    expect(bodyOf('one').hasAttribute('hidden')).toBe(false)
    expect(bodyOf('three').hasAttribute('hidden')).toBe(false)
    dispose()
  })

  it('the bottom zone labels its side-by-side sections left and right', () => {
    const { root, dispose } = renderSectionedZone('bottom')
    const tablists = [...root.querySelectorAll('[role="tablist"]')]
    expect(tablists.map((list) => list.getAttribute('aria-label'))).toEqual([
      'Inspector panels left section',
      'Inspector panels right section',
    ])
    expect(
      root.querySelector('[data-testid="dock-section-divider-bottom"]')?.getAttribute('aria-orientation'),
    ).toBe('vertical')
    dispose()
  })

  it('updates section, divider, and close accessible names without remounting panel bodies', () => {
    registerCatalog('de-DE', {
      'shell.chrome.closeZone': '[Schliesse {zone}]',
      'shell.chrome.resizeZoneSections': '[Teile {zone} neu]',
      'shell.chrome.section.left': '[{zone}:LINKS]',
      'shell.chrome.section.lower': '[{zone}:UNTEN]',
      'shell.chrome.section.right': '[{zone}:RECHTS]',
      'shell.chrome.section.upper': '[{zone}:OBEN]',
    })
    const vertical = renderSectionedZone()
    const verticalBodies = [...vertical.root.querySelectorAll('[data-testid^="zone-body-"]')]
    const horizontal = renderSectionedZone('bottom')
    const horizontalBodies = [...horizontal.root.querySelectorAll('[data-testid^="zone-body-"]')]

    setLocale('de-DE')

    expect([...vertical.root.querySelectorAll('[role="tablist"]')].map((node) => node.getAttribute('aria-label'))).toEqual([
      '[Inspector panels:OBEN]', '[Inspector panels:UNTEN]',
    ])
    expect(vertical.root.querySelector('[data-testid="dock-section-divider-right"]')?.getAttribute('aria-label'))
      .toBe('[Teile Inspector panels neu]')
    expect(vertical.root.querySelector('[data-testid="dock-zone-close"]')?.getAttribute('aria-label'))
      .toBe('[Schliesse Inspector panels]')
    expect([...horizontal.root.querySelectorAll('[role="tablist"]')].map((node) => node.getAttribute('aria-label'))).toEqual([
      '[Inspector panels:LINKS]', '[Inspector panels:RECHTS]',
    ])
    expect([...vertical.root.querySelectorAll('[data-testid^="zone-body-"]')]).toEqual(verticalBodies)
    expect([...horizontal.root.querySelectorAll('[data-testid^="zone-body-"]')]).toEqual(horizontalBodies)
    expect(vertical.root.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(2)
    expect(horizontal.root.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(2)
    vertical.dispose()
    horizontal.dispose()
  })

  it('only the first rendered section owns the zone close button', () => {
    const { root, dispose } = renderSectionedZone()
    const closes = [...root.querySelectorAll('[data-testid="dock-zone-close"]')]
    expect(closes).toHaveLength(1)
    expect(closes[0]!.closest('[data-testid="dock-zone-section-right-0"]')).not.toBeNull()
    dispose()
  })

  it('a later section keeps its DOM while an earlier section hides and returns', () => {
    const upper = { section: 0, panels: [zonePanel('one')], activeId: 'one' }
    const lower = { section: 1, panels: [zonePanel('three')], activeId: 'three' }
    const [sections, setSections] = createSignal([upper, lower])
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <DockZoneHost
        zone="right"
        ariaLabel="Inspector panels"
        sections={sections()}
        split={0.5}
        onSplitChange={vi.fn()}
        onActivate={vi.fn()}
        onRequestClose={vi.fn()}
      />
    ), root)
    const lowerBody = root.querySelector('[data-testid="zone-body-three"]')
    expect(lowerBody).not.toBeNull()

    // Section 0 loses its last visible panel: only section 1 renders, at
    // full size with no divider, and it inherits the zone close button
    // WITHOUT its DOM being recreated.
    setSections([lower])
    expect(root.querySelector('[data-testid="dock-zone-section-right-0"]')).toBeNull()
    expect(root.querySelector('[data-testid="dock-section-divider-right"]')).toBeNull()
    const soleSection = root.querySelector<HTMLElement>('[data-testid="dock-zone-section-right-1"]')!
    expect(soleSection.style.flex).toBe('')
    expect(root.querySelector('[data-testid="dock-zone-close"]')!.closest('[data-testid="dock-zone-section-right-1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="zone-body-three"]')).toBe(lowerBody)

    // The hidden section returns: both render again and the later section
    // still keeps its original DOM.
    setSections([upper, lower])
    expect(root.querySelector('[data-testid="dock-zone-section-right-0"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="dock-section-divider-right"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="zone-body-three"]')).toBe(lowerBody)
    dispose()
  })

  it('a panel that leaves the zone and returns stays reactive and undisposed while rendered', () => {
    const [value, setValue] = createSignal('first')
    const cleanups: string[] = []
    const returning = zonePanel('two', {
      component: () => {
        onCleanup(() => cleanups.push('two'))
        return <div data-testid="zone-body-two">{value()}</div>
      },
    })
    const one = zonePanel('one')
    const three = zonePanel('three')
    const [panels, setPanels] = createSignal([one, returning])
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <DockZoneHost
        zone="right"
        ariaLabel="Inspector panels"
        sections={[{ section: 0, panels: panels(), activeId: 'two' }]}
        split={0.5}
        onSplitChange={vi.fn()}
        onActivate={vi.fn()}
        onRequestClose={vi.fn()}
      />
    ), root)
    const body = () => root.querySelector('[data-testid="zone-body-two"]')

    // The panel floats away (leaves the zone view): its docked body is
    // evicted and disposed exactly once.
    setPanels([one])
    expect(body()).toBeNull()
    expect(cleanups).toEqual(['two'])

    // It returns (redock): a fresh body renders and stays reactive.
    setPanels([one, returning])
    expect(body()?.textContent).toBe('first')
    setValue('second')
    expect(body()?.textContent).toBe('second')

    // An unrelated membership change must not dispose or freeze the
    // returned body.
    setPanels([one, returning, three])
    expect(cleanups).toEqual(['two'])
    setValue('third')
    expect(body()?.textContent).toBe('third')

    // Unmounting the host disposes every cached body.
    dispose()
    expect(cleanups).toEqual(['two', 'two'])
  })

  it('the divider is a keyboard-operable separator reporting the first section share', () => {
    const { root, onSplitChange, dispose } = renderSectionedZone()
    const divider = root.querySelector<HTMLElement>('[data-testid="dock-section-divider-right"]')!
    expect(divider.getAttribute('role')).toBe('separator')
    expect(divider.getAttribute('tabindex')).toBe('0')
    expect(divider.getAttribute('aria-orientation')).toBe('horizontal')
    expect(divider.getAttribute('aria-valuemin')).toBe('10')
    expect(divider.getAttribute('aria-valuemax')).toBe('90')
    expect(divider.getAttribute('aria-valuenow')).toBe('50')

    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(onSplitChange).toHaveBeenLastCalledWith(expect.closeTo(0.55, 5) as number)
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    expect(onSplitChange).toHaveBeenLastCalledWith(expect.closeTo(0.45, 5) as number)
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
    expect(onSplitChange).toHaveBeenLastCalledWith(0.1)
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    expect(onSplitChange).toHaveBeenLastCalledWith(0.9)
    // The zone axis is vertical here: horizontal arrows do nothing.
    onSplitChange.mockClear()
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(onSplitChange).not.toHaveBeenCalled()
    dispose()
  })

  it('the bottom divider resizes with horizontal arrows', () => {
    const { root, onSplitChange, dispose } = renderSectionedZone('bottom')
    const divider = root.querySelector<HTMLElement>('[data-testid="dock-section-divider-bottom"]')!
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(onSplitChange).toHaveBeenLastCalledWith(expect.closeTo(0.55, 5) as number)
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    expect(onSplitChange).toHaveBeenLastCalledWith(expect.closeTo(0.45, 5) as number)
    dispose()
  })

  it('second-section tabs offer the same placement context menu as first-section tabs', () => {
    const { root, onFloat, dispose } = renderSectionedZone()
    rightClick(root.querySelector('[role="tab"][data-tab-id="three"]')!)
    const items = menuItems(root)
    expect(items.map((item) => item.getAttribute('data-item-id'))).toEqual(['panel.float'])
    invokeItem(items[0]!)
    expect(onFloat).toHaveBeenCalledWith('three')
    dispose()
  })

  // Clipping is measured from the tablist's real layout, which the DOM test
  // environment does not compute; stub the strip's metrics and drive the
  // panels-change re-measure path the component uses for content changes.
  function renderClippableZone(
    overrides: Partial<Parameters<typeof DockZoneHost>[0]> = {},
    initialPanels: PanelDescriptor[] = [zonePanel('one'), zonePanel('two')],
  ) {
    const [panels, setPanels] = createSignal(initialPanels)
    const [activeId, setActiveId] = createSignal<string | undefined>('one')
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <DockZoneHost
        zone="right"
        ariaLabel="Inspector panels"
        split={0.5}
        onSplitChange={() => {}}
        onActivate={setActiveId}
        onRequestClose={vi.fn()}
        {...overrides}
        sections={[{ section: 0, panels: panels(), activeId: activeId() }]}
      />
    ), root)
    const tablist = root.querySelector('[role="tablist"]')!
    let clientWidth = 100
    Object.defineProperty(tablist, 'clientWidth', { configurable: true, get: () => clientWidth })
    const remeasure = async (clipped: boolean): Promise<void> => {
      clientWidth = clipped ? 100 : 500
      setPanels((current) => [...current])
      await new Promise<void>((done) => queueMicrotask(() => queueMicrotask(done)))
    }
    const overflowButton = () => root.querySelector<HTMLElement>('[data-testid="dock-zone-overflow-button"]')
    const overflowMenu = () => root.querySelector<HTMLElement>('[data-testid="dock-zone-overflow-menu"]')
    return { root, activeId, remeasure, overflowButton, overflowMenu, dispose }
  }

  it('the all-tabs menu closes when clipping clears and stays closed on reclip', async () => {
    const { remeasure, overflowButton, overflowMenu, dispose } = renderClippableZone()
    await remeasure(true)
    click(overflowButton()!)
    expect(overflowMenu()).not.toBeNull()

    // Widening the zone removes the clip; the menu and button unmount.
    await remeasure(false)
    expect(overflowButton()).toBeNull()
    expect(overflowMenu()).toBeNull()

    // Narrowing again restores the button, but the menu needs a fresh
    // activation; the stale open state must not resurface it.
    await remeasure(true)
    expect(overflowButton()).not.toBeNull()
    expect(overflowMenu()).toBeNull()
    dispose()
  })

  it('right-clicking an all-tabs menu entry never opens the placement menu', async () => {
    const onFloat = vi.fn()
    const { root, remeasure, overflowButton, overflowMenu, dispose } = renderClippableZone({ onFloat }, [
      zonePanel('one', { allowedPlacements: ['rail', 'floating'] }),
      zonePanel('two', { allowedPlacements: ['rail', 'floating'] }),
    ])
    await remeasure(true)
    click(overflowButton()!)
    const entry = overflowMenu()!.querySelectorAll('[role="menuitemradio"]')[1]!
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 })
    entry.dispatchEvent(event)
    expect(root.querySelector('[data-testid="context-menu"]')).toBeNull()
    expect(event.defaultPrevented).toBe(false)
    // The all-tabs menu itself stays open; no second menu fights it.
    expect(overflowMenu()).not.toBeNull()
    expect(onFloat).not.toHaveBeenCalled()
    dispose()
  })

  it('fully hides overflow tabs and makes a hidden menu selection the whole active tab', async () => {
    const { root, activeId, remeasure, overflowButton, overflowMenu, dispose } = renderClippableZone()
    await remeasure(true)
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map((tab) => tab.disabled)).toEqual([false, true])

    click(overflowButton()!)
    const items = [...overflowMenu()!.querySelectorAll('[role="menuitemradio"]')]
    expect(items.map((item) => item.textContent)).toEqual(['Panel one', 'Panel two'])
    click(items[1]!)
    await new Promise<void>((done) => queueMicrotask(() => queueMicrotask(done)))

    expect(activeId()).toBe('two')
    expect(tabs.map((tab) => tab.disabled)).toEqual([true, false])
    expect(root.querySelector('[data-testid="zone-body-two"]')!.closest('[role="tabpanel"]')!.hasAttribute('hidden')).toBe(false)
    dispose()
  })

  it('the all-tabs trigger suppresses its tooltip while the menu is open', async () => {
    const { remeasure, overflowButton, overflowMenu, dispose } = renderClippableZone()
    await remeasure(true)
    expect(overflowButton()!.getAttribute('data-tooltip-label')).toBe('All tabs')
    click(overflowButton()!)
    expect(overflowMenu()).not.toBeNull()
    expect(overflowButton()!.hasAttribute('data-tooltip-label')).toBe(false)
    click(overflowButton()!)
    expect(overflowMenu()).toBeNull()
    expect(overflowButton()!.getAttribute('data-tooltip-label')).toBe('All tabs')
    dispose()
  })

  it('all-tabs menu items expose the active tab with a visible checked state', async () => {
    const { activeId, remeasure, overflowButton, overflowMenu, dispose } = renderClippableZone()
    await remeasure(true)
    click(overflowButton()!)
    const items = [...overflowMenu()!.querySelectorAll('[role="menuitemradio"]')]
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    // The checked item is visually distinguished, not just announced.
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(css).toMatch(/\.dock-zone-overflow-menu button\[aria-checked='true'\]\s*\{[^}]*background:/s)

    click(items[1]!)
    expect(activeId()).toBe('two')
    expect(overflowMenu()).toBeNull()
    dispose()
  })

  it('surfaces a clipped tab\'s indicator on the all-tabs trigger and its menu entry', async () => {
    registerCatalog('de-DE', {
      'shell.chrome.allTabs': '[Alle Reiter]',
      'shell.chrome.allZoneTabs': '[Reiter in {zone}]',
      'shell.chrome.allZoneTabsWithIndicator': '[Reiter in {zone}; Hinweis {indicator}]',
      'shell.chrome.zoneTabs': '[Menu fur {zone}]',
    })
    const indicator = { count: 3, severity: 'error' as const, label: '3 problems, worst severity error' }
    const { root, remeasure, overflowButton, overflowMenu, dispose } = renderClippableZone({}, [
      zonePanel('one'),
      zonePanel('two', { indicator: () => indicator }),
    ])
    await remeasure(true)
    // Tab two is clipped; its attention moves to the trigger, count and
    // severity intact, and the accessible name carries the same label.
    const badge = overflowButton()!.querySelector('[data-testid="panel-indicator"]')!
    expect(badge.getAttribute('data-severity')).toBe('error')
    expect(badge.textContent).toContain('3')
    expect(overflowButton()!.getAttribute('aria-label')).toBe('All Inspector panels tabs, 3 problems, worst severity error')
    expect(overflowButton()!.getAttribute('data-tooltip-label')).toBe('All tabs')

    click(overflowButton()!)
    const button = overflowButton()!
    const menu = overflowMenu()!
    const entries = [...overflowMenu()!.querySelectorAll('[role="menuitemradio"]')]
    expect(entries[0]!.querySelector('[data-testid="panel-indicator"]')).toBeNull()
    expect(entries[1]!.querySelector('[data-testid="panel-indicator"]')?.getAttribute('data-severity')).toBe('error')
    setLocale('de-DE')
    expect(overflowButton()).toBe(button)
    expect(overflowMenu()).toBe(menu)
    expect(button.getAttribute('aria-label')).toBe('[Reiter in Inspector panels; Hinweis 3 problems, worst severity error]')
    expect(menu.getAttribute('aria-label')).toBe('[Menu fur Inspector panels]')
    click(button)
    expect(button.getAttribute('data-tooltip-label')).toBe('[Alle Reiter]')

    // Widening restores the tab; the trigger (and its badge) unmounts.
    await remeasure(false)
    expect(overflowButton()).toBeNull()
    dispose()
  })

  it('keeps the all-tabs trigger unbadged while every clipped tab is quiet', async () => {
    const { remeasure, overflowButton, dispose } = renderClippableZone({}, [
      zonePanel('one', { indicator: () => ({ count: 2, severity: 'warning' as const, label: '2 problems, worst severity warning' }) }),
      zonePanel('two'),
    ])
    // Panel one stays visible (and active), so its indicator lives on its
    // own tab; the trigger only aggregates tabs the user cannot see.
    await remeasure(true)
    expect(overflowButton()!.querySelector('[data-testid="panel-indicator"]')).toBeNull()
    expect(overflowButton()!.getAttribute('aria-label')).toBe('All Inspector panels tabs')
    dispose()
  })
})

describe('left rail tooltip hover session', () => {
  it('keeps the original delay deadline while moving between adjacent pending targets', () => {
    vi.useFakeTimers()
    const controller = new TooltipController(() => 500)
    controller.register({ id: 'dom', resolve: (target) => ({ lines: [(target as { label: string }).label] }) })
    controller.show({ label: 'Library' }, { x: 0, y: 0 })
    vi.advanceTimersByTime(300)
    controller.showInSession({ label: 'Backends' }, { x: 1, y: 1 })
    vi.advanceTimersByTime(199)
    expect(controller.visible).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(controller.visible?.lines).toEqual(['Backends'])
  })

  it('switches immediately without hiding after the first adjacent tooltip appears', () => {
    vi.useFakeTimers()
    const root = document.createElement('div')
    root.dataset['tooltipSession'] = 'left-rail'
    const first = document.createElement('button')
    first.dataset['tooltipLabel'] = 'Library'
    const second = document.createElement('button')
    second.dataset['tooltipLabel'] = 'Backends'
    root.append(first, second)
    document.body.append(root)
    const controller = new TooltipController(() => 500)
    controller.register({
      id: 'dom',
      resolve: (target) => ({ lines: [(target as { label: string }).label] }),
    })
    const states: (string | undefined)[] = []
    controller.subscribe(() => states.push(controller.visible?.lines[0]))
    const detach = attachDomTooltips(root, controller)

    first.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    vi.advanceTimersByTime(500)
    expect(controller.visible?.lines).toEqual(['Library'])
    first.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: second }))
    second.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: first }))

    expect(controller.visible?.lines).toEqual(['Backends'])
    expect(states).toEqual(['Library', 'Backends'])
    root.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
    expect(controller.visible).toBeUndefined()
    detach()
  })

  it('hides a visible tooltip after grace over empty session space', () => {
    vi.useFakeTimers()
    const root = document.createElement('div')
    root.dataset['tooltipSession'] = 'left-rail'
    const target = document.createElement('button')
    target.dataset['tooltipLabel'] = 'Library'
    root.append(target)
    document.body.append(root)
    const controller = new TooltipController(() => 0)
    controller.register({ id: 'dom', resolve: () => ({ lines: ['Library'] }) })
    const detach = attachDomTooltips(root, controller)

    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    vi.runOnlyPendingTimers()
    expect(controller.visible?.lines).toEqual(['Library'])
    target.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: root }))
    vi.advanceTimersByTime(DOM_TOOLTIP_SESSION_GRACE_MS - 1)
    expect(controller.visible?.lines).toEqual(['Library'])
    vi.advanceTimersByTime(1)
    expect(controller.visible).toBeUndefined()
    detach()
  })

  it('cancels a pending tooltip immediately over empty session space', () => {
    vi.useFakeTimers()
    const root = document.createElement('div')
    root.dataset['tooltipSession'] = 'left-rail'
    const target = document.createElement('button')
    target.dataset['tooltipLabel'] = 'Library'
    root.append(target)
    document.body.append(root)
    const controller = new TooltipController(() => 500)
    controller.register({ id: 'dom', resolve: () => ({ lines: ['Library'] }) })
    const detach = attachDomTooltips(root, controller)

    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    vi.advanceTimersByTime(200)
    target.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: root }))
    vi.advanceTimersByTime(500)

    expect(controller.visible).toBeUndefined()
    detach()
  })

  it('cancels empty-session grace when another target is entered', () => {
    vi.useFakeTimers()
    const root = document.createElement('div')
    root.dataset['tooltipSession'] = 'left-rail'
    const first = document.createElement('button')
    first.dataset['tooltipLabel'] = 'Library'
    const second = document.createElement('button')
    second.dataset['tooltipLabel'] = 'Backends'
    root.append(first, second)
    document.body.append(root)
    const controller = new TooltipController(() => 0)
    controller.register({
      id: 'dom',
      resolve: (target) => ({ lines: [(target as { label: string }).label] }),
    })
    const states: (string | undefined)[] = []
    controller.subscribe(() => states.push(controller.visible?.lines[0]))
    const detach = attachDomTooltips(root, controller)

    first.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    vi.runOnlyPendingTimers()
    first.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: root }))
    vi.advanceTimersByTime(DOM_TOOLTIP_SESSION_GRACE_MS - 1)
    second.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: root }))
    vi.advanceTimersByTime(DOM_TOOLTIP_SESSION_GRACE_MS)

    expect(controller.visible?.lines).toEqual(['Backends'])
    expect(states).toEqual(['Library', 'Backends'])
    detach()
  })

  it('hides immediately when a target exits the session boundary', () => {
    vi.useFakeTimers()
    const root = document.createElement('div')
    root.dataset['tooltipSession'] = 'left-rail'
    const target = document.createElement('button')
    target.dataset['tooltipLabel'] = 'Library'
    root.append(target)
    document.body.append(root)
    const controller = new TooltipController(() => 0)
    controller.register({ id: 'dom', resolve: () => ({ lines: ['Library'] }) })
    const detach = attachDomTooltips(root, controller)

    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    vi.runOnlyPendingTimers()
    target.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))

    expect(controller.visible).toBeUndefined()
    vi.advanceTimersByTime(DOM_TOOLTIP_SESSION_GRACE_MS)
    expect(controller.visible).toBeUndefined()
    detach()
  })

  it('detaching cancels pending DOM tooltip work', () => {
    vi.useFakeTimers()
    const root = document.createElement('div')
    root.dataset['tooltipSession'] = 'left-rail'
    const target = document.createElement('button')
    target.dataset['tooltipLabel'] = 'Library'
    root.append(target)
    document.body.append(root)
    const controller = new TooltipController(() => 500)
    controller.register({ id: 'dom', resolve: () => ({ lines: ['Library'] }) })
    const detach = attachDomTooltips(root, controller)

    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    detach()
    vi.advanceTimersByTime(500)

    expect(controller.visible).toBeUndefined()
  })
})

describe('stateful tooltip labels', () => {
  const labelController = () => {
    const controller = new TooltipController(() => 0)
    controller.register({ id: 'dom', resolve: (target) => ({ lines: [(target as { label: string }).label] }) })
    return controller
  }

  it('re-reads the label when the shown control rewrites it after activation', async () => {
    const root = document.createElement('div')
    const toggle = document.createElement('button')
    toggle.dataset['tooltipLabel'] = 'Hide minimap'
    root.append(toggle)
    document.body.append(root)
    const controller = labelController()
    const detach = attachDomTooltips(root, controller)

    toggle.focus()
    toggle.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(controller.visible?.lines).toEqual(['Hide minimap'])
    toggle.dataset['tooltipLabel'] = 'Show minimap'
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controller.visible?.lines).toEqual(['Show minimap'])
    detach()
  })

  it('re-reads the label for a hover-shown control', async () => {
    vi.useFakeTimers()
    const root = document.createElement('div')
    const toggle = document.createElement('button')
    toggle.dataset['tooltipLabel'] = 'Grid view'
    root.append(toggle)
    document.body.append(root)
    const controller = labelController()
    const detach = attachDomTooltips(root, controller)

    toggle.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    vi.runOnlyPendingTimers()
    expect(controller.visible?.lines).toEqual(['Grid view'])
    vi.useRealTimers()
    toggle.dataset['tooltipLabel'] = 'List view'
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controller.visible?.lines).toEqual(['List view'])
    detach()
  })

  it('hides the tooltip when the shown control drops its label', async () => {
    const root = document.createElement('div')
    const toggle = document.createElement('button')
    toggle.dataset['tooltipLabel'] = 'Assets'
    root.append(toggle)
    document.body.append(root)
    const controller = labelController()
    const detach = attachDomTooltips(root, controller)

    toggle.focus()
    toggle.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(controller.visible?.lines).toEqual(['Assets'])
    delete toggle.dataset['tooltipLabel']
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controller.visible).toBeUndefined()
    detach()
  })

  it('hides the tooltip when the shown control is removed from the DOM', async () => {
    const root = document.createElement('div')
    const toggle = document.createElement('button')
    toggle.dataset['tooltipLabel'] = 'Assets'
    root.append(toggle)
    document.body.append(root)
    const controller = labelController()
    const detach = attachDomTooltips(root, controller)

    toggle.focus()
    toggle.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(controller.visible?.lines).toEqual(['Assets'])
    toggle.remove() // no attribute mutation: only the tree watch sees this
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controller.visible).toBeUndefined()
    detach()
  })

  it('ignores label changes once the control is neither hovered nor focused', async () => {
    const root = document.createElement('div')
    const toggle = document.createElement('button')
    toggle.dataset['tooltipLabel'] = 'Hide minimap'
    root.append(toggle)
    document.body.append(root)
    const controller = labelController()
    const detach = attachDomTooltips(root, controller)

    toggle.focus()
    toggle.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(controller.visible?.lines).toEqual(['Hide minimap'])
    toggle.blur()
    toggle.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    expect(controller.visible).toBeUndefined()
    toggle.dataset['tooltipLabel'] = 'Show minimap'
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controller.visible).toBeUndefined()
    detach()
  })
})

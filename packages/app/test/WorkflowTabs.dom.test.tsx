// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { registerCatalog, setLocale } from '@dinkster/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowTabs } from '../src/WorkflowTabs.js'

interface TestTab {
  readonly id: string
  readonly title: string
}

const tabs: readonly TestTab[] = [
  { id: 'one', title: 'One' },
  { id: 'two', title: 'Two' },
  { id: 'three', title: 'Three' },
]

afterEach(() => {
  setLocale('en')
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const registerGermanCatalog = (): void => registerCatalog('de-DE', {
  'shell.chrome.moveToNewWindow': '[In eigenes Fenster]',
  'shell.workflow.new': '[Neuer Ablauf]',
  'shell.workflowTabs.close': '[Schliesse {title}]',
  'shell.workflowTabs.documents': '[Ablaufdokumente]',
  'shell.workflowTabs.livePreviews': '[Live-Vorschauen]',
  'shell.workflowTabs.openWorkflows': '[Offene Ablaufe]',
  'shell.workflowTabs.preview.auto': '[Automatisch]',
  'shell.workflowTabs.preview.cheap': '[Sparsam]',
  'shell.workflowTabs.preview.inheritGlobal': '[Global ubernehmen]',
  'shell.workflowTabs.preview.off': '[Aus]',
  'shell.workflowTabs.preview.quality': '[Qualitat]',
  'shell.workflowTabs.share': '[Teilen]',
  'shell.workflowTabs.splitDown': '[Nach unten teilen]',
  'shell.workflowTabs.splitRight': '[Nach rechts teilen]',
  'shell.workflowTabs.state.executionSnapshot': '[AUSFUHRUNGSBILD]',
  'shell.workflowTabs.state.shared': '[GETEILT]',
  'shell.workflowTabs.state.unsavedChanges': '[UNGESPEICHERT]',
  'shell.workflowTabs.unsplit': '[Teilung aufheben]',
})

function fixture(previews?: {
  readonly mode: (tab: TestTab) => 'off' | 'cheap' | 'quality' | 'auto' | undefined
  readonly set: ReturnType<typeof vi.fn>
}) {
  const root = document.createElement('div')
  document.body.append(root)
  const [activeId, setActiveId] = createSignal('one')
  const close = vi.fn()
  const pointerDown = vi.fn()
  const create = vi.fn()
  const share = vi.fn()
  let tabRoot: HTMLElement | undefined
  const dispose = render(() => (
    <WorkflowTabs
      tabs={tabs}
      activeId={activeId()}
      isDirty={(tab) => tab.id === 'one'}
      isFrozen={(tab) => tab.id === 'two'}
      isShared={(tab) => tab.id === 'three'}
      setRoot={(element) => { tabRoot = element }}
      onActivate={(_event, tab) => setActiveId(tab.id)}
      onClose={close}
      onPointerDown={pointerDown}
      onNew={create}
      canShare={(tab) => tab.id !== 'two'}
      onShare={share}
      previews={previews?.mode}
      onSetPreviews={previews?.set}
    />
  ), root)
  return { root, activeId, close, pointerDown, create, share, get tabRoot() { return tabRoot }, dispose }
}

describe('workflow tabs', () => {
  it('exposes workflow-specific tab semantics and document state', () => {
    registerGermanCatalog()
    const view = fixture()
    const tablist = view.root.querySelector('[role="tablist"]')!
    const triggers = [...view.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const closes = [...view.root.querySelectorAll<HTMLButtonElement>('[data-testid="tab-close"]')]
    const newTab = view.root.querySelector<HTMLButtonElement>('[data-testid="new-tab"]')!

    expect(view.tabRoot?.getAttribute('aria-label')).toBe('Workflow documents')
    expect(tablist.getAttribute('aria-label')).toBe('Open workflows')
    expect(triggers.map((trigger) => trigger.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(triggers.map((trigger) => trigger.tabIndex)).toEqual([0, -1, -1])
    expect(triggers[0]?.getAttribute('aria-label')).toBe('One, unsaved changes')
    expect(triggers[1]?.getAttribute('aria-label')).toBe('Two, execution snapshot')
    expect(triggers[2]?.getAttribute('aria-label')).toBe('Three, shared')
    expect(triggers.every((trigger) => trigger.getAttribute('aria-controls') === 'workflow-editor-panel')).toBe(true)
    expect(view.root.querySelector('.tab.active .tab-dirty')).not.toBeNull()
    expect(view.root.querySelector('.tab.frozen')).not.toBeNull()
    expect(view.root.querySelector('.tab.shared')).not.toBeNull()

    triggers[0]!.focus()
    ;(tablist as HTMLElement).scrollLeft = 23
    setLocale('de-DE')

    expect(view.tabRoot?.getAttribute('aria-label')).toBe('[Ablaufdokumente]')
    expect(tablist.getAttribute('aria-label')).toBe('[Offene Ablaufe]')
    expect([...view.root.querySelectorAll('[role="tab"]')]).toEqual(triggers)
    expect([...view.root.querySelectorAll('[data-testid="tab-close"]')]).toEqual(closes)
    expect(triggers[0]?.getAttribute('aria-label')).toBe('One, [UNGESPEICHERT]')
    expect(triggers[1]?.getAttribute('aria-label')).toBe('Two, [AUSFUHRUNGSBILD]')
    expect(triggers[2]?.getAttribute('aria-label')).toBe('Three, [GETEILT]')
    expect(closes.map((button) => button.getAttribute('aria-label'))).toEqual([
      '[Schliesse One]', '[Schliesse Two]', '[Schliesse Three]',
    ])
    expect(newTab.getAttribute('aria-label')).toBe('[Neuer Ablauf]')
    expect(newTab.getAttribute('data-tooltip-label')).toBe('[Neuer Ablauf]')
    expect(document.activeElement).toBe(triggers[0])
    expect((tablist as HTMLElement).scrollLeft).toBe(23)
    expect(triggers.map((trigger) => trigger.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    view.dispose()
  })

  it('keeps workflow creation after the last tab inside the overflow strip', () => {
    const view = fixture()
    const tablist = view.root.querySelector<HTMLElement>('.workflow-tablist')!
    const newTab = view.root.querySelector<HTMLButtonElement>('[data-testid="new-tab"]')!

    expect(newTab.parentElement).toBe(tablist)
    expect(tablist.lastElementChild).toBe(newTab)
    expect(newTab.getAttribute('aria-label')).toBe('New workflow')
    view.dispose()
  })

  it('opens a tab context menu with the share action and targets the clicked tab', () => {
    const view = fixture()
    const third = view.root.querySelector<HTMLElement>('[data-tab-id="three"]')!

    third.dispatchEvent(new MouseEvent('contextmenu', { clientX: 120, clientY: 40, bubbles: true, cancelable: true }))
    const share = view.root.querySelector<HTMLElement>('[data-item-id="workflow.share"]')!
    expect(view.activeId()).toBe('three')
    expect(share.textContent).toContain('Share')
    expect(share.getAttribute('aria-disabled')).toBe('false')

    share.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(view.share).toHaveBeenCalledWith(tabs[2])
    expect(view.root.querySelector('[data-testid="context-menu"]')).toBeNull()
    view.dispose()
  })

  it('omits the live previews submenu when preview props are not provided', () => {
    const view = fixture()
    view.root.querySelector<HTMLElement>('[data-tab-id="one"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 120, clientY: 40, bubbles: true, cancelable: true }),
    )

    expect(view.root.querySelector('[data-item-id="workflow.previews"]')).toBeNull()
    view.dispose()
  })

  it('shows the live previews submenu with the current override checked and sets a mode', async () => {
    registerGermanCatalog()
    const set = vi.fn()
    const view = fixture({ mode: (tab) => (tab.id === 'one' ? 'quality' : undefined), set })
    view.root.querySelector<HTMLElement>('[data-tab-id="one"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 120, clientY: 40, bubbles: true, cancelable: true }),
    )
    const parent = view.root.querySelector<HTMLElement>('[data-item-id="workflow.previews"]')!
    expect(parent.textContent).toContain('Live previews')
    expect(parent.getAttribute('aria-disabled')).toBe('false')

    parent.dispatchEvent(new MouseEvent('mouseenter'))
    const rootMenu = view.root.querySelector<HTMLElement>('[data-testid="context-menu"]')!
    const submenu = view.root.querySelector<HTMLElement>('[data-testid="context-submenu"]')!
    const checked = [...submenu.querySelectorAll<HTMLElement>('[data-testid="context-menu-item"]')]
      .filter((row) => row.classList.contains('checked'))
    expect(checked.map((row) => row.getAttribute('data-item-id'))).toEqual(['workflow.previews.quality'])

    await Promise.resolve()
    const cascade = view.root.querySelector<HTMLElement>('.context-menu-cascade')!
    expect(document.activeElement).toBe(cascade)
    submenu.scrollTop = 19
    setLocale('de-DE')
    expect(view.root.querySelector('.context-menu-cascade')).toBe(cascade)
    expect(view.root.querySelector('[data-testid="context-menu"]')).toBe(rootMenu)
    expect(view.root.querySelector('[data-testid="context-submenu"]')).toBe(submenu)
    expect(submenu.scrollTop).toBe(19)
    expect(document.activeElement).toBe(cascade)
    expect(view.root.querySelector('[data-item-id="workflow.share"]')?.textContent).toContain('[Teilen]')
    expect(view.root.querySelector('[data-item-id="workflow.previews"]')?.textContent).toContain('[Live-Vorschauen]')
    expect([...view.root.querySelectorAll<HTMLElement>('[data-testid="context-submenu"] [data-testid="context-menu-item"]')]
      .map((row) => row.textContent?.trim())).toEqual([
      '[Global ubernehmen]', '[Aus]', '[Sparsam]', '[Qualitat]', '[Automatisch]',
    ])

    view.root.querySelector<HTMLElement>('[data-item-id="workflow.previews.off"]')!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    )
    expect(set).toHaveBeenCalledExactlyOnceWith(tabs[0], 'off')
    expect(view.root.querySelector('[data-testid="context-menu"]')).toBeNull()
    view.dispose()
  })

  it('checks Inherit global when no override is set and clears with null', () => {
    const set = vi.fn()
    const view = fixture({ mode: () => undefined, set })
    view.root.querySelector<HTMLElement>('[data-tab-id="one"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 120, clientY: 40, bubbles: true, cancelable: true }),
    )
    view.root.querySelector<HTMLElement>('[data-item-id="workflow.previews"]')!
      .dispatchEvent(new MouseEvent('mouseenter'))
    const submenu = view.root.querySelector<HTMLElement>('[data-testid="context-submenu"]')!
    const inherit = submenu.querySelector<HTMLElement>('[data-item-id="workflow.previews.inherit"]')!
    expect(inherit.classList.contains('checked')).toBe(true)

    inherit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(set).toHaveBeenCalledExactlyOnceWith(tabs[0], null)
    view.dispose()
  })

  it('disables the live previews submenu on a frozen execution snapshot tab', () => {
    const set = vi.fn()
    const view = fixture({ mode: () => undefined, set })
    view.root.querySelector<HTMLElement>('[data-tab-id="two"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 120, clientY: 40, bubbles: true, cancelable: true }),
    )

    expect(view.root.querySelector('[data-item-id="workflow.previews"]')?.getAttribute('aria-disabled')).toBe('true')
    view.dispose()
  })

  it('disables Share when the targeted workflow cannot be shared', () => {
    const view = fixture()
    view.root.querySelector<HTMLElement>('[data-tab-id="two"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 120, clientY: 40, bubbles: true, cancelable: true }),
    )

    expect(view.root.querySelector('[data-item-id="workflow.share"]')?.getAttribute('aria-disabled')).toBe('true')
    view.dispose()
  })

  it('restores tab focus when the context menu is dismissed with Escape', async () => {
    const view = fixture()
    view.root.querySelector<HTMLElement>('[data-tab-id="three"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 120, clientY: 40, bubbles: true, cancelable: true }),
    )
    await Promise.resolve()
    const menu = view.root.querySelector<HTMLElement>('.context-menu-cascade')!
    expect(document.activeElement).toBe(menu)
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    expect(view.root.querySelector('[data-testid="context-menu"]')).toBeNull()
    expect(document.activeElement?.id).toBe('workflow-tab-three')
    view.dispose()
  })

  it('restores tab focus when a context menu action is invoked', async () => {
    const view = fixture()
    view.root.querySelector<HTMLElement>('[data-tab-id="three"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 120, clientY: 40, bubbles: true, cancelable: true }),
    )
    await Promise.resolve()
    expect(document.activeElement).toBe(view.root.querySelector('.context-menu-cascade'))
    view.root.querySelector<HTMLElement>('[data-item-id="workflow.share"]')!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    )

    expect(view.share).toHaveBeenCalledWith(tabs[2])
    expect(document.activeElement?.id).toBe('workflow-tab-three')
    view.dispose()
  })

  it('leaves focus on an outside control when the menu closes from focus loss', async () => {
    const view = fixture()
    const outside = document.createElement('button')
    document.body.append(outside)
    view.root.querySelector<HTMLElement>('[data-tab-id="three"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 120, clientY: 40, bubbles: true, cancelable: true }),
    )
    await Promise.resolve()
    const menu = view.root.querySelector<HTMLElement>('.context-menu-cascade')!
    outside.focus()
    menu.dispatchEvent(new FocusEvent('focusout', { relatedTarget: outside, bubbles: true }))

    expect(view.root.querySelector('[data-testid="context-menu"]')).toBeNull()
    expect(document.activeElement).toBe(outside)
    outside.remove()
    view.dispose()
  })

  it('moves focus and activation with arrow, Home, and End keys', () => {
    const view = fixture()
    const trigger = (title: string) => view.root.querySelector<HTMLButtonElement>(`[role="tab"][aria-label^="${title}"]`)!

    trigger('One').focus()
    trigger('One').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(view.activeId()).toBe('two')
    expect(document.activeElement).toBe(trigger('Two'))

    trigger('Two').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    expect(view.activeId()).toBe('three')
    expect(document.activeElement).toBe(trigger('Three'))

    trigger('Three').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
    expect(view.activeId()).toBe('one')
    expect(document.activeElement).toBe(trigger('One'))
    view.dispose()
  })

  it('routes keyboard, middle-click, pointer drag, close, and new actions', () => {
    const view = fixture()
    const first = view.root.querySelector<HTMLElement>('[data-tab-id="one"]')!
    const firstTrigger = first.querySelector<HTMLButtonElement>('[role="tab"]')!
    const closeButton = first.querySelector<HTMLButtonElement>('[data-testid="tab-close"]')!

    firstTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    first.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
    first.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, button: 0, bubbles: true }))
    closeButton.click()
    view.root.querySelector<HTMLButtonElement>('[data-testid="new-tab"]')!.click()

    expect(view.close).toHaveBeenCalledTimes(3)
    expect(view.close).toHaveBeenNthCalledWith(1, tabs[0])
    expect(view.pointerDown).toHaveBeenCalledOnce()
    expect(view.create).toHaveBeenCalledOnce()
    view.dispose()
  })

  function popOutFixture(options: { readonly showNew?: boolean } = {}) {
    const root = document.createElement('div')
    document.body.append(root)
    const popOut = vi.fn()
    const activate = vi.fn()
    const dispose = render(() => (
      <WorkflowTabs
        tabs={tabs.slice(0, 2)}
        activeId="one"
        isDirty={() => false}
        isFrozen={() => false}
        isShared={() => false}
        setRoot={() => {}}
        onActivate={activate}
        onClose={() => {}}
        onPointerDown={() => {}}
        onNew={() => {}}
        canShare={() => true}
        onShare={() => {}}
        onPopOut={popOut}
        showNew={options.showNew}
      />
    ), root)
    return { root, popOut, activate, dispose }
  }

  it('renders no pop-out chrome button; the move lives in the tab context menu', () => {
    const view = popOutFixture({ showNew: false })

    expect(view.root.querySelector('[data-testid="tab-popout"]')).toBeNull()
    expect(view.root.querySelector('[data-testid="new-tab"]')).toBeNull()
    view.root.querySelector<HTMLElement>('[data-tab-id="two"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 120, clientY: 40, bubbles: true, cancelable: true }),
    )
    const item = view.root.querySelector<HTMLElement>('[data-item-id="workflow.openWindow"]')!
    expect(item.textContent).toContain('Move to new window')

    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(view.popOut).toHaveBeenCalledWith(tabs[1])
    expect(view.root.querySelector('[data-testid="context-menu"]')).toBeNull()
    view.dispose()
  })

  it('omits Move to new window when popping out is not offered', () => {
    const view = fixture()
    view.root.querySelector<HTMLElement>('[data-tab-id="one"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 120, clientY: 40, bubbles: true, cancelable: true }),
    )

    expect(view.root.querySelector('[data-testid="context-menu"]')).not.toBeNull()
    expect(view.root.querySelector('[data-item-id="workflow.openWindow"]')).toBeNull()
    view.dispose()
  })

  it('a keyboard contextmenu event without pointer coordinates opens the menu with the move', () => {
    const view = popOutFixture()
    view.root.querySelector<HTMLElement>('[data-tab-id="one"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 0, clientY: 0, bubbles: true, cancelable: true }),
    )

    expect(view.root.querySelector('[data-testid="context-menu"]')).not.toBeNull()
    expect(view.root.querySelector('[data-item-id="workflow.openWindow"]')).not.toBeNull()
    view.dispose()
  })

  it('right-clicking the strip outside a tab opens no menu and keeps the native event', () => {
    const view = popOutFixture()
    for (const target of [
      view.root.querySelector<HTMLElement>('[data-testid="new-tab"]')!,
      view.root.querySelector<HTMLElement>('.workflow-tablist')!,
    ]) {
      const event = new MouseEvent('contextmenu', { clientX: 300, clientY: 40, bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      expect(view.root.querySelector('[data-testid="context-menu"]')).toBeNull()
      expect(event.defaultPrevented).toBe(false)
    }
    view.dispose()
  })
})

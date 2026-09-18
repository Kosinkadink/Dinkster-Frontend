/**
 * Stale-modal guard:
 * app.modalPanel is session-only view state, and an id whose panel
 * unregisters or moves off 'modal' must be CLEARED, not merely hidden -
 * otherwise re-registering the panel (or remounting App with the same
 * AppState) would silently resurrect the dialog.
 */
import { describe, expect, it } from 'vitest'
import { AppState } from '../src/app-state.js'
import type { PanelDescriptor } from '../src/panels.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const settingsDescriptor = (placement: 'modal' | 'dock' = 'modal'): PanelDescriptor => ({
  id: 'settings',
  title: 'Settings',
  placement,
  allowedPlacements: ['modal', 'dock'],
  order: 10,
  component: () => undefined,
})

describe('modalPanel stale-state guard', () => {
  it('unregistering the open modal panel clears modalPanel; re-registering stays closed', () => {
    const app = new AppState()
    const unregister = app.panels.register(settingsDescriptor())
    app.modalPanel.set('settings')

    unregister()
    expect(app.modalPanel.get()).toBe('')

    app.panels.register(settingsDescriptor())
    expect(app.modalPanel.get()).toBe('')
  })

  it('moving the open modal panel off the modal placement clears modalPanel; moving back stays closed', () => {
    const app = new AppState()
    app.panels.register(settingsDescriptor())
    app.modalPanel.set('settings')

    expect(app.panels.setPlacement('settings', 'dock')).toBe(true)
    expect(app.modalPanel.get()).toBe('')

    expect(app.panels.setPlacement('settings', 'modal')).toBe(true)
    expect(app.modalPanel.get()).toBe('')
  })

  it('unrelated registry churn leaves an open modal alone', () => {
    const app = new AppState()
    app.panels.register(settingsDescriptor())
    app.modalPanel.set('settings')

    const unregister = app.panels.register({ ...settingsDescriptor(), id: 'other', placement: 'dock' })
    expect(app.modalPanel.get()).toBe('settings')
    unregister()
    expect(app.modalPanel.get()).toBe('settings')
  })
})

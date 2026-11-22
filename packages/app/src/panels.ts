/**
 * Panel registry: shell surfaces as registered descriptors instead of
 * hardcoded JSX. A panel declares its identity, its
 * default placement, and which placements it may legally occupy; the shell
 * renders whatever the registry says. Moving a surface is a data change
 * (one descriptor field or a placement override), never a JSX rewrite.
 *
 * The browser shell hosts floating overlays, while the desktop and browser
 * window managers actuate separate-window placement.
 */

import type { Component, JSX } from 'solid-js'
import { createSignal, type Signal } from '@dinkster/core'
import { scopedStorageKey } from './projects.js'

export type PanelPlacement = 'dock' | 'rail' | 'bottom' | 'modal' | 'floating' | 'window'

/** Placements the shell can actually host today. */
export const HOSTED_PLACEMENTS: readonly PanelPlacement[] = ['dock', 'rail', 'bottom', 'modal', 'floating', 'window']
// Floating placement is shell layout, so it is scoped to the active project.
const floatingPanelsKey = (): string => scopedStorageKey('dinkster.floatingPanels')

function browserStorage(): Storage | undefined {
  try { return globalThis.localStorage } catch { return undefined }
}

function storedFloatingPanels(storage: Storage | undefined): Set<string> {
  try {
    const value = JSON.parse(storage?.getItem(floatingPanelsKey()) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * What a host tells the surface it renders (promises.md "Common
 * SurfaceHost/SurfaceContext"): content receives WHERE it currently lives
 * and a way to ask its host to close it - and nothing else, so the same
 * body renders in a dock, the bottom panel, or a modal without knowing its
 * placement. Hosts own chrome (headers, close buttons, backdrops); bodies
 * own content. requestClose carries the host's semantics: dock/bottom close
 * their region, the modal host closes the dialog, the rail closes the rail
 * (its only close affordance).
 */
export interface SurfaceContext {
  readonly placement: PanelPlacement
  requestClose(): void
}

/** An action rendered in the panel's host chrome (e.g. the log Clear button). */
export interface PanelHeaderAction {
  readonly label: string
  readonly testId?: string
  run(): void
}

/**
 * A live attention badge a panel asks its hosts to render: a count with the
 * worst severity behind it. Hosts (tab strips, region toggles, floating
 * headers) own the rendering; the descriptor only supplies the facts, so the
 * badge follows the panel wherever it is placed. The label is the
 * screen-reader text for the badge (e.g. "3 problems, worst severity error").
 */
export interface PanelIndicator {
  readonly count: number
  readonly severity: 'error' | 'warning' | 'info'
  readonly label: string
}

const SEVERITY_RANK: Readonly<Record<PanelIndicator['severity'], number>> = { error: 2, warning: 1, info: 0 }

/**
 * Combine several panels' indicators into one badge (a region toggle
 * covering a whole zone): counts sum, the worst severity wins. Undefined
 * when nothing is indicated, so hosts render nothing.
 */
export function aggregatePanelIndicators(
  indicators: readonly (PanelIndicator | undefined)[],
): PanelIndicator | undefined {
  const active = indicators.filter((entry): entry is PanelIndicator => entry !== undefined && entry.count > 0)
  if (active.length === 0) return undefined
  const worst = active.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a))
  const count = active.reduce((sum, entry) => sum + entry.count, 0)
  return { count, severity: worst.severity, label: active.length === 1 ? active[0]!.label : `${count} notifications` }
}

export interface PanelDescriptor {
  /** Stable panel id ('library', 'logs', ...); also the dock's data-panel value. */
  readonly id: string
  /** Host-chrome title for dock placement; toggle tooltip title base. */
  readonly title: string
  /** Icon for placement toggles (dock panels get a sidebar button). */
  readonly icon?: Component
  /** Toggle tooltip; falls back to title. */
  readonly description?: string
  /** Toggle aria-label; falls back to title. */
  readonly ariaLabel?: string
  /** Default placement; must be in allowedPlacements. */
  readonly placement: PanelPlacement
  readonly allowedPlacements: readonly PanelPlacement[]
  /** Sort key within a placement host (sidebar buttons, default tab order). */
  readonly order: number
  /** Stable test id for the placement toggle (pre-registry ids preserved). */
  readonly toggleTestId?: string
  /** Optional host-chrome action (dock header). */
  readonly headerAction?: PanelHeaderAction
  /**
   * Live attention badge, re-evaluated reactively by hosts. Undefined (or an
   * undefined result) renders nothing; a count of 0 also renders nothing, so
   * the badge clears itself when the condition ends.
   */
  readonly indicator?: () => PanelIndicator | undefined
  /**
   * Visibility gate re-evaluated reactively by the host: a rail panel whose
   * `when` answers false renders nothing (e.g. extensions with no packs,
   * feature-flagged surfaces). Absent means always visible.
   */
  readonly when?: () => boolean
  /**
   * The panel body. Every placement renders inside host-owned chrome:
   * dock/bottom/modal hosts provide header, close, and resize/backdrop,
   * and rail panels render as tabs in the right zone's shared tab row
   * (DockZoneHost, documented in docs/shell.md) with the close action owned
   * by the host and placement moves in the tab's context menu. The host
   * passes the SurfaceContext;
   * bodies that need no placement facts simply ignore the argument.
   */
  readonly component: (surface: SurfaceContext) => JSX.Element
}

export class PanelRegistry {
  private readonly panels = new Map<string, PanelDescriptor>()
  private readonly overrides = new Map<string, PanelPlacement>()
  private readonly floatingPanels: Set<string>
  /** Bumped on every register/unregister/placement change. */
  readonly changed: Signal<number> = createSignal(0)

  constructor(private readonly storage: Storage | undefined = browserStorage()) {
    this.floatingPanels = storedFloatingPanels(storage)
  }

  /** Register a panel; returns the unregister function. Duplicate ids refuse loudly. */
  register(desc: PanelDescriptor): () => void {
    if (this.panels.has(desc.id)) throw new Error(`panel already registered: ${desc.id}`)
    if (!desc.allowedPlacements.includes(desc.placement))
      throw new Error(`panel ${desc.id}: default placement '${desc.placement}' not in allowedPlacements`)
    this.panels.set(desc.id, desc)
    if (this.floatingPanels.has(desc.id) && desc.allowedPlacements.includes('floating')) {
      this.overrides.set(desc.id, 'floating')
    }
    this.changed.update((v) => v + 1)
    return () => {
      this.panels.delete(desc.id)
      this.overrides.delete(desc.id)
      this.changed.update((v) => v + 1)
    }
  }

  get(id: string): PanelDescriptor | undefined {
    return this.panels.get(id)
  }

  /** Effective placement: override when set, else the descriptor default. */
  placementOf(id: string): PanelPlacement | undefined {
    const desc = this.panels.get(id)
    if (!desc) return undefined
    return this.overrides.get(id) ?? desc.placement
  }

  /**
   * Move a panel. Refused (false) when the panel is unknown, the placement
   * is not in its allowedPlacements, or the shell cannot host it yet.
   */
  setPlacement(id: string, placement: PanelPlacement): boolean {
    const desc = this.panels.get(id)
    if (!desc) return false
    if (!desc.allowedPlacements.includes(placement)) return false
    if (!HOSTED_PLACEMENTS.includes(placement)) return false
    if (this.placementOf(id) === placement) return true
    if (placement === desc.placement) this.overrides.delete(id)
    else this.overrides.set(id, placement)
    if (placement === 'floating') this.floatingPanels.add(id)
    else this.floatingPanels.delete(id)
    try { this.storage?.setItem(floatingPanelsKey(), JSON.stringify([...this.floatingPanels])) } catch {}
    this.changed.update((v) => v + 1)
    return true
  }

  /** Panels whose effective placement is `placement`, in `order`. */
  inPlacement(placement: PanelPlacement): PanelDescriptor[] {
    return [...this.panels.values()]
      .filter((p) => this.placementOf(p.id) === placement)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }

  /** Every registered panel, in `order`; placement overrides do not apply. */
  all(): PanelDescriptor[] {
    return [...this.panels.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }
}

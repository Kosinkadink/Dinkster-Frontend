/**
 * Shell geometry and bar visibility. DockLayout owns panel membership,
 * order, active tab, and open state for every dock zone; this class owns only
 * region pixel sizes and the activity/status bar switches. Values persist
 * per-browser through the settings machinery - overrides only, validated at
 * the read boundary (FR11), never backend-synced. Canvas viewport/lens stay
 * per-view session state and are deliberately NOT here.
 *
 * Binding is two-way without feedback loops: `seen` tracks the last value
 * observed in settings per key. Shell writers update `seen` BEFORE
 * settings.set, so their own changed tick pulls nothing; a settings-dialog
 * edit changes the stored value first, so the tick pulls it into the live
 * signal. Sizes update their signals live during a drag and the gesture
 * commits ONCE at drag end - previews never touch settings or `seen`, so an
 * unrelated settings change mid-drag cannot clobber the preview.
 */
import { createSignal, type Signal } from '@dinkster/core'
import type { SettingsRegistry } from './settings.js'

export type ShellRegion = 'left' | 'right' | 'bottom'

export const SHELL_ACTIVITY_BAR_VISIBLE = 'shell.layout.activityBar.visible'
export const SHELL_STATUS_BAR_VISIBLE = 'shell.layout.statusBar.visible'

export interface RegionSizeBounds {
  readonly min: number
  readonly max: number
  readonly fallback: number
}

/** Single source of truth for size clamps: setting definitions AND drags. */
export const REGION_SIZE_BOUNDS: Readonly<Record<ShellRegion, RegionSizeBounds>> = {
  left: { min: 280, max: 640, fallback: 380 },
  right: { min: 240, max: 560, fallback: 300 },
  bottom: { min: 120, max: 480, fallback: 240 },
}

export const clampRegionSize = (region: ShellRegion, px: number): number => {
  const bounds = REGION_SIZE_BOUNDS[region]
  if (!Number.isFinite(px)) return bounds.fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(px)))
}

const sizeKey = (region: ShellRegion): string =>
  `shell.layout.${region}.${region === 'bottom' ? 'height' : 'width'}`

export class ShellLayout {
  readonly activityBarVisible: Signal<boolean>
  readonly statusBarVisible: Signal<boolean>
  readonly leftWidth: Signal<number>
  readonly rightWidth: Signal<number>
  readonly bottomHeight: Signal<number>

  /** Last value observed in settings per key - the loop breaker (see header). */
  private readonly seen = new Map<string, string | number | boolean>()

  constructor(private readonly settings: SettingsRegistry) {
    settings.register({ id: SHELL_ACTIVITY_BAR_VISIBLE, name: 'Activity bar visible', category: 'shell', type: 'boolean', defaultValue: true, projectScoped: true })
    settings.register({ id: SHELL_STATUS_BAR_VISIBLE, name: 'Status bar visible', category: 'shell', type: 'boolean', defaultValue: true, projectScoped: true })
    for (const region of ['left', 'right', 'bottom'] as const) {
      const bounds = REGION_SIZE_BOUNDS[region]
      settings.register({
        id: sizeKey(region),
        name: `${region[0]!.toUpperCase()}${region.slice(1)} panel size (px)`,
        category: 'shell',
        type: 'number',
        defaultValue: bounds.fallback,
        min: bounds.min,
        max: bounds.max,
        step: 1,
        projectScoped: true,
      })
    }

    const initial = <T extends string | number | boolean>(key: string): T => {
      const value = this.settings.get<T>(key)
      this.seen.set(key, value)
      return value
    }
    this.activityBarVisible = createSignal(initial<boolean>(SHELL_ACTIVITY_BAR_VISIBLE))
    this.statusBarVisible = createSignal(initial<boolean>(SHELL_STATUS_BAR_VISIBLE))
    this.leftWidth = createSignal(initial<number>(sizeKey('left')))
    this.rightWidth = createSignal(initial<number>(sizeKey('right')))
    this.bottomHeight = createSignal(initial<number>(sizeKey('bottom')))

    // Bar switches write through immediately. Sizes persist via commitSize
    // at drag end so pointer previews remain in memory.
    this.activityBarVisible.subscribe((v) => this.write(SHELL_ACTIVITY_BAR_VISIBLE, v))
    this.statusBarVisible.subscribe((v) => this.write(SHELL_STATUS_BAR_VISIBLE, v))

    // Pull direction: a settings write this class did not make (the settings
    // dialog, an extension) updates the live shell instead of waiting for a
    // reload. settings.get re-validates (FR11), so tampered values fall back.
    settings.changed.subscribe(() => {
      this.pull(SHELL_ACTIVITY_BAR_VISIBLE, (v: boolean) => this.activityBarVisible.set(v))
      this.pull(SHELL_STATUS_BAR_VISIBLE, (v: boolean) => this.statusBarVisible.set(v))
      this.pull(sizeKey('left'), (v: number) => this.leftWidth.set(v))
      this.pull(sizeKey('right'), (v: number) => this.rightWidth.set(v))
      this.pull(sizeKey('bottom'), (v: number) => this.bottomHeight.set(v))
    })
  }

  /** Settings write that marks the value as seen first, so the tick is a no-op. */
  private write(key: string, value: string | number | boolean): void {
    if (this.seen.get(key) === value) return
    this.seen.set(key, value)
    this.settings.set(key, value)
  }

  /** Apply a settings value the shell has not seen yet (external writer). */
  private pull<T extends string | number | boolean>(key: string, apply: (value: T) => void): void {
    const value = this.settings.get<T>(key)
    if (this.seen.get(key) === value) return
    this.seen.set(key, value)
    apply(value)
  }

  /** Reset visibility only; user-resized region dimensions are preserved. */
  resetVisibility(): void {
    for (const key of [
      SHELL_ACTIVITY_BAR_VISIBLE,
      SHELL_STATUS_BAR_VISIBLE,
    ]) this.settings.reset(key)
  }

  private sizeSignal(region: ShellRegion): Signal<number> {
    return region === 'left' ? this.leftWidth : region === 'right' ? this.rightWidth : this.bottomHeight
  }

  /** Live (unpersisted) size update during a drag; clamped to the region bounds. */
  previewSize(region: ShellRegion, px: number): void {
    this.sizeSignal(region).set(clampRegionSize(region, px))
  }

  /** Persist the region's current size - called once at drag end. */
  commitSize(region: ShellRegion): void {
    this.write(sizeKey(region), this.sizeSignal(region).get())
  }
}

/**
 * Shared shell resize gesture: one pointerdown handler shape for every
 * region edge. `sign` is +1 when dragging toward positive axis direction
 * grows the region (left dock), -1 when it shrinks it (right rail, bottom
 * panel). The gesture is owned by the pointer that started it: other
 * pointers are ignored, pointercancel disposes without committing, and only
 * the owning pointerup commits - once. Returns a disposer so an unmount
 * mid-drag drops the window listeners instead of leaving them until a stray
 * pointerup.
 */
export function beginRegionResize(
  layout: ShellLayout,
  region: ShellRegion,
  down: PointerEvent,
  sign: 1 | -1,
): () => void {
  down.preventDefault()
  const pointerId = down.pointerId
  const axis = region === 'bottom' ? 'clientY' : 'clientX'
  const start = down[axis]
  const startSize =
    region === 'left' ? layout.leftWidth.get() : region === 'right' ? layout.rightWidth.get() : layout.bottomHeight.get()
  let done = false
  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    layout.previewSize(region, startSize + sign * (e[axis] - start))
  }
  const dispose = () => {
    if (done) return
    done = true
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
  }
  const up = (e: PointerEvent) => {
    if (done || e.pointerId !== pointerId) return
    dispose()
    layout.commitSize(region)
  }
  const cancel = (e: PointerEvent) => {
    if (e.pointerId === pointerId) dispose()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  return dispose
}

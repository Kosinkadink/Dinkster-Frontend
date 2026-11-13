/**
 * Shell geometry and bar visibility persist through the settings machinery,
 * restore on construction, clamp at every write, and never write per drag
 * move. No Solid, no DOM beyond the window listeners of the shared resize
 * gesture.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsRegistry, SETTINGS_STORAGE_KEY } from '../src/settings.js'
import {
  beginRegionResize,
  clampRegionSize,
  REGION_SIZE_BOUNDS,
  ShellLayout,
} from '../src/shell-layout.js'

function storage(seed?: string): Storage {
  const data = new Map<string, string>(seed ? [[SETTINGS_STORAGE_KEY, seed]] : [])
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) } as Storage
}

const layoutOn = (store: Storage): ShellLayout => new ShellLayout(new SettingsRegistry(store))

describe('ShellLayout persistence', () => {

  it('restores bar visibility and region sizes from a prior session', () => {
    const store = storage()
    const first = layoutOn(store)
    first.activityBarVisible.set(false)
    first.statusBarVisible.set(false)
    first.previewSize('left', 500)
    first.commitSize('left')
    first.previewSize('bottom', 300)
    first.commitSize('bottom')

    const second = layoutOn(store)
    expect(second.activityBarVisible.get()).toBe(false)
    expect(second.statusBarVisible.get()).toBe(false)
    expect(second.leftWidth.get()).toBe(500)
    expect(second.bottomHeight.get()).toBe(300)
    expect(second.rightWidth.get()).toBe(REGION_SIZE_BOUNDS.right.fallback)
  })

  it('FR11: tampered stored sizes fall back to the definition default', () => {
    const store = storage(JSON.stringify({ v: 1, values: {
      'shell.layout.left.width': 40,
      'shell.layout.right.width': 'wide',
      'shell.layout.bottom.height': Number.NaN,
    } }))
    const layout = layoutOn(store)
    expect(layout.leftWidth.get()).toBe(REGION_SIZE_BOUNDS.left.fallback)
    expect(layout.rightWidth.get()).toBe(REGION_SIZE_BOUNDS.right.fallback)
    expect(layout.bottomHeight.get()).toBe(REGION_SIZE_BOUNDS.bottom.fallback)
  })

  it('an external settings write (settings dialog) updates the live shell', () => {
    const settings = new SettingsRegistry(storage())
    const layout = new ShellLayout(settings)
    settings.set('shell.layout.left.width', 500)
    expect(layout.leftWidth.get()).toBe(500)
  })

  it('an unrelated settings change never clobbers an in-flight drag preview', () => {
    const settings = new SettingsRegistry(storage())
    settings.register({ id: 'other.thing', name: 'Other', type: 'boolean', defaultValue: false })
    const layout = new ShellLayout(settings)
    layout.previewSize('bottom', 400)
    settings.set('other.thing', true)
    expect(layout.bottomHeight.get()).toBe(400)
  })

  it('resets visibility defaults without changing region sizes', () => {
    const layout = layoutOn(storage())
    layout.activityBarVisible.set(false)
    layout.statusBarVisible.set(false)
    layout.previewSize('left', 500)
    layout.commitSize('left')

    layout.resetVisibility()
    expect(layout.activityBarVisible.get()).toBe(true)
    expect(layout.statusBarVisible.get()).toBe(true)
    expect(layout.leftWidth.get()).toBe(500)
  })
})

describe('ShellLayout semantics', () => {
  it('clamps every size write to the region bounds', () => {
    const layout = layoutOn(storage())
    layout.previewSize('left', 10_000)
    expect(layout.leftWidth.get()).toBe(REGION_SIZE_BOUNDS.left.max)
    layout.previewSize('left', 0)
    expect(layout.leftWidth.get()).toBe(REGION_SIZE_BOUNDS.left.min)
    layout.previewSize('bottom', -50)
    expect(layout.bottomHeight.get()).toBe(REGION_SIZE_BOUNDS.bottom.min)
    layout.previewSize('right', Number.POSITIVE_INFINITY)
    expect(layout.rightWidth.get()).toBe(REGION_SIZE_BOUNDS.right.fallback)
    expect(clampRegionSize('left', Number.NaN)).toBe(REGION_SIZE_BOUNDS.left.fallback)
    expect(clampRegionSize('right', 301.6)).toBe(302)
  })
})

describe('beginRegionResize gesture', () => {
  // Node test environment: stub the window the gesture attaches to.
  const listeners = new Map<string, (e: PointerEvent) => void>()
  const removed: string[] = []
  const fakeWindow = {
    addEventListener: (type: string, fn: EventListener) => {
      listeners.set(type, fn as (e: PointerEvent) => void)
    },
    removeEventListener: (type: string) => {
      removed.push(type)
    },
  }
  const install = (): void => {
    listeners.clear()
    removed.length = 0
    vi.stubGlobal('window', fakeWindow)
  }
  afterEach(() => vi.unstubAllGlobals())

  const pointer = (x: number, y: number, pointerId = 1): PointerEvent =>
    ({ pointerId, clientX: x, clientY: y, preventDefault: () => {} }) as unknown as PointerEvent

  it('previews on move (sign-aware), commits once at pointerup, and detaches', () => {
    install()
    const layout = layoutOn(storage())
    const commits = vi.spyOn(layout, 'commitSize')
    beginRegionResize(layout, 'bottom', pointer(100, 400), -1)
    // Dragging UP (smaller clientY) grows the bottom panel (sign -1).
    listeners.get('pointermove')!(pointer(100, 340))
    expect(layout.bottomHeight.get()).toBe(REGION_SIZE_BOUNDS.bottom.fallback + 60)
    expect(commits).not.toHaveBeenCalled()
    listeners.get('pointerup')!(pointer(100, 340))
    expect(commits).toHaveBeenCalledOnce()
    expect(removed).toEqual(expect.arrayContaining(['pointermove', 'pointerup', 'pointercancel']))
  })

  it('the gesture is owned by its pointer: foreign pointers neither move nor finish it', () => {
    install()
    const layout = layoutOn(storage())
    const commits = vi.spyOn(layout, 'commitSize')
    beginRegionResize(layout, 'bottom', pointer(100, 400, 1), -1)
    listeners.get('pointermove')!(pointer(100, 200, 2))
    expect(layout.bottomHeight.get()).toBe(REGION_SIZE_BOUNDS.bottom.fallback)
    listeners.get('pointerup')!(pointer(100, 200, 2))
    expect(commits).not.toHaveBeenCalled()
    expect(removed).toEqual([])
    listeners.get('pointerup')!(pointer(100, 400, 1))
    expect(commits).toHaveBeenCalledOnce()
  })

})

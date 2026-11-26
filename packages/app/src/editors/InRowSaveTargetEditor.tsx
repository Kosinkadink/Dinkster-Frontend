import { createEffect, createMemo, createSignal, onCleanup, type Component } from 'solid-js'
import type { MountSettings } from '@dinkster/client'
import { effectiveWidgetDefault, type Json } from '@dinkster/core'
import { isProjectDefaultTarget, isSaveTarget, saveTargetDraft, saveTargetText } from '@dinkster/widgets'
import {
  CanvasRowField,
  CanvasTargetBox,
  CanvasTargetSide,
  canvasTargetLayout,
  type CanvasTargetMount,
  type CanvasTargetMounts,
  type CanvasTargetStop,
} from '@dinkster/ui'
import { useAppMessage } from '../locale.js'
import type { WidgetEditorImplementationProps } from '../WidgetEditorController.js'
import { placeRow, rowPlacement, visibleCanvas } from './row-placement.js'

/**
 * A save target edited in its own row on the canvas: a box under the row
 * holds the mount dropdown and the filename prefix, and the row shows them
 * together as they would be stored. The dropdown's first entry is Project
 * default, which stores no mount, so each project saves to its own default
 * output mount. Nothing is stored while the box is open; Enter, Tab,
 * Ctrl+Enter or a press elsewhere store the mount and prefix as one value
 * through the same controller path as every other field. Escape stores
 * nothing.
 */
export const InRowSaveTargetImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const message = useAppMessage()
  const host = props.editor
  const ed = host.ed
  const spec = ed.spec!
  const inRow = ed.inRow!
  const initial = ed.initial ?? null
  const declared = effectiveWidgetDefault(spec) ?? null
  const defaultTarget = isSaveTarget(declared) || isProjectDefaultTarget(declared) ? declared : null
  const defaultName = defaultTarget?.prefix ?? ''
  // An empty target opens as Project default with the node's default name.
  const opened: Json = initial === null && defaultName !== '' ? { prefix: defaultName } : initial
  const target = ed.target.kind === 'input' ? ed.target : undefined
  const suffix = typeof spec.options['suffix'] === 'string' ? spec.options['suffix'] : ''

  const [mount, setMount] = createSignal<string | null>(isSaveTarget(opened) ? opened.mount : null)
  const [prefix, setPrefix] = createSignal(isSaveTarget(opened) || isProjectDefaultTarget(opened) ? opened.prefix : '')
  const [settings, setSettings] = createSignal<MountSettings>()
  const [error, setError] = createSignal<string>()
  let live = true
  onCleanup(() => { live = false })
  const backend = host.app.backendForTab(ed.tab)
  if (backend.protocol === 'dinkster') {
    void backend.connection.fetchMountSettings().then((value) => {
      if (live) setSettings(value)
    }).catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason))
    })
  } else setError(message('mountWidget.error'))

  const writable = () => settings()?.mounts.filter((entry) => entry.mode === 'readwrite' && entry.state === 'ready') ?? []
  const mounts = (): CanvasTargetMounts => {
    if (error() !== undefined) return 'failed'
    if (settings() === undefined) return 'loading'
    return writable().length === 0 ? 'none' : 'ready'
  }
  /** The mounts are read and the project has no default output mount, so a run on Project default cannot save. */
  const noDefault = (): boolean => settings() !== undefined && settings()!.activeOutputMount === undefined
  /** The mount Project default means here, or its name while that is not known. */
  const projectMount = (): string =>
    settings()?.activeOutputMount ?? message(noDefault() ? 'saveTargetWidget.noOutputMount' : 'saveTargetWidget.projectDefault')
  const textOf = (value: Json): string => saveTargetText(value, projectMount()) ?? message('saveTargetWidget.default')
  // Project default comes first. A picked mount that is not on this machine
  // stays listed, dimmed, so it is never replaced for the person.
  const options = createMemo<readonly CanvasTargetMount[]>(() => {
    const entries: CanvasTargetMount[] = [
      {
        id: '',
        label: message('saveTargetWidget.projectDefaultIs', { mount: projectMount() }),
        closedLabel: message('saveTargetWidget.projectDefault'),
      },
      ...writable().map((entry) => ({ id: entry.id, label: entry.id })),
    ]
    const picked = mount()
    if (picked !== null && !entries.some((entry) => entry.id === picked))
      entries.unshift({ id: picked, label: message('saveTargetWidget.notHere', { id: picked }), closedLabel: picked, unavailable: true })
    return entries
  })
  const draft = createMemo(() => saveTargetDraft({
    stored: opened,
    mount: mount(),
    prefix: prefix(),
    ready: mounts() === 'ready' ? writable().map((entry) => entry.id) : undefined,
    projectMount: projectMount(),
  }))

  /** Resolves true once the box is closed, false while it stays open. */
  const commit = (): Promise<boolean> => {
    if (!live || props.commitPending()) return Promise.resolve(false)
    const value = draft().store
    if (value === undefined) { props.close(); return Promise.resolve(true) }
    return props.commitValue(value).then((closed) => closed || !live)
  }
  host.bindClickAway?.(() => {
    if (props.commitPending()) return false
    void commit()
    return true
  })
  onCleanup(() => host.bindClickAway?.(undefined))

  // The mount list: opened from the dropdown, it takes Up, Down, Enter and
  // Escape until it closes; the box's own keys apply again after that.
  const [listOpen, setListOpen] = createSignal(false)
  const [highlight, setHighlight] = createSignal<number>()
  const openList = (): void => {
    if (mounts() !== 'ready' || props.commitPending()) return
    const at = options().findIndex((entry) => entry.id === (mount() ?? ''))
    setHighlight(at >= 0 && options()[at]?.unavailable !== true ? at : options().findIndex((entry) => entry.unavailable !== true))
    setListOpen(true)
  }
  const pick = (index: number): void => {
    const entry = options()[index]
    if (entry === undefined || entry.unavailable === true) return
    setMount(entry.id === '' ? null : entry.id)
    setListOpen(false)
    mountButton?.focus()
  }
  const step = (direction: 1 | -1): void => {
    const all = options()
    for (let at = (highlight() ?? -1) + direction; at >= 0 && at < all.length; at += direction) {
      if (all[at]?.unavailable !== true) { setHighlight(at); return }
    }
  }

  let mountButton: HTMLButtonElement | undefined
  let prefixInput: HTMLInputElement | undefined
  const [focused, setFocused] = createSignal<CanvasTargetStop>('prefix')
  const focusStop = (stop: CanvasTargetStop): void => {
    ;(stop === 'mount' ? mountButton : prefixInput)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return
    if (listOpen()) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); step(event.key === 'ArrowDown' ? 1 : -1); return }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); const at = highlight(); if (at !== undefined) pick(at); return }
      if (event.key === 'Escape') { event.preventDefault(); setListOpen(false); mountButton?.focus(); return }
      setListOpen(false)
    }
    const at = focused()
    if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      focusStop(at === 'mount' ? 'prefix' : 'mount')
    } else if (at === 'mount' && (event.key === ' ' || event.key === 'ArrowDown')) {
      event.preventDefault()
      openList()
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      const queue = host.app.commands.get('workflow.queue')
      void commit().then((closed) => { if (closed && queue?.enabled?.() !== false) queue?.run() })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void commit().then((closed) => {
        if (closed && target !== undefined) host.focusRow?.({ nodeId: target.nodeId, valueKey: target.valueKey })
      })
    } else if (event.key === 'Escape') {
      event.preventDefault()
      props.close()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      const direction = event.shiftKey ? -1 : 1
      if (target === undefined) return
      void commit().then((closed) => { if (closed && target !== undefined) host.moveRow?.({ nodeId: target.nodeId, valueKey: target.valueKey }, direction) })
    }
  }

  // Without a default output mount a run on Project default, or on a mount
  // this machine lacks, cannot save: that stops a run, so it reads as an error.
  const runStops = createMemo(() => {
    if (!noDefault()) return undefined
    if (draft().mountGone) return message('saveTargetWidget.notHereNoDefault', { id: mount() ?? '' })
    return mount() === null ? message('saveTargetWidget.noDefaultMount') : undefined
  })
  const mountTone = (): 'warning' | 'error' | undefined =>
    runStops() !== undefined ? 'error' : draft().mountGone ? 'warning' : undefined

  const side = createMemo(() => {
    const value = draft().store
    const gone = draft().mountGone ? mount() : null
    const stops = runStops()
    const firstError = error() ?? stops
    const problem = props.commitError()
      ?? (mounts() === 'none' ? message('saveTargetWidget.noMounts') : undefined)
      ?? (gone === null || stops !== undefined ? undefined : message('saveTargetWidget.notHereSaving', { id: gone, mount: projectMount() }))
    return (
      <CanvasTargetSide
        {...(problem === undefined ? {} : { problem })}
        enter={value === undefined
          ? { verb: message('saveTargetWidget.enterKeeps'), target: textOf(opened) }
          : { verb: message('saveTargetWidget.enterStores'), target: textOf(value) }}
        {...(gone === null || noDefault() ? {} : {
          action: {
            label: message('saveTargetWidget.useProjectDefault'),
            onClick: () => { setMount(null); prefixInput?.focus() },
          },
        })}
        defaultLabel="default"
        defaultText={textOf(defaultTarget)}
        {...(defaultTarget === null ? {} : {
          onDefault: () => {
            setMount(isSaveTarget(defaultTarget) ? defaultTarget.mount : null)
            setPrefix(defaultName)
            prefixInput?.focus()
          },
        })}
        {...(firstError === undefined ? {} : { error: firstError })}
        {...(inRow.help === undefined ? {} : { tooltip: inRow.help })}
        naming={message('saveTargetWidget.naming', { suffix })}
      />
    )
  })

  const bounds = visibleCanvas(host.boundary)
  const [sideSize, setSideSize] = createSignal({ width: 0, height: 0 })
  const [boxHeight, setBoxHeight] = createSignal(0)
  const placement = createMemo(() => {
    const row = rowPlacement(
      { rect: ed.rect, look: inRow.look, nodeTop: inRow.nodeTop, nodeBottom: inRow.nodeBottom },
      host.viewport(),
      bounds(),
      sideSize(),
    )
    return { ...row, ...canvasTargetLayout(row.screen, bounds(), boxHeight(), sideSize(), row.scale) }
  })
  let frame!: HTMLDivElement
  createEffect(() => placeRow(frame, placement()))

  const box = (
    <div ref={(element) => {
      const observer = new ResizeObserver(() => setBoxHeight(element.offsetHeight))
      observer.observe(element)
      onCleanup(() => observer.disconnect())
    }}>
      <CanvasTargetBox
        words={{
          mount: message('saveTargetWidget.mount'),
          prefix: message('saveTargetWidget.prefix'),
          loading: message('saveTargetWidget.loading'),
          none: message('saveTargetWidget.none'),
          failed: message('saveTargetWidget.couldNotLoad'),
        }}
        mounts={mounts()}
        options={options()}
        mount={mount() ?? ''}
        {...(mountTone() === undefined ? {} : { tone: mountTone()! })}
        listOpen={listOpen()}
        {...(highlight() === undefined ? {} : { highlight: highlight()! })}
        onToggleList={() => (listOpen() ? setListOpen(false) : openList())}
        onHighlight={setHighlight}
        onPick={pick}
        prefix={prefix()}
        onPrefix={setPrefix}
        {...(draft().prefixInvalid ? { prefixProblem: message('saveTargetWidget.invalid') } : {})}
        onFocusStop={setFocused}
        mountRef={(element) => { mountButton = element }}
        prefixRef={(element) => {
          prefixInput = element
          queueMicrotask(() => { element.focus(); element.select() })
        }}
        frozen={props.commitPending()}
      />
    </div>
  )

  return (
    <div
      ref={frame}
      class="widget-in-row-field"
      data-testid="widget-editor"
      data-editor-target={ed.target.kind}
      data-editor-mode={spec.widgetType}
      data-editor-surface="in-row"
      onKeyDown={onKeyDown}
    >
      <CanvasRowField
        look={inRow.look}
        rowWidth={placement().rowWidth}
        label={ed.label}
        value={draft().rowText}
        placeholder={message('saveTargetWidget.default')}
        onInput={() => undefined}
        inputRef={(element) => {
          // The row shows what would be stored; the box below is where it changes.
          element.readOnly = true
          element.tabIndex = -1
          element.addEventListener('focus', () => prefixInput?.focus())
        }}
        inputLabel={ed.label}
        zoomed={placement().scale > 1}
        place={placement().place}
        sideTop={placement().sideTop}
        {...(placement().sideMaxHeight === undefined ? {} : { sideMaxHeight: placement().sideMaxHeight! })}
        onSideSize={setSideSize}
        side={side()}
        panel={box}
        panelPlace={placement().panelPlace}
      />
    </div>
  )
}

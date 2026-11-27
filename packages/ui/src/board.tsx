import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  type Accessor,
  type JSX,
} from 'solid-js'
import {
  Ellipsis,
  Images,
  MousePointer2,
  Pause,
  Play,
  Plus,
  Redo2,
  SlidersHorizontal,
  SquareDashed,
  Square,
  Trash2,
  Type,
  Undo2,
  Workflow,
} from 'lucide-solid'
import {
  BOARD_MIN_SIDE,
  boardDropSection,
  boardPaintOrder,
  sectionMembers,
  type BoardAsset,
  type BoardCardItem,
  type BoardItem,
  type BoardMediaItem,
  type BoardSession,
} from '@dinkster/core'
import {
  canvasPaintTokens,
  clampScale,
  touchNavViewport,
  wheelNavigationViewport,
} from '@dinkster/canvas'
import {
  ProductButton,
  ProductIcon,
  ProductIconButton,
  ProductTextArea,
  ProductTextInput,
} from './controls.js'
import { ProductAudioWaveform } from './audio-waveform.js'
import { useFieldFocus } from './field-focus.js'
import { ProductMenu } from './menu.js'
import { BlueprintIcon } from './search.js'

/** Shared card chrome; the source owner supplies exposed controls and run state. */
export function ProductBoardCard(props: {
  readonly name: string
  readonly kind: 'workflow' | 'blueprint'
  readonly children: JSX.Element
  readonly lastRun: string
  readonly running?: boolean
  readonly disabled?: boolean
  readonly error?: string | undefined
  readonly onRun: () => void
  readonly onStop: () => void
  readonly onOpen: () => void
  readonly onChooseInputs: () => void
  readonly onOpenLastRun?: () => void
  readonly onRemove: () => void
}) {
  return (
    <div
      class="dinkster-board-card"
      onDblClick={(event) => {
        if (
          !(event.target as Element).closest('button, input, textarea, select')
        )
          props.onOpen()
      }}
    >
      <header class="dinkster-board-card-header">
        <ProductIcon
          icon={props.kind === 'blueprint' ? BlueprintIcon : Workflow}
        />
        <span class="dinkster-board-card-name" title={props.name}>
          {props.name}
        </span>
        <Show when={props.kind === 'blueprint'}>
          <span class="dinkster-board-card-badge">Blueprint</span>
        </Show>
        <ProductMenu
          label="Card actions"
          triggerName={`Actions for ${props.name}`}
          icon={Ellipsis}
          iconOnly
          fill="quiet"
          items={[
            {
              label: 'Open workflow',
              icon: Workflow,
              onSelect: props.onOpen,
            },
            {
              label: 'Choose inputs',
              icon: SlidersHorizontal,
              onSelect: props.onChooseInputs,
            },
            ...(props.onOpenLastRun
              ? [
                  {
                    label: 'Open last run',
                    icon: Play,
                    onSelect: props.onOpenLastRun,
                  },
                ]
              : []),
            'separator',
            {
              label: 'Remove from board',
              icon: Trash2,
              intent: 'remove',
              onSelect: props.onRemove,
            },
          ]}
        />
      </header>
      <div class="dinkster-board-card-inputs">{props.children}</div>
      <Show when={props.error}>
        {(error) => (
          <p class="dinkster-board-card-error" role="alert">
            {error()}
          </p>
        )}
      </Show>
      <footer class="dinkster-board-card-footer">
        <ProductButton
          intent={props.running ? 'neutral' : 'add'}
          disabled={props.disabled && !props.running}
          onClick={() => (props.running ? props.onStop() : props.onRun())}
        >
          <ProductIcon icon={props.running ? Square : Play} />
          {props.running ? 'Stop' : 'Run'}
        </ProductButton>
        <span class="dinkster-metadata" role="status">
          {props.lastRun}
        </span>
      </footer>
    </div>
  )
}

export interface ProductBoardProps {
  readonly store: BoardSession
  readonly fill?: boolean
  readonly assetUrl: (asset: BoardAsset) => string
  readonly viewControls: (view: {
    readonly zoom: number
    readonly onFit: () => void
    readonly onZoomBy: (factor: number) => void
    readonly onZoomTo: (scale: number) => void
  }) => JSX.Element
  readonly card?: (
    item: Accessor<BoardCardItem>,
    remove: () => void,
  ) => JSX.Element
  /** Absent when the source kind is unavailable; cancellation resolves without an id. */
  readonly onAddCard?: {
    readonly workflow?: (point: {
      x: number
      y: number
    }) => string | undefined | Promise<string | undefined>
    readonly blueprint?: (point: {
      x: number
      y: number
    }) => string | undefined | Promise<string | undefined>
  }
  readonly onAddMedia?: (point: { x: number; y: number }) => void
  readonly onDropMedia?: (
    event: DragEvent,
    point: { x: number; y: number },
  ) => void
}

type BoardCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

function resizedRect(
  item: BoardItem,
  corner: BoardCorner,
  dx: number,
  dy: number,
) {
  const left = corner.endsWith('left')
  const top = corner.startsWith('top')
  let width = Math.max(BOARD_MIN_SIDE, item.rect.width + (left ? -dx : dx))
  let height = Math.max(BOARD_MIN_SIDE, item.rect.height + (top ? -dy : dy))
  if (item.kind === 'picture' || item.kind === 'video') {
    const change =
      Math.abs(dx / item.rect.width) >= Math.abs(dy / item.rect.height)
        ? (left ? -dx : dx) / item.rect.width
        : (top ? -dy : dy) / item.rect.height
    const scale = Math.max(
      BOARD_MIN_SIDE / item.rect.width,
      BOARD_MIN_SIDE / item.rect.height,
      1 + change,
    )
    width = item.rect.width * scale
    height = item.rect.height * scale
  }
  return {
    x: item.rect.x + (left ? item.rect.width - width : 0),
    y: item.rect.y + (top ? item.rect.height - height : 0),
    width,
    height,
  }
}

function mediaLength(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return ''
  const seconds = Math.round(value)
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`
}

function BoardMedia(props: {
  item: BoardMediaItem
  src: string
  onMetadata: (metadata: {
    width?: number
    height?: number
    duration: number
  }) => void
}) {
  const [playing, setPlaying] = createSignal(false)
  const [duration, setDuration] = createSignal(props.item.asset.duration)
  const [elapsed, setElapsed] = createSignal(0)
  const [waveform, setWaveform] = createSignal('')
  const [waveformFailed, setWaveformFailed] = createSignal(false)
  const [playFailed, setPlayFailed] = createSignal(false)
  let media!: HTMLMediaElement
  const mediaSource = createMemo(() => props.src)
  const fraction = () => (duration() ? Math.min(1, elapsed() / duration()!) : 0)
  const seek = (seconds: number) => {
    if (!Number.isFinite(duration()) || !duration()) return
    media.currentTime = Math.max(0, Math.min(duration()!, seconds))
    setElapsed(media.currentTime)
  }
  const scrub = (event: PointerEvent) => {
    const target = event.currentTarget as Element
    const bounds = target.getBoundingClientRect()
    seek(((event.clientX - bounds.left) / bounds.width) * (duration() ?? 0))
  }
  const scrubStart = (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const target = event.currentTarget as HTMLElement
    target.focus()
    target.setPointerCapture(event.pointerId)
    scrub(event)
  }
  const scrubMove = (event: PointerEvent) => {
    if ((event.currentTarget as Element).hasPointerCapture(event.pointerId))
      scrub(event)
  }
  const scrubKey = (event: KeyboardEvent) => {
    const time =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? duration()
          : event.key === 'ArrowRight'
            ? elapsed() + 1
            : event.key === 'ArrowLeft'
              ? elapsed() - 1
              : undefined
    if (time === undefined) return
    event.preventDefault()
    event.stopPropagation()
    seek(time)
  }
  const soundSource = createMemo(() =>
    props.item.kind === 'sound' ? mediaSource() : undefined,
  )
  createEffect(() => {
    const src = soundSource()
    if (src === undefined) return
    const controller = new AbortController()
    const context = new OfflineAudioContext(1, 1, 44100)
    let live = true
    setWaveform('')
    setWaveformFailed(false)
    onCleanup(() => {
      live = false
      controller.abort()
    })
    void (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal })
        if (!response.ok) throw new Error('Audio preview could not be read')
        const audio = await context.decodeAudioData(
          await response.arrayBuffer(),
        )
        if (!live) return
        const channels = Array.from(
          { length: audio.numberOfChannels },
          (_, channel) => audio.getChannelData(channel),
        )
        const peaks = Array.from({ length: 72 }, (_, index) => {
          const from = Math.floor((index * audio.length) / 72)
          const to = Math.floor(((index + 1) * audio.length) / 72)
          let peak = 0
          for (const channel of channels)
            for (let sample = from; sample < to; sample += 1)
              peak = Math.max(peak, Math.abs(channel[sample]!))
          return peak
        })
        setWaveform(
          peaks
            .map(
              (peak, index) =>
                `M${index * 4 + 2} ${36 - peak * 32}v${Math.max(1, peak * 64)}`,
            )
            .join(' '),
        )
        setDuration(audio.duration)
        props.onMetadata({ duration: audio.duration })
      } catch {
        if (live) setWaveformFailed(true)
      }
    })()
  })
  onCleanup(() => media?.pause())
  const unreadable = () =>
    props.item.kind === 'sound' && (waveformFailed() || playFailed())
  const toggle = async () => {
    setPlayFailed(false)
    if (!media.paused) {
      media.pause()
      return
    }
    try {
      await media.play()
    } catch {
      setPlayFailed(true)
    }
  }
  const metadata = () => {
    setDuration(media.duration)
    props.onMetadata(
      media instanceof HTMLVideoElement
        ? {
            width: media.videoWidth,
            height: media.videoHeight,
            duration: media.duration,
          }
        : { duration: media.duration },
    )
  }
  return (
    <div
      class="dinkster-board-media"
      data-kind={props.item.kind}
      data-unreadable={unreadable()}
    >
      <Show
        when={props.item.kind === 'video'}
        fallback={
          <>
            <audio
              ref={(element) => {
                media = element
              }}
              src={mediaSource()}
              preload="metadata"
              onLoadedMetadata={metadata}
              onError={() => setPlayFailed(true)}
              onPlay={() => setPlaying(true)}
              onTimeUpdate={() => setElapsed(media.currentTime)}
              onPause={() => {
                setElapsed(media.currentTime)
                setPlaying(false)
              }}
              onEnded={() => setPlaying(false)}
            />
          </>
        }
      >
        <video
          class="dinkster-board-picture"
          ref={(element) => {
            media = element
          }}
          src={mediaSource()}
          preload="metadata"
          onLoadedMetadata={metadata}
          onPlay={() => setPlaying(true)}
          onTimeUpdate={() => setElapsed(media.currentTime)}
          onPause={() => {
            setElapsed(media.currentTime)
            setPlaying(false)
          }}
          onEnded={() => setPlaying(false)}
        />
      </Show>
      <Show when={unreadable()}>
        <div class="dinkster-board-unreadable" role="status">
          <span>{props.item.asset.name}</span>
          <span>This sound cannot be read</span>
        </div>
      </Show>
      <Show when={playFailed() && !unreadable()}>
        <span class="dinkster-board-media-message" role="status">
          Playback unavailable
        </span>
      </Show>
      <Show when={!unreadable()}>
        <div
          class="dinkster-board-media-control"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <ProductIconButton
            label={`${playing() ? 'Pause' : 'Play'} ${props.item.asset.name}`}
            icon={playing() ? Pause : Play}
            onClick={() => {
              void toggle()
            }}
          />
          <Show when={props.item.kind === 'sound'}>
            <ProductAudioWaveform
              path={waveform()}
              ariaLabel={`Waveform of ${props.item.asset.name}`}
              duration={duration() ?? 0}
              value={elapsed()}
              onSeek={seek}
            />
          </Show>
          <Show when={props.item.kind === 'video'}>
            <div
              class="dinkster-board-video-track"
              role="slider"
              tabindex={0}
              aria-label={`Seek ${props.item.asset.name}`}
              aria-valuemin={0}
              aria-valuemax={duration() ?? 0}
              aria-valuenow={elapsed()}
              onPointerDown={scrubStart}
              onPointerMove={scrubMove}
              onPointerUp={(event) =>
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              onKeyDown={scrubKey}
            >
              <span
                ref={(element) =>
                  createEffect(() => {
                    element.style.width = `${fraction() * 100}%`
                  })
                }
              />
            </div>
          </Show>
          <Show when={props.item.kind === 'video' && mediaLength(duration())}>
            {(length) => (
              <span class="dinkster-board-media-time">
                {mediaLength(Math.floor(elapsed()))} / {length()}
              </span>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}

/** A board owns its camera and selection; every document edit goes through its store. */
export function ProductBoard(props: ProductBoardProps) {
  useFieldFocus()
  const [document, setDocument] = createSignal(props.store.doc)
  const [selected, setSelected] = createSignal<string>()
  const [editingSection, setEditingSection] = createSignal<string>()
  const [editingNote, setEditingNote] = createSignal<string>()
  const [tool, setTool] = createSignal<'select' | 'note' | 'section'>('select')
  const [camera, setCamera] = createSignal({ x: 16, y: 80, scale: 1 })
  let surface!: HTMLDivElement
  const gridId = createUniqueId()
  const gridSpacing = () => {
    const grid = canvasPaintTokens.grid
    let spacing: number = grid.spacing
    while (spacing * camera().scale < grid.minScreenSpacing) spacing *= 2
    return spacing * camera().scale
  }
  const [preview, setPreview] = createSignal<{
    id: string
    rect: BoardItem['rect']
    moving: boolean
  }>()
  createEffect(() => {
    setDocument(props.store.doc)
    onCleanup(props.store.document.subscribe(setDocument))
  })
  const point = (clientX: number, clientY: number) => {
    const bounds = surface.getBoundingClientRect()
    const view = camera()
    return {
      x: (clientX - bounds.left - view.x) / view.scale,
      y: (clientY - bounds.top - view.y) / view.scale,
    }
  }
  const center = () => {
    const bounds = surface.getBoundingClientRect()
    return point(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
  }
  const addCard = async (kind: 'workflow' | 'blueprint') => {
    const id = await props.onAddCard?.[kind]?.(center())
    if (id && props.store.doc.items[id]) setSelected(id)
  }
  const zoom = (factor: number) => {
    const view = camera()
    const scale = clampScale(view.scale * factor)
    const x = surface.clientWidth / 2
    const y = surface.clientHeight / 2
    setCamera({
      x: x - ((x - view.x) * scale) / view.scale,
      y: y - ((y - view.y) * scale) / view.scale,
      scale,
    })
  }
  const fit = () => {
    const items = Object.values(document().items)
    if (!items.length) {
      setCamera({ x: 16, y: 80, scale: 1 })
      return
    }
    const left = Math.min(...items.map((item) => item.rect.x))
    const top = Math.min(...items.map((item) => item.rect.y))
    const right = Math.max(
      ...items.map((item) => item.rect.x + item.rect.width),
    )
    const bottom = Math.max(
      ...items.map((item) => item.rect.y + item.rect.height),
    )
    const scale = clampScale(
      Math.min(
        (surface.clientWidth - 100) / (right - left),
        (surface.clientHeight - 160) / (bottom - top),
        1,
      ),
    )
    setCamera({
      x: (surface.clientWidth - (right - left) * scale) / 2 - left * scale,
      y:
        80 +
        (surface.clientHeight - 160 - (bottom - top) * scale) / 2 -
        top * scale,
      scale,
    })
  }
  let cancelGesture: (() => void) | undefined
  onCleanup(() => cancelGesture?.())
  const gesture = (
    event: PointerEvent,
    move: (event: PointerEvent) => void,
    end: (commit: boolean) => void,
  ) => {
    cancelGesture?.()
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const finish = (commit: boolean) => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', cancel)
      if (target.hasPointerCapture(event.pointerId))
        target.releasePointerCapture(event.pointerId)
      cancelGesture = undefined
      end(commit)
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    cancelGesture = cancel
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', cancel)
  }
  const beginItem = (
    event: PointerEvent,
    item: BoardItem,
    resize?: BoardCorner,
  ) => {
    if (event.button !== 0) return
    setSelected(item.id)
    if (
      (event.target as Element).closest(
        'input, textarea, button, select, [role="menu"]',
      )
    )
      return
    event.stopPropagation()
    event.preventDefault()
    surface.focus({ preventScroll: true })
    const start = point(event.clientX, event.clientY)
    let rect = item.rect
    gesture(
      event,
      (next) => {
        const at = point(next.clientX, next.clientY)
        const dx = at.x - start.x
        const dy = at.y - start.y
        if (resize) rect = resizedRect(item, resize, dx, dy)
        else rect = { ...item.rect, x: item.rect.x + dx, y: item.rect.y + dy }
        setPreview({ id: item.id, rect, moving: !resize })
      },
      (commit) => {
        setPreview(undefined)
        if (!commit) return
        if (resize)
          props.store.dispatch({
            command: 'board.item.resize',
            params: { id: item.id, rect },
          })
        else
          props.store.dispatch({
            command: 'board.item.move',
            params: { moves: [{ id: item.id, x: rect.x, y: rect.y }] },
          })
      },
    )
  }
  const backgroundDown: JSX.EventHandler<HTMLDivElement, PointerEvent> = (
    event,
  ) => {
    if (event.button !== 0 && event.button !== 1) return
    if (
      (event.target as Element).closest(
        '[data-board-item], .dinkster-board-toolbar, .canvas-corner-controls',
      )
    )
      return
    surface.focus({ preventScroll: true })
    setSelected(undefined)
    setEditingNote(undefined)
    if (tool() !== 'select' && event.button === 0) {
      event.preventDefault()
      const at = point(event.clientX, event.clientY)
      const result = props.store.dispatch({
        command: 'board.item.add',
        params: {
          items: [
            tool() === 'note'
              ? {
                  kind: 'note',
                  text: '',
                  rect: { ...at, width: 260, height: 120 },
                }
              : {
                  kind: 'section',
                  name: 'New section',
                  rect: { ...at, width: 560, height: 360 },
                },
          ],
        },
      })
      if (result.ok) {
        setSelected(result.created[0])
        if (tool() === 'note') setEditingNote(result.created[0])
      }
      setTool('select')
      return
    }
    const start = { x: event.clientX, y: event.clientY, view: camera() }
    gesture(
      event,
      (next) =>
        setCamera({
          ...start.view,
          x: start.view.x + next.clientX - start.x,
          y: start.view.y + next.clientY - start.y,
        }),
      (commit) => {
        if (!commit) setCamera(start.view)
      },
    )
  }
  const itemRect = (item: BoardItem) => {
    const current = preview()
    if (!current) return item.rect
    if (current.id === item.id) return current.rect
    const moving = document().items[current.id]
    if (
      current.moving &&
      moving?.kind === 'section' &&
      sectionMembers(document(), moving.id).includes(item.id)
    ) {
      return {
        ...item.rect,
        x: item.rect.x + current.rect.x - moving.rect.x,
        y: item.rect.y + current.rect.y - moving.rect.y,
      }
    }
    return item.rect
  }
  let touches:
    | readonly [{ x: number; y: number }, { x: number; y: number }]
    | undefined
  const touchPoints = (event: TouchEvent) => {
    if (event.touches.length !== 2) return undefined
    const bounds = surface.getBoundingClientRect()
    return [0, 1].map((index) => ({
      x: event.touches[index]!.clientX - bounds.left,
      y: event.touches[index]!.clientY - bounds.top,
    })) as [{ x: number; y: number }, { x: number; y: number }]
  }
  return (
    <div
      class="dinkster-board"
      data-fill={props.fill ? 'true' : undefined}
      ref={surface}
      tabindex={0}
      role="region"
      aria-label="Board"
      onPointerDown={backgroundDown}
      onTouchStart={(event) => {
        touches = touchPoints(event)
        if (touches) cancelGesture?.()
      }}
      onTouchMove={(event) => {
        const next = touchPoints(event)
        if (touches && next)
          setCamera(
            touchNavViewport(
              camera(),
              touches[0],
              touches[1],
              next[0],
              next[1],
            ),
          )
        touches = next
      }}
      onTouchEnd={() => {
        touches = undefined
      }}
      onTouchCancel={() => {
        touches = undefined
      }}
      onDragOver={(event) => {
        if (props.onDropMedia) event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        props.onDropMedia?.(event, point(event.clientX, event.clientY))
      }}
      onWheel={(event) => {
        if ((event.target as Element).closest('textarea, input')) return
        event.preventDefault()
        const bounds = surface.getBoundingClientRect()
        setCamera(
          wheelNavigationViewport(
            camera(),
            {
              screenX: event.clientX - bounds.left,
              screenY: event.clientY - bounds.top,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              deltaMode: event.deltaMode,
              pageWidth: bounds.width,
              pageHeight: bounds.height,
              ctrlKey: event.ctrlKey,
            },
            'pan',
          ),
        )
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelGesture?.()
          if (editingNote()) {
            ;(event.target as HTMLElement).blur()
            setEditingNote(undefined)
            surface.focus({ preventScroll: true })
            return
          }
          setEditingSection(undefined)
          setSelected(undefined)
          setTool('select')
          surface.focus({ preventScroll: true })
          return
        }
        if (
          (event.target as Element).closest(
            'input, textarea, audio, video, button, select, [role="menu"]',
          )
        )
          return
        if (
          event.key === 'Enter' &&
          document().items[selected() ?? '']?.kind === 'note'
        ) {
          event.preventDefault()
          setEditingNote(selected())
        }
        if (
          event.key === 'Enter' &&
          document().items[selected() ?? '']?.kind === 'section'
        ) {
          event.preventDefault()
          setEditingSection(selected())
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 'z'
        ) {
          event.preventDefault()
          if (event.shiftKey) props.store.redo()
          else props.store.undo()
        }
        if (
          (event.key === 'Delete' || event.key === 'Backspace') &&
          selected()
        ) {
          event.preventDefault()
          props.store.dispatch({
            command: 'board.item.remove',
            params: { ids: [selected()!] },
          })
          setSelected(undefined)
        }
      }}
    >
      <svg class="dinkster-board-world" width="100%" height="100%">
        <defs>
          <pattern
            id={gridId}
            class="dinkster-board-grid"
            patternUnits="userSpaceOnUse"
            x={camera().x - gridSpacing() / 2}
            y={camera().y - gridSpacing() / 2}
            width={gridSpacing()}
            height={gridSpacing()}
          >
            <circle
              cx={gridSpacing() / 2}
              cy={gridSpacing() / 2}
              r={canvasPaintTokens.grid.dotRadius * camera().scale}
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${gridId})`} />
        <g
          transform={`translate(${camera().x} ${camera().y}) scale(${camera().scale})`}
        >
          <For each={boardPaintOrder(document()).map((item) => item.id)}>
            {(id) => {
              const item = () => document().items[id]!
              const initialItem = item()
              let element!: HTMLDivElement
              const [metadata, setMetadata] = createSignal<{
                width?: number
                height?: number
                duration?: number
              }>('asset' in initialItem ? initialItem.asset : {})
              const facts = () => {
                const value = metadata()
                return [
                  item().kind !== 'sound' && value.width && value.height
                    ? `${value.width} x ${value.height}`
                    : '',
                  item().kind !== 'picture' ? mediaLength(value.duration) : '',
                ]
                  .filter(Boolean)
                  .join(' / ')
              }
              createEffect(() => {
                const rect = itemRect(item())
                element.style.width = `${rect.width}px`
                element.style.height = `${rect.height}px`
              })
              return (
                <foreignObject
                  x={itemRect(item()).x}
                  y={itemRect(item()).y}
                  width={itemRect(item()).width + 40}
                  height={itemRect(item()).height + 40}
                  overflow="visible"
                >
                  <div
                    ref={element}
                    class="dinkster-board-item"
                    data-board-item={id}
                    data-kind={item().kind}
                    data-selected={selected() === id}
                    data-drop-target={
                      preview()?.moving &&
                      document().items[preview()!.id] !== undefined &&
                      boardDropSection(
                        document(),
                        document().items[preview()!.id]!,
                        preview()!.rect,
                      ) === id
                    }
                    onPointerDown={(event) => beginItem(event, item())}
                    onDblClick={() => {
                      if (item().kind === 'note') setEditingNote(id)
                    }}
                  >
                    <Show
                      when={((item) =>
                        (item.kind === 'workflow' ||
                          item.kind === 'blueprint') &&
                        item)(item())}
                    >
                      {(card) =>
                        props.card?.(card, () => {
                          props.store.dispatch({
                            command: 'board.item.remove',
                            params: { ids: [id] },
                          })
                          if (selected() === id) setSelected(undefined)
                        })
                      }
                    </Show>
                    <Show
                      when={((item) => item.kind === 'picture' && item)(item())}
                    >
                      {(picture) => (
                        <img
                          class="dinkster-board-picture"
                          src={props.assetUrl(picture().asset)}
                          alt={picture().asset.name}
                          draggable={false}
                          loading="lazy"
                          onLoad={(event) =>
                            setMetadata({
                              width: event.currentTarget.naturalWidth,
                              height: event.currentTarget.naturalHeight,
                            })
                          }
                        />
                      )}
                    </Show>
                    <Show
                      when={((item) =>
                        (item.kind === 'video' || item.kind === 'sound') &&
                        item)(item())}
                    >
                      {(media) => (
                        <BoardMedia
                          item={media()}
                          src={props.assetUrl(media().asset)}
                          onMetadata={setMetadata}
                        />
                      )}
                    </Show>
                    <Show
                      when={((item) => item.kind === 'note' && item)(item())}
                    >
                      {(note) => (
                        <Show
                          when={editingNote() === id}
                          fallback={
                            <div class="dinkster-board-note-text">
                              {note().text}
                            </div>
                          }
                        >
                          <ProductTextArea
                            aria-label="Note text"
                            value={note().text}
                            ref={(input) => queueMicrotask(() => input.focus())}
                            onFocus={() => setSelected(id)}
                            onBlur={() => setEditingNote(undefined)}
                            onChange={(event) =>
                              props.store.dispatch({
                                command: 'board.note.edit',
                                params: {
                                  id,
                                  text: event.currentTarget.value,
                                },
                              })
                            }
                          />
                        </Show>
                      )}
                    </Show>
                    <Show
                      when={((item) => item.kind === 'section' && item)(item())}
                    >
                      {(section) => (
                        <div
                          class="dinkster-board-section-name"
                          onPointerDown={(event) => {
                            event.stopPropagation()
                            setSelected(id)
                            if (!(event.target as Element).closest('input'))
                              surface.focus({ preventScroll: true })
                          }}
                          onDblClick={() => setEditingSection(id)}
                        >
                          <Show
                            when={editingSection() === id}
                            fallback={section().name}
                          >
                            <ProductTextInput
                              aria-label="Section name"
                              value={section().name}
                              ref={(input) =>
                                queueMicrotask(() => {
                                  input.focus()
                                  input.select()
                                })
                              }
                              onBlur={(event) => {
                                if (editingSection() !== id) return
                                props.store.dispatch({
                                  command: 'board.section.rename',
                                  params: {
                                    id,
                                    name: event.currentTarget.value,
                                  },
                                })
                                setEditingSection(undefined)
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  event.currentTarget.blur()
                                  surface.focus({ preventScroll: true })
                                }
                              }}
                            />
                          </Show>
                        </div>
                      )}
                    </Show>
                    <Show when={selected() === id}>
                      <Show when={((item) => 'asset' in item && item)(item())}>
                        {(media) => (
                          <div class="dinkster-board-caption">
                            {media().asset.name}
                            <Show when={facts()}>
                              {(value) => <span>{value()}</span>}
                            </Show>
                          </div>
                        )}
                      </Show>
                      <For
                        each={
                          [
                            'bottom-right',
                            'top-left',
                            'top-right',
                            'bottom-left',
                          ] as const
                        }
                      >
                        {(corner) => (
                          <div
                            class="dinkster-board-resize"
                            data-corner={corner}
                            role="separator"
                            aria-label={
                              corner === 'bottom-right'
                                ? 'Resize item'
                                : `Resize ${corner.replace('-', ' ')}`
                            }
                            aria-orientation="horizontal"
                            tabindex={0}
                            onPointerDown={(event) =>
                              beginItem(event, item(), corner)
                            }
                            onKeyDown={(event) => {
                              const dx =
                                event.key === 'ArrowRight'
                                  ? 10
                                  : event.key === 'ArrowLeft'
                                    ? -10
                                    : 0
                              const dy =
                                event.key === 'ArrowDown'
                                  ? 10
                                  : event.key === 'ArrowUp'
                                    ? -10
                                    : 0
                              if (!dx && !dy) return
                              event.preventDefault()
                              props.store.dispatch({
                                command: 'board.item.resize',
                                params: {
                                  id,
                                  rect: resizedRect(item(), corner, dx, dy),
                                },
                              })
                              queueMicrotask(() =>
                                surface
                                  .querySelector<HTMLElement>(
                                    `[data-board-item="${id}"] [data-corner="${corner}"]`,
                                  )
                                  ?.focus({ preventScroll: true }),
                              )
                            }}
                          />
                        )}
                      </For>
                    </Show>
                  </div>
                </foreignObject>
              )
            }}
          </For>
        </g>
      </svg>
      <div
        class="dinkster-board-toolbar"
        role="toolbar"
        aria-label="Board tools"
      >
        <ProductIconButton
          label="Select"
          icon={MousePointer2}
          aria-pressed={tool() === 'select'}
          onClick={() => setTool('select')}
        />
        <ProductIconButton
          label="Add note"
          icon={Type}
          aria-pressed={tool() === 'note'}
          onClick={() => setTool('note')}
        />
        <ProductIconButton
          label="Add section"
          icon={SquareDashed}
          aria-pressed={tool() === 'section'}
          onClick={() => setTool('section')}
        />
        <Show
          when={
            props.onAddMedia ||
            props.onAddCard?.workflow ||
            props.onAddCard?.blueprint
          }
        >
          <ProductMenu
            label="Add"
            icon={Plus}
            fill="quiet"
            items={[
              ...(props.onAddMedia
                ? [
                    {
                      label: 'Media',
                      icon: Images,
                      onSelect: () => props.onAddMedia?.(center()),
                    },
                  ]
                : []),
              ...(props.onAddCard?.workflow
                ? [
                    {
                      label: 'Workflow',
                      icon: Workflow,
                      onSelect: () => void addCard('workflow'),
                    },
                  ]
                : []),
              ...(props.onAddCard?.blueprint
                ? [
                    {
                      label: 'Blueprint',
                      icon: BlueprintIcon,
                      onSelect: () => void addCard('blueprint'),
                    },
                  ]
                : []),
            ]}
          />
        </Show>
        <ProductIconButton
          label="Undo"
          icon={Undo2}
          disabled={!document() || !props.store.canUndo}
          onClick={() => props.store.undo()}
        />
        <ProductIconButton
          label="Redo"
          icon={Redo2}
          disabled={!document() || !props.store.canRedo}
          onClick={() => props.store.redo()}
        />
      </div>
      {props.viewControls({
        get zoom() {
          return camera().scale
        },
        onFit: fit,
        onZoomBy: zoom,
        onZoomTo: (scale) => zoom(scale / camera().scale),
      })}
    </div>
  )
}

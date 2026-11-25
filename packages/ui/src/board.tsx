import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type JSX,
} from 'solid-js'
import {
  Maximize,
  MousePointer2,
  Plus,
  Redo2,
  SquareDashed,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-solid'
import {
  BOARD_MIN_SIDE,
  boardPaintOrder,
  sectionMembers,
  type BoardAsset,
  type BoardItem,
  type BoardStore,
} from '@dinkster/core'
import { clampScale, wheelNavigationViewport } from '@dinkster/canvas'
import {
  ProductButton,
  ProductIcon,
  ProductIconButton,
  ProductTextArea,
  ProductTextInput,
} from './controls.js'

export interface ProductBoardProps {
  readonly store: BoardStore
  readonly assetUrl: (asset: BoardAsset) => string
  readonly onAddMedia?: () => void
  readonly onDropMedia?: (
    event: DragEvent,
    point: { x: number; y: number },
  ) => void
}

/** A board owns its camera and selection; every document edit goes through its store. */
export function ProductBoard(props: ProductBoardProps) {
  const [document, setDocument] = createSignal(props.store.doc)
  const [selected, setSelected] = createSignal<string>()
  const [tool, setTool] = createSignal<'select' | 'note' | 'section'>('select')
  const [camera, setCamera] = createSignal({ x: 16, y: 80, scale: 1 })
  const [preview, setPreview] = createSignal<{
    id: string
    rect: BoardItem['rect']
  }>()
  let surface!: HTMLDivElement
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
  const beginItem = (event: PointerEvent, item: BoardItem, resize = false) => {
    if (event.button !== 0) return
    setSelected(item.id)
    if ((event.target as Element).closest('input, textarea, audio, video'))
      return
    event.stopPropagation()
    event.preventDefault()
    surface.focus()
    const start = point(event.clientX, event.clientY)
    let rect = item.rect
    gesture(
      event,
      (next) => {
        const at = point(next.clientX, next.clientY)
        const dx = at.x - start.x
        const dy = at.y - start.y
        if (resize) {
          const width = Math.max(
            BOARD_MIN_SIDE,
            item.kind === 'picture'
              ? (BOARD_MIN_SIDE * item.rect.width) / item.rect.height
              : BOARD_MIN_SIDE,
            item.rect.width + dx,
          )
          rect = {
            ...item.rect,
            width,
            height:
              item.kind === 'picture'
                ? Math.max(
                    BOARD_MIN_SIDE,
                    (width * item.rect.height) / item.rect.width,
                  )
                : Math.max(BOARD_MIN_SIDE, item.rect.height + dy),
          }
        } else rect = { ...item.rect, x: item.rect.x + dx, y: item.rect.y + dy }
        setPreview({ id: item.id, rect })
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
        '[data-board-item], .dinkster-board-toolbar, .dinkster-board-corner',
      )
    )
      return
    surface.focus()
    setSelected(undefined)
    if (tool() !== 'select' && event.button === 0) {
      const at = point(event.clientX, event.clientY)
      const result = props.store.dispatch({
        command: 'board.item.add',
        params: {
          items: [
            tool() === 'note'
              ? {
                  kind: 'note',
                  text: 'New note',
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
      if (result.ok) setSelected(result.created[0])
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
  return (
    <div
      class="dinkster-board"
      ref={surface}
      tabindex={0}
      role="region"
      aria-label="Board"
      onPointerDown={backgroundDown}
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
        if ((event.target as Element).closest('input, textarea, audio, video'))
          return
        if (event.key === 'Escape') {
          cancelGesture?.()
          setSelected(undefined)
          setTool('select')
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
        <g
          transform={`translate(${camera().x} ${camera().y}) scale(${camera().scale})`}
        >
          <For each={boardPaintOrder(document())}>
            {(item) => {
              let element!: HTMLDivElement
              createEffect(() => {
                const rect = itemRect(item)
                element.style.width = `${rect.width}px`
                element.style.height = `${rect.height}px`
              })
              return (
                <foreignObject
                  x={itemRect(item).x}
                  y={itemRect(item).y}
                  width={itemRect(item).width + 40}
                  height={itemRect(item).height + 40}
                  overflow="visible"
                >
                  <div
                    ref={element}
                    class="dinkster-board-item"
                    data-board-item={item.id}
                    data-kind={item.kind}
                    data-selected={selected() === item.id}
                    onPointerDown={(event) => beginItem(event, item)}
                  >
                    <Show when={item.kind === 'picture' && item}>
                      {(picture) => (
                        <img
                          class="dinkster-board-picture"
                          src={props.assetUrl(picture().asset)}
                          alt={picture().asset.name}
                          draggable={false}
                          loading="lazy"
                        />
                      )}
                    </Show>
                    <Show when={item.kind === 'video' && item}>
                      {(media) => (
                        <video
                          class="dinkster-board-picture"
                          src={props.assetUrl(media().asset)}
                          controls
                          preload="metadata"
                        />
                      )}
                    </Show>
                    <Show when={item.kind === 'sound' && item}>
                      {(media) => (
                        <audio
                          class="dinkster-board-audio"
                          src={props.assetUrl(media().asset)}
                          controls
                          preload="metadata"
                        />
                      )}
                    </Show>
                    <Show when={item.kind === 'note' && item}>
                      {(note) => (
                        <ProductTextArea
                          aria-label="Note text"
                          value={note().text}
                          onFocus={() => setSelected(item.id)}
                          onChange={(event) =>
                            props.store.dispatch({
                              command: 'board.note.edit',
                              params: {
                                id: item.id,
                                text: event.currentTarget.value,
                              },
                            })
                          }
                        />
                      )}
                    </Show>
                    <Show when={item.kind === 'section' && item}>
                      {(section) => (
                        <div class="dinkster-board-section-name">
                          <Show
                            when={selected() === item.id}
                            fallback={section().name}
                          >
                            <ProductTextInput
                              aria-label="Section name"
                              value={section().name}
                              onChange={(event) =>
                                props.store.dispatch({
                                  command: 'board.section.rename',
                                  params: {
                                    id: item.id,
                                    name: event.currentTarget.value,
                                  },
                                })
                              }
                            />
                          </Show>
                        </div>
                      )}
                    </Show>
                    <Show when={selected() === item.id}>
                      <div class="dinkster-board-caption">
                        {'asset' in item
                          ? item.asset.name
                          : item.kind === 'note'
                            ? 'Note'
                            : 'Section'}{' '}
                        <span>
                          {Math.round(item.rect.width)} x{' '}
                          {Math.round(item.rect.height)}
                        </span>
                      </div>
                      <div
                        class="dinkster-board-resize"
                        role="separator"
                        aria-label="Resize item"
                        aria-orientation="horizontal"
                        tabindex={0}
                        onPointerDown={(event) => beginItem(event, item, true)}
                        onKeyDown={(event) => {
                          const dx =
                            event.key === 'ArrowRight'
                              ? 10
                              : event.key === 'ArrowLeft'
                                ? -10
                                : 0
                          if (!dx) return
                          event.preventDefault()
                          const width = Math.max(
                            BOARD_MIN_SIDE,
                            item.kind === 'picture'
                              ? (BOARD_MIN_SIDE * item.rect.width) /
                                  item.rect.height
                              : BOARD_MIN_SIDE,
                            item.rect.width + dx,
                          )
                          props.store.dispatch({
                            command: 'board.item.resize',
                            params: {
                              id: item.id,
                              rect: {
                                ...item.rect,
                                width,
                                height:
                                  item.kind === 'picture'
                                    ? (width * item.rect.height) /
                                      item.rect.width
                                    : item.rect.height,
                              },
                            },
                          })
                        }}
                      />
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
        <Show when={props.onAddMedia}>
          <ProductButton intent="add" onClick={() => props.onAddMedia?.()}>
            <ProductIcon icon={Plus} />
            Add media
          </ProductButton>
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
      <div class="dinkster-board-corner" role="toolbar" aria-label="Board view">
        <ProductIconButton label="Fit board" icon={Maximize} onClick={fit} />
        <ProductIconButton
          label="Zoom out"
          icon={ZoomOut}
          onClick={() => zoom(1 / 1.2)}
        />
        <span>{Math.round(camera().scale * 100)}%</span>
        <ProductIconButton
          label="Zoom in"
          icon={ZoomIn}
          onClick={() => zoom(1.2)}
        />
      </div>
    </div>
  )
}

import type { PreviewData } from '@dinkster/client'
import { canvasPaintTokens } from '@dinkster/canvas'
import { CanvasEditorChoice, CanvasEditorLine, CanvasEditorNumber, CanvasEditorPicture } from '@dinkster/ui'
import { createEffect, createSignal, onCleanup, untrack } from 'solid-js'
import { drawImageCompare, frameBitmap, IMAGE_COMPARE_SIDES, type ImageCompareSide } from './image-compare-frames.js'
import { useAppMessage } from './locale.js'

/**
 * The comparison's controls in the node: both images of the last run with
 * the divider between them, dragged in the picture, then Wipe divider (%) and
 * the frame each side shows. Nothing is stored; the divider and the frames
 * start again when the workflow is opened again.
 */
export function ImageCompareSpace(props: {
  readonly frames: Readonly<Record<ImageCompareSide, readonly PreviewData[]>>
  readonly pictureHeight: number
}) {
  const message = useAppMessage()
  const [split, setSplit] = createSignal<number>(canvasPaintTokens.editor.imageCompare.initialSplit)
  const [selected, setSelected] = createSignal<Record<ImageCompareSide, number>>({ image_a: 0, image_b: 0 })
  let canvas: HTMLCanvasElement | undefined
  const shown = (side: ImageCompareSide): PreviewData | undefined => {
    const available = props.frames[side]
    return available.find((frame) => (frame.frameIndex ?? 0) === selected()[side]) ?? available[0]
  }
  const count = () => IMAGE_COMPARE_SIDES.filter((side) => props.frames[side].length > 0).length
  // Each side's picture, with the frame it was made from; a replaced picture is closed.
  const loaded: Partial<Record<ImageCompareSide, { readonly frame: PreviewData; readonly image: ImageBitmap }>> = {}
  const wanted: Partial<Record<ImageCompareSide, PreviewData>> = {}
  const redraw = (): void => {
    if (canvas === undefined) return
    // Drawn at twice the picture's size, so it stays sharp when the canvas is zoomed in.
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * 2))
    canvas.height = Math.max(1, Math.round(props.pictureHeight * 2))
    const images = Object.fromEntries(IMAGE_COMPARE_SIDES.flatMap((side) =>
      loaded[side] !== undefined && loaded[side]!.frame === wanted[side] ? [[side, loaded[side]!.image]] : []))
    drawImageCompare(canvas, images, split(), {
      color: canvasPaintTokens.editor.imageCompare.dividerColor, width: canvasPaintTokens.editor.imageCompare.dividerWidth * 2,
    })
  }
  createEffect(() => {
    for (const side of IMAGE_COMPARE_SIDES) {
      const frame = shown(side)
      if (frame === wanted[side]) continue
      if (frame === undefined) delete wanted[side]
      else wanted[side] = frame
      if (frame === undefined) continue
      void frameBitmap(frame).then((image) => {
        if (image === undefined) return
        // A frame replaced while it loaded is not drawn.
        if (wanted[side] !== frame) { image.close(); return }
        loaded[side]?.image.close()
        loaded[side] = { frame, image }
        redraw()
      })
    }
    split()
    props.pictureHeight
    untrack(redraw)
  })
  onCleanup(() => { for (const side of IMAGE_COMPARE_SIDES) loaded[side]?.image.close() })
  // The divider follows the pointer while it is held on the picture.
  const drag = (event: PointerEvent): void => {
    if (canvas === undefined || count() < 2 || (event.type === 'pointermove' && event.buttons === 0)) return
    const box = canvas.getBoundingClientRect()
    if (box.width <= 0) return
    setSplit(Math.round(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * 100))
  }
  const frameLabel = (frame: PreviewData) =>
    message('inNodeCompare.frame', { index: (frame.frameIndex ?? 0) + 1, count: frame.frameCount ?? 1 })
  return (
    <>
      <CanvasEditorPicture resizeLabel={message('inNodeEditor.pictureHeight')}
        {...(count() === 0 ? { message: message('inNodeCompare.runToCompare') } : {})}>
        <canvas class="node-image-compare" data-images={count()} role="img" aria-label={message('imageCompareWidget.preview')}
          ref={(element) => { canvas = element }}
          onPointerDown={(event) => {
            if (count() < 2) return
            event.currentTarget.setPointerCapture(event.pointerId)
            drag(event)
          }}
          onPointerMove={drag} />
      </CanvasEditorPicture>
      <CanvasEditorLine dimmed={count() < 2}>
        <CanvasEditorNumber label={message('inNodeCompare.divider')} value={split()} min={0} max={100} step={1}
          onChange={(value) => setSplit(Math.round(value))} />
      </CanvasEditorLine>
      {IMAGE_COMPARE_SIDES.map((side) => (
        <CanvasEditorLine dimmed={props.frames[side].length === 0}>
          <CanvasEditorChoice label={message(`imageCompareWidget.${side}`)}
            value={shown(side) === undefined ? message('imageCompareWidget.noFrames') : frameLabel(shown(side)!)}
            options={props.frames[side].map(frameLabel)}
            onChange={(label) => {
              const frame = props.frames[side].find((entry) => frameLabel(entry) === label)
              if (frame !== undefined) setSelected((previous) => ({ ...previous, [side]: frame.frameIndex ?? 0 }))
            }} />
        </CanvasEditorLine>
      ))}
    </>
  )
}

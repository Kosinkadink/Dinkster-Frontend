import { createSignal } from 'solid-js'
import { CanvasEditorChoice, CanvasEditorLine, CanvasEditorSpace, CanvasTargetBox, ProductSection } from '../src/index.js'

/** Both editor choices in small clipped spaces near the canvas edges. */
export function EditorChoicePlacementGallery() {
  const [curve, setCurve] = createSignal('Linear')
  const [mount, setMount] = createSignal('output')
  const [name, setName] = createSignal('shots/shot_042')
  const [open, setOpen] = createSignal(false)
  const [highlight, setHighlight] = createSignal(0)
  const mounts = ['output', 'archive', 'renders', 'delivery', 'backup', 'usb1']
  return <ProductSection title="Choice lists stay on the canvas">
    <div class="dinkster-canvas-example-stage dinkster-canvas-choice-example" ref={(element) => { element.style.height = '360px' }}>
      <CanvasEditorSpace ref={(element) => { element.style.left = '12px'; element.style.top = '290px'; element.style.width = '300px'; element.style.height = '40px' }}>
        <CanvasEditorLine><CanvasEditorChoice label="Interpolation" value={curve()}
          options={['Linear', 'Monotone cubic', 'Step']} onChange={setCurve} /></CanvasEditorLine>
      </CanvasEditorSpace>
      <CanvasEditorSpace ref={(element) => { element.style.right = '12px'; element.style.top = '230px'; element.style.width = '300px'; element.style.height = '80px' }}>
        <CanvasTargetBox inNode words={{ mount: 'Mount', prefix: 'Name', loading: 'Loading mounts', none: 'No mount ready', failed: 'Could not load' }}
          mounts="ready" options={mounts.map((id) => ({ id, label: id, ...(id === 'usb1' ? { unavailable: true } : {}) }))}
          mount={mount()} prefix={name()} onPrefix={setName}
          listOpen={open()} highlight={highlight()} onHighlight={setHighlight}
          onToggleList={() => setOpen(!open())}
          onPick={(index) => { setMount(mounts[index]!); setOpen(false) }} />
      </CanvasEditorSpace>
    </div>
  </ProductSection>
}

import { createEffect, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { CanvasEditorSpace, CanvasFileCopy } from '../../src/canvas-editor.js'

export function mount() {
  const [phase, setPhase] = createSignal<'checking' | 'waiting'>('checking')
  // Checking fits; Waiting overflows with either Chromium executable's font metrics.
  const [width, setWidth] = createSignal(120)
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  render(() => <CanvasEditorSpace ref={(element) => {
    createEffect(() => { element.style.width = `${width()}px` })
  }}>
    <CanvasFileCopy state={phase() === 'checking'
      ? { phase: 'checking', label: 'Checking the file', shortLabel: 'Checking' }
      : { phase: 'waiting', label: 'Waiting for another file', shortLabel: 'Waiting',
        stopLabel: 'Stop', onStop: () => {} }} />
  </CanvasEditorSpace>, container)
  return { setPhase, setWidth }
}

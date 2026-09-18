import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { semanticCssRoot } from '../../../core/src/ui/tokens.js'
import { TimelineLane, TimelineViewport } from '../../src/TimelineViewport.js'
import '../../src/styles.css'

/** Layout fixture, not a timeline document or a simulated backend. */
export function mountTimelineFixture(root: HTMLElement) {
  const style = document.createElement('style')
  style.textContent = `${semanticCssRoot}
    .timeline-lane button { color: var(--dinkster-text-primary); background: var(--dinkster-surface-raised); border: 1px solid var(--dinkster-border-strong); border-radius: 6px; }
    .timeline-lane button[aria-pressed=true] { color: var(--dinkster-text-on-selected); background: var(--dinkster-surface-selected); border-color: var(--dinkster-border-selected); }
  `
  document.head.append(style)
  const [time, setTime] = createSignal(2)
  const [unavailable, setUnavailable] = createSignal(false)
  const [selected, setSelected] = createSignal('First interval')
  return render(() => <main style={{ padding: '24px', width: '100%' }}>
    <h1>Timeline viewport component</h1>
    <p>Layout fixture only. Clip editing, rendering and OTIO are not connected.</p>
    <button onClick={() => setUnavailable(!unavailable())}>Toggle unavailable owner</button>
    <p role="status">Selected: {selected()}</p>
    <TimelineViewport duration={12} frameDuration={1001 / 30000} time={time()} onSeek={setTime}
      {...(unavailable() ? { unavailable: 'Execution owner unavailable. Timeline document cannot be loaded.' } : {})}>
      {(scale) => <>
        <TimelineLane label="Video lane" description="Caller-owned content">
          <button aria-pressed={selected() === 'First interval'} onClick={() => setSelected('First interval')}
            style={{ position: 'absolute', left: '0', top: '10px', width: `${5 * scale.pixelsPerSecond}px`, height: '56px' }}>First interval</button>
          <button aria-pressed={selected() === 'Second interval'} onClick={() => setSelected('Second interval')}
            style={{ position: 'absolute', left: `${6 * scale.pixelsPerSecond}px`, top: '10px', width: `${6 * scale.pixelsPerSecond}px`, height: '56px' }}>Second interval</button>
        </TimelineLane>
        <TimelineLane label="Audio lane" description="Caller-owned audio controls">
          <div style={{ position: 'absolute', left: `${scale.pixelsPerSecond}px`, top: '12px', width: `${10 * scale.pixelsPerSecond}px`, padding: '12px', border: '1px solid var(--dinkster-border-strong)', 'border-radius': '6px' }}>Audio content slot</div>
        </TimelineLane>
        <TimelineLane label="Automation lane" description="Caller-owned curve controls">
          <div style={{ padding: '12px', color: 'var(--dinkster-text-secondary)' }}>Curve editor slot</div>
        </TimelineLane>
      </>}
    </TimelineViewport>
  </main>, root)
}

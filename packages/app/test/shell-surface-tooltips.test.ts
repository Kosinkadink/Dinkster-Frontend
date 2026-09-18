import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')

describe('shell and surface product tooltip markup', () => {
  it('replaces every scoped App shell title with exact delegated tooltip wording', () => {
    const app = source('App.tsx')
    const execution = source('ExecutionActivityCard.tsx')
    const backends = source('BackendsPanel.tsx')
    const shellChrome = source('ShellChrome.tsx')
    expect(execution).toContain('Snapshot unavailable - submitted by another client')
    expect(execution).toContain("props.entry.artifact?.scope.kind === 'partial'")
    expect(execution).toContain('props.entry.errors.length > 0')
    expect(execution).toContain('class="execution-open"')
    expect(execution).toContain('class="execution-pin"')
    expect(app).toContain('aria-pressed={reviewReplacements()}')
    expect(execution).toContain("? 'Follow latest execution'")
    expect(execution).toContain(": 'Pin this execution to the canvas'")
    expect(backends).toContain("<code class=\"backend-address\">{props.backend.baseUrl || message('backendsPanel.sameOrigin')}</code>")
    expect(backends).toContain("aria-label={message('backendsPanel.aria.engine', { backend: props.backend.label })}")
    expect(app).toContain("dataAttributes={{ 'data-tooltip-label': message('shell.workflow.queueBackend') }}")
    expect(app).toContain('testId="tab-target"')
    expect(app).toContain("ariaLabel={message('shell.workflow.queueBackend')}")
    expect(app).not.toContain('<select')
    expect(app).toContain("data-tooltip-label={message('shell.reviewUpgrades.tooltip')}")
    expect(app).toContain("data-tooltip-label={message('shell.sharedSession', { status: status() })}")
    expect(shellChrome).toContain('data-tooltip-label={props.suppressTooltipWhenPressed && props.pressed ? undefined : props.tooltip}')
    expect(app).toContain("suppressTooltipWhenPressed={panel.id === 'assets' || panel.id === 'backends'}")
    for (const nativeTitle of [
      "title={p.exec.artifact ? 'Open frozen view' : 'Submitted by another client'}",
      'title={b.baseUrl',
      'title={supervisorOf(b)!.detail}',
      'title="Backend this tab queues to"',
      'title="When on, deprecated nodes are never upgraded automatically on open - review each via its badge (debug aid)."',
      'title={`Shared session (${status()})`}',
      'title={\n              overlayRoleOf(p.exec)',
    ]) expect(app).not.toContain(nativeTitle)
    expect(backends).not.toContain('title=')
  })

  it('replaces surface action and broken-binding titles with keyboard-reachable delegated tooltips', () => {
    const panel = source('SurfacePanel.tsx')
    expect(panel).toContain("data-tooltip-label={message('controlSurfaces.action.deleteSurface')}")
    expect(panel).toContain('data-tooltip-label={msg()}')
    expect(panel).toContain('class="surface-binding-broken" tabindex="0"')
    expect(panel).toContain("data-tooltip-label={message('controlSurfaces.action.removeBinding')}")
    expect(panel).toContain("ariaLabel={message('controlSurfaces.action.bindGroup')}")
    expect(panel).toContain('selectedId=""')
    expect(panel).not.toContain('<select')
    expect(panel).not.toMatch(/title=(?:"Delete surface"|"Remove binding"|{msg\(\)})/)
  })

  it('replaces the minimap bookmark title without changing its switch contract', () => {
    const canvas = source('CanvasHost.tsx')
    expect(canvas).toContain('data-testid="minimap-marker-toggle" aria-checked=')
    expect(canvas).toContain('data-tooltip-label="Show bookmark numbers on the minimap"')
    expect(canvas).toContain('aria-label="Bookmarks. Show bookmark numbers on the minimap"')
    expect(canvas).not.toContain('title="Show bookmark numbers on the minimap"')
  })
})

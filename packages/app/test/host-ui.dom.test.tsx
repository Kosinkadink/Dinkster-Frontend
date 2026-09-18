import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import type { Diagnostic, HostUiProviderV1, Json } from '@dinkster/core'
import { AssetEditorShell } from '../src/AssetEditorShell.js'
import { HostUiProviderHost, HostUiRenderer } from '../src/host-ui.js'
import { CommandRegistry } from '../src/settings.js'

let root: HTMLDivElement
let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); root?.remove(); dispose = undefined })
const mount = (view: () => unknown) => {
  root = document.createElement('div')
  document.body.append(root)
  dispose = render(view as never, root)
}

const assetEditorContribution = () => ({
  version: 1,
  root: {
    kind: 'asset-editor',
    key: 'fixture.asset-editor',
    presentation: {
      heading: 'Portrait study',
      description: 'Presentation supplied by a registered widget view.',
      viewport: { label: 'Portrait preview', state: 'ready', detail: 'Responsive media viewport' },
      fields: [
        { key: 'field.ui', kind: 'display', label: 'Prompt', value: 'Soft studio portrait', origin: { label: 'UI-authored', detail: 'Displayed origin supplied upstream.', tone: 'accent' }, capability: { kind: 'editable' }, validation: { key: 'field.ui.validation', tone: 'warning', text: 'Review before export.' }, action: { key: 'field.ui.action', label: 'Edit Prompt', command: 'fixture.edit-prompt', state: 'enabled' } },
        { key: 'field.node', kind: 'display', label: 'Seed', value: '12345', origin: { label: 'Node-authored' }, capability: { kind: 'read-only', reason: 'Locked by the supplied capability.' }, action: { key: 'field.node.action', label: 'Must not render', command: 'fixture.edit-seed', state: 'enabled' } },
        { key: 'field.linked', kind: 'display', label: 'Dimensions', value: '2048 x 2048', origin: { label: 'Calculated / linked', tone: 'info' }, capability: { kind: 'read-only' } },
        { key: 'field.imported', kind: 'display', label: 'Color profile', value: 'Display P3', origin: { label: 'Imported' }, capability: { kind: 'editable' } },
        { key: 'field.mixed', kind: 'display', label: 'Description', value: 'Merged presentation', origin: { label: 'Mixed', tone: 'warning' }, capability: { kind: 'read-only' } },
        { key: 'field.unknown-kind', kind: 'future-slider', label: 'Future field', value: 'Never exposed', capability: { kind: 'editable' }, action: { key: 'field.unknown-kind.action', label: 'Unsafe edit', command: 'fixture.unsafe', state: 'enabled' } },
        { key: 'field.unknown-capability', kind: 'display', label: 'Future capability', value: 'Never exposed', capability: { kind: 'future-edit' }, action: { key: 'field.unknown-capability.action', label: 'Unsafe capability', command: 'fixture.unsafe', state: 'enabled' } },
      ],
      messages: [
        { key: 'notice.version', tone: 'warning', text: 'Unsupported version supplied by the adapter.' },
        { key: 'notice.migration', tone: 'info', text: 'Normalization and migration notice supplied upstream.' },
        { key: 'notice.form', tone: 'error', text: 'Form-level validation requires attention.' },
      ],
      factGroups: [
        { key: 'facts.source', label: 'Source facts', facts: [
          { key: 'source.absent', label: 'Capture device', state: 'absent' },
          { key: 'source.pending', label: 'Metadata', state: 'pending', detail: 'Reading facts' },
          { key: 'source.ready', label: 'Input', state: 'ready', value: 'portrait.png' },
          { key: 'source.error', label: 'Sidecar', state: 'error', detail: 'Unavailable' },
        ] },
        { key: 'facts.output', label: 'Output facts', facts: [
          { key: 'output.absent', label: 'Published copy', state: 'absent' },
          { key: 'output.pending', label: 'Preview', state: 'pending', detail: 'Preparing' },
          { key: 'output.ready', label: 'Dimensions', state: 'ready', value: '2048 x 2048' },
          { key: 'output.error', label: 'Thumbnail', state: 'error', detail: 'Failed upstream' },
        ] },
      ],
      tools: [
        { key: 'tool.absent', label: 'Timeline unavailable', state: 'absent' },
        { key: 'tool.loading', label: 'Timeline loading', state: 'loading', detail: 'Loading supplied timeline state' },
        { key: 'tool.ready', label: 'Crop ready', state: 'ready', actions: [{ key: 'tool.ready.open', label: 'Open crop controls', command: 'fixture.open-crop', state: 'enabled' }] },
        { key: 'tool.disabled', label: 'Crop disabled', state: 'disabled', detail: 'Disabled by supplied capability' },
        { key: 'tool.error', label: 'Timeline error', state: 'error', detail: 'Supplied tool error' },
      ],
      actions: [
        { key: 'action.export', label: 'Export', command: 'fixture.export', state: 'enabled' },
        { key: 'action.import', label: 'Import', command: 'fixture.import', state: 'disabled', disabledReason: 'Import is unavailable for this asset.' },
        { key: 'action.open', label: 'Open in workflow', command: 'fixture.open', state: 'failed', detail: 'The previous request failed.' },
        { key: 'action.apply', label: 'Apply', command: 'fixture.apply', state: 'pending', detail: 'Applying supplied state' },
        { key: 'action.cancel-apply', label: 'Cancel apply', command: 'fixture.cancel-apply', state: 'enabled' },
        { key: 'action.progress', label: 'Background task', command: 'fixture.progress', state: 'pending', detail: 'Supplied pending state.' },
        { key: 'action.missing', label: 'Unavailable command', command: 'fixture.missing', state: 'enabled' },
      ],
    },
  },
})

describe('host UI renderer', () => {
  it('renders core and extension text/status/action semantics and invokes payload commands', () => {
    const commands = new CommandRegistry()
    let enabled = true
    const run = vi.fn()
    commands.register({ id: 'demo.run', label: 'Run', enabled: () => enabled, run })
    mount(() => <HostUiRenderer commands={commands} contribution={{ root: {
      kind: 'group', key: 'core.status', direction: 'row', children: [
        { kind: 'text', key: 'core.schemas', text: '42 node schemas' },
        { kind: 'status', key: 'demo.monitor', text: 'Monitor ready', tone: 'success', live: 'polite' },
        { kind: 'action', key: 'demo.action', label: 'Run monitor', command: 'demo.run', payload: { source: 'status' } },
      ],
    } }} />)
    expect(root.textContent).toContain('42 node schemas')
    expect(root.querySelector('[role=status]')?.getAttribute('aria-live')).toBe('polite')
    const button = root.querySelector('button')!
    button.click()
    expect(run).toHaveBeenCalledWith({ source: 'status' })
    enabled = false
    button.click()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('renders disabled reasons accessibly', () => {
    mount(() => <HostUiRenderer commands={new CommandRegistry()} contribution={{ root: {
      kind: 'action', key: 'demo.disabled', label: 'Unavailable', command: 'demo.run', disabled: true, disabledReason: 'Needs a connection',
    } }} />)
    const button = root.querySelector('button')!
    expect(button.disabled).toBe(true)
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe('Needs a connection')
  })

  it('renders the complete asset editor state matrix and invokes registered commands only', () => {
    const commands = new CommandRegistry()
    const editPrompt = vi.fn()
    const exportAsset = vi.fn()
    const openWorkflow = vi.fn()
    const cancelApply = vi.fn()
    const openCrop = vi.fn()
    commands.register({ id: 'fixture.edit-prompt', label: 'Edit Prompt', run: editPrompt })
    commands.register({ id: 'fixture.export', label: 'Export', run: exportAsset })
    commands.register({ id: 'fixture.import', label: 'Import', run: vi.fn() })
    commands.register({ id: 'fixture.open', label: 'Open in workflow', run: openWorkflow })
    commands.register({ id: 'fixture.apply', label: 'Apply', run: vi.fn() })
    commands.register({ id: 'fixture.cancel-apply', label: 'Cancel apply', run: cancelApply })
    commands.register({ id: 'fixture.progress', label: 'Progress', run: vi.fn() })
    commands.register({ id: 'fixture.open-crop', label: 'Open crop', run: openCrop })
    commands.register({ id: 'fixture.edit-seed', label: 'Edit Seed', run: vi.fn() })
    commands.register({ id: 'fixture.unsafe', label: 'Unsafe', run: vi.fn() })
    const snapshots = new Map<string | symbol, readonly Diagnostic[]>()
    mount(() => <HostUiProviderHost
      owner="asset-editor-fixture"
      provider={assetEditorContribution}
      data={{ value: 'fixture' }}
      surface="widget-editor"
      commands={commands}
      replaceProblems={(owner, diagnostics) => snapshots.set(owner, diagnostics)}
    />)

    expect(snapshots.get('asset-editor-fixture')).toEqual([])
    expect(root.querySelector('[data-testid=asset-editor-shell]')).not.toBeNull()
    expect(root.querySelector('[data-testid=asset-editor-shell]')?.getAttribute('data-host-ui-key')).toBe('fixture.asset-editor')
    expect(root.textContent).toContain('UI-authored')
    expect(root.textContent).toContain('Displayed origin supplied upstream.')
    expect(root.textContent).toContain('Node-authored')
    expect(root.textContent).toContain('Calculated / linked')
    expect(root.textContent).toContain('Imported')
    expect(root.textContent).toContain('Mixed')
    expect(root.textContent).toContain('Review before export.')
    expect(root.textContent).toContain('Form-level validation requires attention.')
    expect(root.querySelectorAll('[data-fact-state=absent]')).toHaveLength(2)
    expect(root.querySelectorAll('[data-fact-state=pending]')).toHaveLength(2)
    expect(root.querySelectorAll('[data-fact-state=ready]')).toHaveLength(2)
    expect(root.querySelectorAll('[data-fact-state=error]')).toHaveLength(2)
    const prompt = [...root.querySelectorAll<HTMLInputElement>('input')].find((input) => input.value === 'Soft studio portrait')!
    expect(document.getElementById(prompt.getAttribute('aria-labelledby')!)?.textContent).toBe('Prompt')
    expect(document.getElementById(prompt.getAttribute('aria-describedby')!)?.textContent).toBe('Review before export.')
    expect(root.querySelectorAll('[data-testid=asset-editor-shell-unsupported]')).toHaveLength(2)
    expect(root.textContent).not.toContain('Never exposed')
    expect(root.textContent).not.toContain('Must not render')

    const button = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label)!
    button('Edit Prompt').click()
    button('Export').click()
    button('Cancel apply').click()
    expect(editPrompt).toHaveBeenCalledWith()
    expect(exportAsset).toHaveBeenCalledWith()
    expect(openWorkflow).not.toHaveBeenCalled()
    expect(cancelApply).toHaveBeenCalledWith()
    expect(button('Import').disabled).toBe(true)
    expect(button('Open in workflow').disabled).toBe(true)
    expect(button('Apply').disabled).toBe(true)
    expect(button('Background task').disabled).toBe(true)
    expect(button('Unavailable command').disabled).toBe(true)
    expect(root.textContent).toContain('Import is unavailable for this asset.')

    button('Editor').click()
    expect(root.querySelectorAll('[data-tool-state]')).toHaveLength(5)
    expect(root.textContent).toContain('Timeline unavailable')
    expect(root.textContent).toContain('Crop disabled')
    button('Open crop controls').click()
    expect(openCrop).toHaveBeenCalledWith()
  })

  it('projects every asset editor viewport state into accessible status semantics', () => {
    const states = [
      { state: 'absent', role: 'status', live: 'polite' },
      { state: 'loading', role: 'status', live: 'polite' },
      { state: 'ready', role: 'status', live: 'polite' },
      { state: 'error', role: 'alert', live: 'assertive' },
    ] as const
    const commands = new CommandRegistry()
    mount(() => <>
      {states.map(({ state }) => (
        <AssetEditorShell
          presentation={{
            heading: `${state} editor`,
            viewport: { label: `${state} viewport`, state },
            fields: [],
          }}
          commands={commands}
          idPrefix={`viewport-${state}`}
          hostUiKey={`viewport.${state}`}
        />
      ))}
    </>)

    for (const { state, role, live } of states) {
      const viewport = root.querySelector<HTMLElement>(`[data-viewport-state="${state}"]`)!
      expect(document.getElementById(viewport.getAttribute('aria-labelledby')!)?.textContent).toBe(`${state} viewport`)
      const stateDescription = document.getElementById(viewport.getAttribute('aria-describedby')!)!
      expect(stateDescription.textContent?.trim()).toBe(`Viewport state: ${state}.`)
      expect(stateDescription.getAttribute('role')).toBe(role)
      expect(stateDescription.getAttribute('aria-live')).toBe(live)
      expect(viewport.getAttribute('aria-busy')).toBe(state === 'loading' ? 'true' : null)
    }
  })

  it('scopes disabled reason ids to each renderer', () => {
    const contribution = { root: {
      kind: 'action' as const, key: 'action', label: 'Unavailable', command: 'demo.run', disabled: true, disabledReason: 'Tree-specific reason',
    } }
    mount(() => <><HostUiRenderer commands={new CommandRegistry()} contribution={contribution} /><HostUiRenderer commands={new CommandRegistry()} contribution={contribution} /></>)
    const buttons = [...root.querySelectorAll('button')]
    const ids = buttons.map((button) => button.getAttribute('aria-describedby'))
    expect(ids[0]).toBeTruthy()
    expect(ids[1]).toBeTruthy()
    expect(ids[0]).not.toBe(ids[1])
    expect(document.getElementById(ids[0]!)?.textContent).toBe('Tree-specific reason')
    expect(document.getElementById(ids[1]!)?.textContent).toBe('Tree-specific reason')
  })

  it('keeps sibling action reason ids injective', () => {
    mount(() => <HostUiRenderer commands={new CommandRegistry()} contribution={{ root: {
      kind: 'group', key: 'root', direction: 'row', children: [
        { kind: 'action', key: 'a.b', label: 'Dot', command: 'demo.run', disabled: true, disabledReason: 'Dot reason' },
        { kind: 'action', key: 'a-b', label: 'Dash', command: 'demo.run', disabled: true, disabledReason: 'Dash reason' },
      ],
    } }} />)
    const buttons = [...root.querySelectorAll('button')]
    const ids = buttons.map((button) => button.getAttribute('aria-describedby'))
    expect(ids[0]).not.toBe(ids[1])
    expect(document.getElementById(ids[0]!)?.textContent).toBe('Dot reason')
    expect(document.getElementById(ids[1]!)?.textContent).toBe('Dash reason')
  })

  it('provides immutable connection data and replaces failures until recovery', async () => {
    const [mode, setMode] = createSignal<'throw' | 'malformed' | 'valid'>('throw')
    const owner = Symbol('provider')
    const snapshots = new Map<string | symbol, readonly Diagnostic[]>()
    let contextData: Json | undefined
    const provider: HostUiProviderV1 = (context) => {
      mode()
      contextData = context.data
      expect(Object.isFrozen(context)).toBe(true)
      expect(Object.isFrozen(context.data)).toBe(true)
      if (mode() === 'throw') throw new Error('injected')
      if (mode() === 'malformed') return { version: 1, root: { kind: 'script', key: 'bad' } }
      return { version: 1, root: { kind: 'text', key: 'ok', text: (context.data as { connectionLabel: string }).connectionLabel } }
    }
    mount(() => <HostUiProviderHost
      owner={owner}
      provider={provider}
      data={{ connectionId: 'local', connectionLabel: 'Render server' }}
      commands={new CommandRegistry()}
      replaceProblems={(snapshotOwner, diagnostics) => snapshots.set(snapshotOwner, diagnostics)}
    />)
    expect(root.querySelector('[role=alert]')).not.toBeNull()
    expect(snapshots.get(owner)).toEqual([expect.objectContaining({ code: 'host-ui.provider-failed', message: expect.stringContaining('injected') })])
    setMode('malformed')
    await Promise.resolve()
    expect(root.querySelector('[role=alert]')).not.toBeNull()
    expect(snapshots.get(owner)).toEqual([expect.objectContaining({ code: 'host-ui.invalid' })])
    setMode('valid')
    await Promise.resolve()
    expect(root.textContent).toContain('Render server')
    expect(snapshots.get(owner)).toEqual([])
    expect(() => { (contextData as { connectionLabel: string }).connectionLabel = 'mutated' }).toThrow()
  })

  it('provides the requested host surface and surface-specific failure copy', () => {
    let surface: string | undefined
    mount(() => <HostUiProviderHost
      owner="extension:widget-editor"
      provider={(context) => {
        surface = context.surface
        return { version: 1, root: { kind: 'invalid', key: 'bad' } }
      }}
      data={{ value: 3 }}
      surface="widget-editor"
      commands={new CommandRegistry()}
      replaceProblems={() => {}}
      errorText="Unable to render extension widget editor."
    />)
    expect(surface).toBe('widget-editor')
    expect(root.querySelector('[role=alert]')?.textContent).toBe('Unable to render extension widget editor.')
  })

  it('refuses the asset editor node outside the widget editor surface', () => {
    const snapshots: Diagnostic[][] = []
    mount(() => <HostUiProviderHost
      owner="extension:wrong-surface"
      provider={assetEditorContribution}
      data={null}
      surface="status"
      commands={new CommandRegistry()}
      replaceProblems={(_owner, diagnostics) => snapshots.push([...diagnostics])}
    />)
    expect(root.querySelector('[data-testid=asset-editor-shell]')).toBeNull()
    expect(root.querySelector('[role=alert]')).not.toBeNull()
    expect(snapshots.at(-1)).toEqual([expect.objectContaining({ code: 'host-ui.invalid', message: expect.stringContaining('widget-editor surface') })])
  })

  it('contains thrown values with hostile message accessors', () => {
    const snapshots: Diagnostic[][] = []
    const error = new Error('hidden')
    Object.defineProperty(error, 'message', { get: () => { throw new Error('message getter') } })
    mount(() => <HostUiProviderHost
      owner="extension:hostile"
      provider={() => { throw error }}
      data={null}
      commands={new CommandRegistry()}
      replaceProblems={(_owner, diagnostics) => snapshots.push(diagnostics)}
    />)
    expect(root.querySelector('[role=alert]')).not.toBeNull()
    expect(snapshots[0]?.[0]?.message).toContain('unknown provider error')
  })

  it('strips control characters from provider error diagnostics', () => {
    const snapshots: Diagnostic[][] = []
    mount(() => <HostUiProviderHost
      owner="extension:hostile"
      provider={() => { throw new Error('first\nsecond\u0000third\u007flast') }}
      data={null}
      commands={new CommandRegistry()}
      replaceProblems={(_owner, diagnostics) => snapshots.push(diagnostics)}
    />)
    expect(snapshots[0]?.[0]?.message).toContain('first?second?third?last')
    expect(snapshots[0]?.[0]?.message).not.toMatch(/[\u0000-\u001f\u007f]/)
  })
})

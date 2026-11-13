import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import type { Diagnostic, HostUiProviderV1, Json } from '@dinkster/core'
import { buttonView } from '@dinkster/widgets'
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

describe('host UI renderer', () => {
  it('invokes the BUTTON editor command with existing value and target, and refuses unavailable actions', () => {
    const commands = new CommandRegistry()
    const run = vi.fn()
    commands.register({ id: 'fixture.capture', label: 'Capture frame', run })
    const target = { kind: 'input', graphId: 'g0', nodeId: 'n0', inputId: 'capture' }
    const [options, setOptions] = createSignal<Json>({ display_name: 'Capture frame', command: 'fixture.capture' })
    mount(() => <HostUiProviderHost
      owner="button-test"
      provider={buttonView.editorUi!}
      data={{ value: null, target, widget: { type: 'BUTTON', options: options() } }}
      surface="widget-editor"
      commands={commands}
      replaceProblems={() => {}}
    />)
    const button = () => root.querySelector('button')!
    expect(button().textContent).toBe('Capture frame')
    expect(button().classList.contains('product-button')).toBe(true)
    button().click()
    expect(run).toHaveBeenCalledWith({ value: null, target })
    setOptions({ display_name: 'Capture frame', command: 'fixture.capture', disabled: true })
    expect(button().disabled).toBe(true)
    button().click()
    setOptions({ display_name: 'Capture frame', command: 'fixture.missing' })
    expect(button().disabled).toBe(true)
    button().click()
    setOptions({ display_name: 'Capture frame' })
    expect(button().disabled).toBe(true)
    button().click()
    expect(run).toHaveBeenCalledTimes(1)
  })

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

})

import {
  createHostUiProviderContextV1,
  createSignal,
  decodeHostUiContributionV1,
  diag,
  HOST_UI_MAX_ID_LENGTH,
  HOST_UI_MAX_VISIBLE_STRING_LENGTH,
  type ExtensionHostUiContributionV1,
  type ExtensionHostUiSlot,
  type HostUiNodeV1,
  type HostUiProviderV1,
  type HostUiSurfaceV1,
  type Json,
  type ReadonlySignal,
} from '@dinkster/core'
import { createMemo, createUniqueId, For, Match, onCleanup, Show, Switch } from 'solid-js'
import { AssetEditorShell } from './AssetEditorShell.js'
import type { CommandRegistry } from './settings.js'

const HOST_UI_CONTRIBUTION_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/

function ownContribution(
  id: string,
  slot: ExtensionHostUiSlot,
  provider: HostUiProviderV1,
  order?: number,
  title?: string,
): ExtensionHostUiContributionV1 {
  try {
    if (typeof id !== 'string' || id.length > HOST_UI_MAX_ID_LENGTH || !HOST_UI_CONTRIBUTION_ID.test(id)) throw new Error()
    if (slot !== 'status.trailing') throw new Error()
    if (typeof provider !== 'function') throw new Error()
    if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) throw new Error()
    if (title !== undefined && (typeof title !== 'string' || title.length === 0 || title.length > HOST_UI_MAX_VISIBLE_STRING_LENGTH)) throw new Error()
    return Object.freeze({ id, slot, ...(order === undefined ? {} : { order }), ...(title === undefined ? {} : { title }), provider: provider as HostUiProviderV1 })
  } catch {
    throw new Error('host UI contribution has invalid metadata')
  }
}

export class HostUiContributionRegistry {
  private readonly contributions = new Map<string, ExtensionHostUiContributionV1>()
  private readonly changedSignal = createSignal(0)
  private batchDepth = 0
  private batchDirty = false

  get changed(): ReadonlySignal<number> { return this.changedSignal }

  beginBatch(): (commit: boolean) => void {
    this.batchDepth += 1
    let finished = false
    return (commit) => {
      if (finished) return
      finished = true
      this.batchDepth -= 1
      if (this.batchDepth === 0) {
        const dirty = this.batchDirty
        this.batchDirty = false
        if (commit && dirty) this.changedSignal.update((value) => value + 1)
      }
    }
  }

  register(id: string, slot: ExtensionHostUiSlot, provider: HostUiProviderV1, order?: number, title?: string): () => void {
    const owned = ownContribution(id, slot, provider, order, title)
    if (this.contributions.has(owned.id)) throw new Error(`host UI contribution '${owned.id}' already registered`)
    this.contributions.set(owned.id, owned)
    this.notifyChange()
    return () => {
      if (this.contributions.delete(owned.id)) this.notifyChange()
    }
  }

  list(slot: ExtensionHostUiSlot): readonly ExtensionHostUiContributionV1[] {
    return [...this.contributions.values()]
      .filter((contribution) => contribution.slot === slot)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
  }

  invalidate(id: string): void {
    const contribution = this.contributions.get(id)
    if (!contribution) return
    this.contributions.set(id, Object.freeze({ ...contribution }))
    this.notifyChange()
  }

  private notifyChange(): void {
    if (this.batchDepth > 0) this.batchDirty = true
    else this.changedSignal.update((value) => value + 1)
  }
}

function HostUiNode(props: { readonly node: HostUiNodeV1; readonly commands: CommandRegistry; readonly idPrefix: string; readonly core?: boolean }) {
  const toneClass = () => `host-ui-tone-${props.node.kind === 'group' || props.node.kind === 'asset-editor' ? 'neutral' : (props.node.tone ?? 'neutral')}`
  return <Switch>
    <Match when={props.node.kind === 'group' ? props.node : undefined}>{(node) => (
      <span class={`host-ui-group host-ui-${node().direction}`} data-host-ui-key={node().key}>
        <For each={node().children}>{(child) => <HostUiNode node={child} commands={props.commands} idPrefix={props.idPrefix} core={props.core === true} />}</For>
      </span>
    )}</Match>
    <Match when={props.node.kind === 'text' ? props.node : undefined}>{(node) => (
      <span class={`host-ui-text ${toneClass()}`} data-host-ui-key={node().key}>{node().text}</span>
    )}</Match>
    <Match when={props.node.kind === 'status' ? props.node : undefined}>{(node) => (
      <span class={`host-ui-status ${toneClass()}${props.core && node().key === 'core.connection' ? ` conn-status ${node().text}` : ''}`} data-host-ui-key={node().key} role="status" aria-live={node().live}>{node().text}</span>
    )}</Match>
    <Match when={props.node.kind === 'action' ? props.node : undefined}>{(node) => {
      const command = () => props.commands.get(node().command)
      const disabled = () => node().disabled === true || command() === undefined || command()!.enabled?.() === false
      const reasonId = () => `${props.idPrefix}-reason-${node().key}`
      const invoke = () => {
        const current = command()
        if (node().disabled || !current || current.enabled?.() === false) return
        current.run(node().payload)
      }
      return <>
        <button
          class={`host-ui-action ${toneClass()}`}
          data-host-ui-key={node().key}
          disabled={disabled()}
          aria-describedby={disabled() && node().disabledReason ? reasonId() : undefined}
          title={disabled() ? node().disabledReason : undefined}
          onClick={invoke}
        >{node().label}</button>
        <Show when={disabled() && node().disabledReason}><span id={reasonId()} class="host-ui-disabled-reason">{node().disabledReason}</span></Show>
      </>
    }}</Match>
    <Match when={props.node.kind === 'asset-editor' ? props.node : undefined}>{(node) => (
      <AssetEditorShell presentation={node().presentation} commands={props.commands} idPrefix={props.idPrefix} hostUiKey={node().key} />
    )}</Match>
  </Switch>
}

export function HostUiRenderer(props: { readonly contribution: { readonly root: HostUiNodeV1 }; readonly commands: CommandRegistry; readonly core?: boolean }) {
  const idPrefix = `host-ui-${createUniqueId()}`
  return <HostUiNode node={props.contribution.root} commands={props.commands} idPrefix={idPrefix} core={props.core === true} />
}

export function HostUiProviderHost(props: {
  readonly owner: string | symbol
  readonly provider: HostUiProviderV1
  readonly data: Json
  readonly surface?: HostUiSurfaceV1
  readonly commands: CommandRegistry
  readonly replaceProblems: (owner: string | symbol, diagnostics: ReturnType<typeof diag>[]) => void
  readonly core?: boolean
  readonly errorText?: string
}) {
  onCleanup(() => props.replaceProblems(props.owner, []))
  const result = createMemo(() => {
    try {
      const context = createHostUiProviderContextV1(props.surface ?? 'status', props.data)
      const decoded = decodeHostUiContributionV1(props.provider(context))
      if (!decoded.contribution) {
        props.replaceProblems(props.owner, [...decoded.diagnostics])
        return undefined
      }
      if (decoded.contribution.root.kind === 'asset-editor' && context.surface !== 'widget-editor') {
        props.replaceProblems(props.owner, [diag('error', 'extension', 'host-ui.invalid', '$.root.kind: asset-editor requires the widget-editor surface')])
        return undefined
      }
      props.replaceProblems(props.owner, [])
      return decoded.contribution
    } catch (error) {
      let detail = 'unknown provider error'
      try {
        if (error instanceof Error && typeof error.message === 'string') detail = error.message.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 256)
      } catch {
        // Host error reporting must not trust properties on a thrown value.
      }
      props.replaceProblems(props.owner, [diag('error', 'extension', 'host-ui.provider-failed', `host UI provider failed: ${detail}`)])
      return undefined
    }
  })
  return <Show when={result()} fallback={<span class="host-ui-error" role="alert">{props.errorText ?? 'Unable to render extension status.'}</span>}>
    {(contribution) => <HostUiRenderer contribution={contribution()} commands={props.commands} core={props.core === true} />}
  </Show>
}

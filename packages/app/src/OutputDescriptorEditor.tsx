import { createMemo, createSignal, For, Index, onCleanup, Show } from 'solid-js'
import { outputDescriptorAssetDigest, parseOutputDescriptors, type Json, type JsonObject, type OutputDescriptorDocument, type OutputDescriptorsSpec } from '@dinkster/core'
import type { AppState, Tab } from './app-state.js'
import { useAppMessage } from './locale.js'
import { ProductSelect } from './ProductSelect.js'
import './output-descriptor-editor.css'

/** Draft edits commit through the ordinary value command as one undo step. */
export function OutputDescriptorEditor(props: {
  spec: OutputDescriptorsSpec
  initial: Json | undefined
  asset: unknown
  staleLinks: readonly { readonly linkId: string; readonly outputId: string }[]
  app: AppState
  tab: Tab
  isCurrent: () => boolean
  onDisconnect: (linkId: string) => void
  onCommit: (value: string) => void
  onClose: () => void
}) {
  const message = useAppMessage()
  const [text, setText] = createSignal(typeof props.initial === 'string' ? props.initial : '{"entries":[]}')
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [raw, setRaw] = createSignal(false)
  const [probeCurrent, setProbeCurrent] = createSignal<(() => boolean) | undefined>()
  const profile = () => props.spec.probe !== undefined
  const readOnly = () => profile() || unsafeNumbers()
  let live = true
  let abort: AbortController | undefined
  onCleanup(() => { live = false; abort?.abort() })
  const parsed = createMemo(() => parseOutputDescriptors(props.spec, text(), props.asset))
  const document = createMemo((): OutputDescriptorDocument | undefined => {
    // A stale profile remains visible and repairable, but cannot be applied.
    const { probe: _probe, ...editable } = props.spec
    const result = parseOutputDescriptors(editable, text())
    return result.ok ? result.document : undefined
  })
  const unsafeNumbers = createMemo(() => {
    const pending: unknown[] = [document()]
    while (pending.length > 0) {
      const value = pending.pop()
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) return true
      if (value !== null && typeof value === 'object') for (const child of Object.values(value)) pending.push(child)
    }
    return false
  })
  const diagnostics = createMemo(() => {
    const value = document()?.['diagnostics']
    return profile() && Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  })
  const write = (next: OutputDescriptorDocument): void => {
    if (readOnly()) return
    setText(JSON.stringify(next))
    setError(undefined)
  }
  const update = (index: number, fields: JsonObject): void => {
    const doc = document()
    if (!doc) return
    write({ ...doc, entries: doc.entries.map((entry, i) => i === index ? { ...entry, ...fields } : entry) })
  }
  const move = (index: number, offset: number): void => {
    const doc = document()
    if (!doc) return
    const entries = [...doc.entries]
    const [entry] = entries.splice(index, 1)
    entries.splice(index + offset, 0, entry!)
    write({ ...doc, entries })
  }
  const add = (): void => {
    const doc = document()
    if (!doc) return
    const choice = props.spec.choices.find((choice) => !props.spec.fixedIds || !doc.entries.some((entry) => entry.id === choice.id))
    if (!choice) return
    let ordinal = 0
    while (doc.entries.some((entry) => entry.name === message('outputDescriptors.defaultName', { number: ordinal + 1 }))) ordinal++
    const id = props.spec.fixedIds ? choice.id : `m${crypto.randomUUID().replaceAll('-', '')}`
    write({ ...doc, entries: [...doc.entries, { id, name: message('outputDescriptors.defaultName', { number: ordinal + 1 }), type: choice.id }] })
  }
  const probe = async (): Promise<void> => {
    const spec = props.spec.probe
    const digest = outputDescriptorAssetDigest(props.asset)
    if (!spec || !digest) { setError(message('outputDescriptors.error.chooseAsset')); return }
    abort?.abort()
    abort = new AbortController()
    const request = abort
    const backend = props.app.backendForTab(props.tab)
    const generation = backend.scopedClient.remoteChoiceAuthority()
    const current = (): boolean => live && props.isCurrent() && abort === request &&
      props.app.backendForTab(props.tab) === backend && backend.scopedClient.remoteChoiceAuthority() === generation
    setBusy(true)
    setError(undefined)
    try {
      const query = new URLSearchParams({ digest, revision: spec.revision })
      const response = await fetch(`${backend.baseUrl.replace(/\/$/, '')}/api/output-profiles/${spec.kind}?${query}`, { signal: request.signal })
      if (!response.ok) throw new Error(message('outputDescriptors.error.probeFailed', { status: response.status }))
      const next = JSON.stringify(await response.json())
      if (!current()) return
      const result = parseOutputDescriptors(props.spec, next, props.asset)
      if (!result.ok) throw new Error(result.error)
      setText(next)
      setProbeCurrent(() => current)
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (live && abort === request) setBusy(false)
    }
  }
  const apply = (): void => {
    if (!props.isCurrent() || probeCurrent()?.() === false) { setError(message('outputDescriptors.error.staleEditor')); return }
    const result = parsed()
    if (!result.ok) { setError(result.error); return }
    props.onCommit(text())
  }
  return <section class="output-descriptor-editor" data-testid="output-descriptor-editor" aria-label={message('outputDescriptors.title')}>
    <h3>{message('outputDescriptors.title')}</h3>
    <p>{message(profile() ? 'outputDescriptors.description.profile' : 'outputDescriptors.description.editable')}</p>
    <Show when={unsafeNumbers() && !profile()}><p role="status" class="output-descriptor-notice">{message('outputDescriptors.unsafeNumbers')}</p></Show>
    <Show when={props.spec.probe}>
      <button type="button" data-testid="output-profile-probe" disabled={busy()} onClick={() => void probe()}>{message(busy() ? 'outputDescriptors.action.probing' : 'outputDescriptors.action.probe')}</button>
    </Show>
    <Show when={!parsed().ok}><p role="status" class="output-descriptor-notice">{(() => { const result = parsed(); return result.ok ? '' : result.error })()}</p></Show>
    <For each={diagnostics()}>{(message) => <p role="status" class="output-descriptor-notice">{message}</p>}</For>
    <Show when={document()} fallback={<p>{message(profile() ? 'outputDescriptors.empty.profile' : 'outputDescriptors.empty.editable')}</p>}>
      <div class="output-descriptor-entries">
        <Index each={document()?.entries ?? []}>{(entry, index) => <fieldset class="output-descriptor-entry">
          <legend>{message('outputDescriptors.entry.legend', { number: index + 1 })}</legend>
          <label>{message('outputDescriptors.field.name')}<input aria-label={message('outputDescriptors.field.nameLabel', { number: index + 1 })} value={entry().name} readOnly={readOnly()} onChange={(event) => update(index, { name: event.currentTarget.value })} /></label>
          <label>{message('outputDescriptors.field.id')}<input aria-label={message('outputDescriptors.field.idLabel', { number: index + 1 })} value={entry().id} readOnly={readOnly()} disabled={props.spec.fixedIds} onChange={(event) => update(index, { id: event.currentTarget.value })} /></label>
          <label>{message('outputDescriptors.field.type')}<ProductSelect
            ariaLabel={message('outputDescriptors.field.typeLabel', { number: index + 1 })}
            disabled={readOnly()}
            selectedId={entry().type}
            options={props.spec.choices.map((choice) => ({ id: choice.id, value: choice.id, label: `${choice.displayName ?? choice.id} (${choice.type.name})` }))}
            onSelect={({ value }) => update(index, { type: value, ...(props.spec.fixedIds ? { id: value } : {}) })}
          /></label>
          <div class="output-descriptor-actions">
            <button type="button" aria-label={message('outputDescriptors.action.moveUpLabel', { number: index + 1 })} disabled={readOnly() || index === 0} onClick={() => move(index, -1)}>{message('outputDescriptors.action.up')}</button>
            <button type="button" aria-label={message('outputDescriptors.action.moveDownLabel', { number: index + 1 })} disabled={readOnly() || index === (document()?.entries.length ?? 0) - 1} onClick={() => move(index, 1)}>{message('outputDescriptors.action.down')}</button>
            <button type="button" aria-label={message('outputDescriptors.action.removeLabel', { number: index + 1 })} disabled={readOnly() || (document()?.entries.length ?? 0) <= props.spec.minEntries} onClick={() => { const doc = document()!; write({ ...doc, entries: doc.entries.filter((_, i) => i !== index) }) }}>{message('outputDescriptors.action.remove')}</button>
          </div>
        </fieldset>}</Index>
      </div>
      <button type="button" onClick={add} disabled={readOnly() || busy() || (document()?.entries.length ?? 0) >= props.spec.maxEntries}>{message('outputDescriptors.action.add')}</button>
    </Show>
    <Show when={props.staleLinks.length > 0}>
      <section class="output-descriptor-stale-links" data-testid="output-descriptor-stale-links" aria-label={message('outputDescriptors.stale.title')}>
        <h4>{message('outputDescriptors.stale.title')}</h4>
        <p>{message('outputDescriptors.stale.description')}</p>
        <ul>
          <For each={props.staleLinks}>{(link) => <li>
            <code>{link.outputId}</code>
            <button
              type="button"
              aria-label={message('outputDescriptors.stale.disconnectLabel', { output: link.outputId })}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => props.onDisconnect(link.linkId)}
            >{message('outputDescriptors.stale.disconnect')}</button>
          </li>}</For>
        </ul>
      </section>
    </Show>
    <button type="button" aria-expanded={raw()} onClick={() => setRaw(!raw())}>{message('outputDescriptors.action.storedJson')}</button>
    <Show when={raw()}>
      <label>{message('outputDescriptors.raw.label')}<textarea aria-label={message('outputDescriptors.raw.label')} rows={8} value={text()} readOnly={profile()} onInput={(event) => { if (!profile()) setText(event.currentTarget.value) }} /></label>
      <p>{message(profile() ? 'outputDescriptors.raw.profile' : 'outputDescriptors.raw.editable')}</p>
    </Show>
    <Show when={error()}><p role="alert" class="output-descriptor-notice">{error()}</p></Show>
    <footer class="output-descriptor-actions">
      <button type="button" onClick={props.onClose}>{message('outputDescriptors.action.cancel')}</button>
      <button type="button" class="primary" data-testid="output-descriptors-apply" disabled={busy() || !parsed().ok} onClick={apply}>{message('outputDescriptors.action.apply')}</button>
    </footer>
  </section>
}

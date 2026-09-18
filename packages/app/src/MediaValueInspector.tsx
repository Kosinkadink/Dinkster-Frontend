import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import type { DinksterValuesClient, ValuePeekResult, ValueQuery } from '@dinkster/client'
import type { ValueDiagnostic } from '@dinkster/core'
import { useAppMessage } from './locale.js'
import { mediaMetadataOf, type MediaMetadataField } from './media-metadata.js'
import './media-value-inspector.css'

export function MediaDiagnostics(props: { readonly diagnostics: readonly ValueDiagnostic[] }) {
  const message = useAppMessage()
  return <Show when={props.diagnostics.length > 0}>
    <section class="media-diagnostics" aria-label={message('mediaInspector.diagnostics.title')} role="status">
      <h3>{message('mediaInspector.diagnostics.title')}</h3>
      <For each={props.diagnostics}>{(diagnostic) => <dl class="output-facts">
        <div><dt>{message('mediaInspector.diagnostics.diagnostic')}</dt><dd>{diagnostic.code}</dd></div>
        <div><dt>{message('mediaInspector.fact.runtimeNode')}</dt><dd>{diagnostic.nodeId}</dd></div>
        {diagnostic.code === 'alpha_dropped' ? <>
          <div><dt>{message('mediaInspector.fact.outputId')}</dt><dd>{diagnostic.outputId}</dd></div>
          <div><dt>{message('inputId' in diagnostic ? 'mediaInspector.diagnostics.coercedInput' : 'mediaInspector.diagnostics.alphaInputs')}</dt><dd>{'inputId' in diagnostic ? diagnostic.inputId : diagnostic.inputIds.join(', ')}</dd></div>
        </> : <>
          <div><dt>{message('mediaInspector.diagnostics.inputId')}</dt><dd>{diagnostic.inputId}</dd></div>
          <div><dt>{message('mediaInspector.diagnostics.expectedPolarity')}</dt><dd>{diagnostic.expected}</dd></div>
          <div><dt>{message('mediaInspector.diagnostics.actualPolarity')}</dt><dd>{diagnostic.actual}</dd></div>
        </>}
      </dl>}</For>
    </section>
  </Show>
}

export function MediaValueInspector(props: {
  readonly values: Pick<DinksterValuesClient, 'peek'> | undefined
  readonly query: ValueQuery
}) {
  const message = useAppMessage()
  const [open, setOpen] = createSignal(false)
  const [result, setResult] = createSignal<ValuePeekResult>()
  createEffect(() => {
    const query = props.query
    const values = props.values
    if (!open()) return
    let current = true
    const controller = new AbortController()
    setResult(undefined)
    onCleanup(() => { current = false; controller.abort() })
    if (values === undefined) return
    void values.peek(query, { signal: controller.signal }).then((value) => { if (current) setResult(value) })
  })
  const descriptor = () => {
    const value = result()
    return value?.available ? value.descriptor : undefined
  }
  const metadata = () => {
    const value = descriptor()
    return value === undefined ? undefined : mediaMetadataOf(value.typeId, value.meta)
  }
  const unavailable = () => {
    if (props.values === undefined) return message('mediaInspector.status.ownerUnavailable')
    const value = result()
    return value === undefined ? message('mediaInspector.status.loading') : !value.available ? `${value.reason}: ${value.error}` : undefined
  }
  const metadataValue = (field: MediaMetadataField) => {
    if (field.value === undefined) return message('mediaInspector.metadata.notReported')
    if (typeof field.value === 'boolean') return message(field.value ? 'mediaInspector.metadata.yes' : 'mediaInspector.metadata.no')
    return field.value
  }
  return (
    <details class="media-value-inspector" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{message('mediaInspector.summary.inspect', { nodeId: props.query.nodeId, outputId: props.query.outputId })}</summary>
      <Show when={open()}>
        <Show when={unavailable()}>{(message) => <p role="status">{message()}</p>}</Show>
        <Show when={descriptor()}>{(value) => (
          <dl class="output-facts">
            <div><dt>{message('mediaInspector.fact.runtimeNode')}</dt><dd>{props.query.nodeId}</dd></div>
            <div><dt>{message('mediaInspector.fact.outputId')}</dt><dd>{props.query.outputId}</dd></div>
            <div><dt>{message('mediaInspector.fact.type')}</dt><dd>{value().typeId}</dd></div>
            <div><dt>{message('mediaInspector.fact.fingerprint')}</dt><dd>{value().fingerprint}</dd></div>
            <For each={metadata()?.fields}>{(field) => <div><dt>{message(`mediaInspector.metadata.${field.id}`)}</dt><dd>{metadataValue(field)}</dd></div>}</For>
            <Show when={!metadata()}><div><dt>{message('mediaInspector.fact.mediaMetadata')}</dt><dd>{message('mediaInspector.status.notReportedForKind')}</dd></div></Show>
          </dl>
        )}</Show>
      </Show>
    </details>
  )
}

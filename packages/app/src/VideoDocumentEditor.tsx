import { For, Show, createMemo, createSignal } from 'solid-js'
import { Check, X } from 'lucide-solid'
import { Icon } from './Icon.js'
import { ProductCheckbox } from './ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice } from './ProductForm.js'
import { useAppMessage } from './locale.js'

type Command =
  | 'make'
  | 'add_clip'
  | 'add_track'
  | 'set_effect'
  | 'transition'
  | 'retime'
  | 'mix_audio'
  | 'split'
  | 'move'
  | 'trim'
  | 'ripple'
  | 'roll'
  | 'bind_source'
  | 'import_otio'

type FieldKind = 'number' | 'integer' | 'text' | 'boolean' | 'json' | 'track-kind'

interface Field {
  readonly key: string
  readonly kind: FieldKind
  readonly messageKey?: string
  readonly required?: true
}

const commonSelection: readonly Field[] = [
  { key: 'track', kind: 'integer' },
  { key: 'clip', kind: 'integer' },
]

const fields: Readonly<Record<Exclude<Command, 'import_otio'>, readonly Field[]>> = {
  make: [
    { key: 'width', kind: 'integer' },
    { key: 'height', kind: 'integer' },
    { key: 'rate', kind: 'number' },
    { key: 'name', kind: 'text' },
    { key: 'clips', kind: 'json' },
  ],
  add_track: [
    { key: 'kind', kind: 'track-kind' },
    { key: 'name', kind: 'text' },
    { key: 'blend', kind: 'text' },
    { key: 'opacity', kind: 'number' },
  ],
  add_clip: [...commonSelection.slice(0, 1), { key: 'item', kind: 'json', required: true }, { key: 'index', kind: 'integer', messageKey: 'insertion_index' }],
  set_effect: [...commonSelection, { key: 'index', kind: 'integer', messageKey: 'effect_index' }, { key: 'effect', kind: 'json' }, { key: 'remove', kind: 'boolean' }],
  transition: [...commonSelection, { key: 'in_offset', kind: 'number' }, { key: 'out_offset', kind: 'number' }],
  retime: [...commonSelection, { key: 'scalar', kind: 'number', required: true }],
  mix_audio: [...commonSelection.slice(0, 1), { key: 'audio_mix', kind: 'json', required: true }],
  split: [...commonSelection, { key: 'position', kind: 'number', required: true }],
  move: [...commonSelection, { key: 'to_track', kind: 'integer' }, { key: 'index', kind: 'integer', messageKey: 'final_index', required: true }],
  trim: [...commonSelection, { key: 'start_time', kind: 'number' }, { key: 'duration', kind: 'number' }, { key: 'strict_duration', kind: 'boolean' }, { key: 'video_edit', kind: 'json' }],
  ripple: [...commonSelection, { key: 'start_time', kind: 'number' }, { key: 'duration', kind: 'number' }, { key: 'strict_duration', kind: 'boolean' }],
  roll: [...commonSelection, { key: 'delta', kind: 'number', required: true }],
  bind_source: [
    { key: 'source', kind: 'text', required: true },
    { key: 'reference', kind: 'json' },
    { key: 'track', kind: 'integer' },
    { key: 'clip', kind: 'integer' },
  ],
}

const record = (value: unknown): { [key: string]: unknown } | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as { [key: string]: unknown } : undefined

const fieldText = (field: Field, value: Record<string, unknown>): string => {
  const current = value[field.key]
  if (field.kind === 'json') return current === undefined ? '' : JSON.stringify(current, null, 2)
  return typeof current === 'string' || typeof current === 'number' ? String(current) : ''
}

export interface VideoDocumentEditorProps {
  readonly command: string
  readonly value: string
  readonly videoInputDriven?: boolean
  readonly documentSourceStatus?: string
  readonly onCommit: (value: string) => void
  readonly onCancel: () => void
}

export function isVideoDocumentEditorCommand(command: string): command is Command {
  return command === 'import_otio' || Object.hasOwn(fields, command)
}

export function VideoDocumentEditor(props: VideoDocumentEditorProps) {
  const message = useAppMessage()
  const command = createMemo(() => isVideoDocumentEditorCommand(props.command) ? props.command : undefined)
  const commandFields = createMemo(() => {
    const value = command()
    return value === undefined || value === 'import_otio' ? [] : fields[value]
  })
  const parsed = (() => {
    if (props.command === 'import_otio') return undefined
    if (props.value.trim() === '') return {}
    try { return record(JSON.parse(props.value)) } catch { return undefined }
  })()
  const initialParams = parsed ?? {}
  const [params, setParams] = createSignal<Record<string, unknown>>(initialParams)
  const [drafts, setDrafts] = createSignal<Record<string, string>>(Object.fromEntries(
    commandFields().map((field) => [field.key, fieldText(field, initialParams)]),
  ))
  const [raw, setRaw] = createSignal(props.command === 'import_otio' || parsed === undefined
    ? props.value : JSON.stringify(parsed, null, 2))
  const [error, setError] = createSignal<string | undefined>(parsed === undefined && props.command !== 'import_otio'
    ? message('videoDocument.error.object') : undefined)
  const [errorField, setErrorField] = createSignal<string | undefined>(error() === undefined ? undefined : '$raw')
  const setObject = (next: Record<string, unknown>, field: string) => {
    setParams(next)
    setRaw(JSON.stringify(next, null, 2))
    if (errorField() === field) {
      setError(undefined)
      setErrorField(undefined)
    }
  }
  const setField = (key: string, value: unknown, present = true) => {
    const next = { ...params() }
    if (present) next[key] = value
    else delete next[key]
    setObject(next, key)
  }
  const setFieldError = (field: Field, value: string) => {
    setError(value)
    setErrorField(field.key)
  }
  const commitScalar = (field: Field, rawValue: string) => {
    setDrafts((current) => ({ ...current, [field.key]: rawValue }))
    if (rawValue.trim() === '') {
      if (field.required) setFieldError(field, message('videoDocument.error.required', { field: message(`videoDocument.field.${field.messageKey ?? field.key}`) }))
      else setField(field.key, undefined, false)
      return
    }
    if (field.kind === 'text' || field.kind === 'track-kind') {
      setField(field.key, rawValue)
      return
    }
    const value = Number(rawValue)
    if (!Number.isFinite(value) || (field.kind === 'integer' && !Number.isSafeInteger(value))) {
      setFieldError(field, message(field.kind === 'integer' ? 'videoDocument.error.integer' : 'videoDocument.error.number', {
        field: message(`videoDocument.field.${field.messageKey ?? field.key}`),
      }))
      return
    }
    setField(field.key, value)
  }
  const commitJson = (field: Field, rawValue: string) => {
    setDrafts((current) => ({ ...current, [field.key]: rawValue }))
    if (rawValue.trim() === '') {
      if (field.required) setFieldError(field, message('videoDocument.error.required', { field: message(`videoDocument.field.${field.messageKey ?? field.key}`) }))
      else setField(field.key, undefined, false)
      return
    }
    try { setField(field.key, JSON.parse(rawValue)) } catch {
      setFieldError(field, message('videoDocument.error.json', { field: message(`videoDocument.field.${field.messageKey ?? field.key}`) }))
    }
  }
  const commitRaw = (value: string) => {
    setRaw(value)
    try {
      const next = record(JSON.parse(value))
      if (next === undefined) throw new Error()
      setParams(next)
      setDrafts(Object.fromEntries(commandFields().map((field) => [field.key, fieldText(field, next)])))
      setError(undefined)
      setErrorField(undefined)
    } catch {
      setError(message('videoDocument.error.object'))
      setErrorField('$raw')
    }
  }
  const apply = () => {
    if (props.command === 'import_otio') {
      props.onCommit(raw())
      return
    }
    if (error() !== undefined) return
    props.onCommit(JSON.stringify(params()))
  }

  return (
    <div class="video-document-editor" data-testid="video-document-editor" data-command={props.command}>
      <Show when={command()} fallback={<ProductNotice tone="error">{message('videoDocument.error.unsupported')}</ProductNotice>}>
        <p class="video-document-command-summary">
          {message(`videoDocument.command.${props.command}`)}
        </p>
        <Show when={props.documentSourceStatus}>
          {(status) => <ProductNotice tone="status" testId="video-document-source-status">{status()}</ProductNotice>}
        </Show>
        <Show when={props.command === 'bind_source' && props.videoInputDriven}>
          <ProductNotice tone="status" testId="video-document-video-driven">
            {message('videoDocument.bindSource.videoDriven')}
          </ProductNotice>
        </Show>
        <Show when={error()}>{(value) => <ProductNotice tone="error" testId="video-document-error">{value()}</ProductNotice>}</Show>
        <Show when={props.command === 'import_otio'} fallback={
          <>
            <div class="video-document-fields">
              <For each={commandFields()}>{(field) => {
                const id = `video-document-${field.key.replaceAll('_', '-')}`
                return <ProductField
                  controlId={id}
                  label={message(`videoDocument.field.${field.messageKey ?? field.key}`)}
                  layout={field.kind === 'json' ? 'stack' : 'compact'}
                >
                  <Show when={field.kind === 'boolean'} fallback={
                    <Show when={field.kind === 'track-kind'} fallback={
                      <Show when={field.kind === 'json'} fallback={
                        <input
                          id={id}
                          data-testid={id}
                          type={field.kind === 'number' || field.kind === 'integer' ? 'number' : 'text'}
                          step={field.kind === 'integer' ? '1' : field.kind === 'number' ? 'any' : undefined}
                          value={drafts()[field.key] ?? ''}
                          onChange={(event) => commitScalar(field, event.currentTarget.value)}
                        />
                      }>
                        <textarea
                          id={id}
                          data-testid={id}
                          value={drafts()[field.key] ?? ''}
                          onChange={(event) => commitJson(field, event.currentTarget.value)}
                        />
                      </Show>
                    }>
                      <select id={id} data-testid={id} value={drafts()[field.key] ?? ''} onChange={(event) => commitScalar(field, event.currentTarget.value)}>
                        <option value="">{message('videoDocument.value.default')}</option>
                        <option value="Video">{message('videoDocument.value.video')}</option>
                        <option value="Audio">{message('videoDocument.value.audio')}</option>
                      </select>
                    </Show>
                  }>
                    <ProductCheckbox
                      id={id}
                      testId={id}
                      ariaLabelledBy={`${id}-label`}
                      checked={params()[field.key] === true}
                      onChange={(checked) => setField(field.key, checked)}
                    />
                  </Show>
                </ProductField>
              }}</For>
            </div>
            <details class="video-document-advanced">
              <summary>{message('videoDocument.advanced')}</summary>
              <ProductField controlId="video-document-raw" label={message('videoDocument.raw')} layout="stack">
                <textarea
                  id="video-document-raw"
                  data-testid="video-document-raw"
                  value={raw()}
                  onInput={(event) => commitRaw(event.currentTarget.value)}
                />
              </ProductField>
            </details>
          </>
        }>
          <ProductField controlId="video-document-otio" label={message('videoDocument.field.otio')} layout="stack">
            <textarea
              id="video-document-otio"
              data-testid="video-document-otio"
              value={raw()}
              onInput={(event) => setRaw(event.currentTarget.value)}
            />
          </ProductField>
        </Show>
        <ProductActionFooter>
          <button type="button" data-testid="video-document-cancel" onClick={props.onCancel}>
            <Icon icon={X} /> {message('common.cancel')}
          </button>
          <button type="button" class="primary" data-testid="video-document-apply" disabled={error() !== undefined} onClick={apply}>
            <Icon icon={Check} /> {message('common.apply')}
          </button>
        </ProductActionFooter>
      </Show>
    </div>
  )
}

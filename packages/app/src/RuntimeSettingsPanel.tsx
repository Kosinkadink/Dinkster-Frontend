import { createEffect, createSignal, createUniqueId, For, Index, onCleanup, onMount, Show } from 'solid-js'
import { LockKeyhole } from 'lucide-solid'
import { ProductIcon, ProductSelect as SharedProductSelect, ProductSettingsSection, ProductSettingRow, ProductSwitch, ProductTextButton } from '@dinkster/ui'
import {
  RuntimeSettingsError,
  type DinksterConnection,
  type RuntimeSettingSection,
  type RuntimeSettings,
} from '@dinkster/client'
import { ProductButton, ProductCheckbox, ProductTextInput } from './ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from './ProductForm.js'
import { ProductNumberInput } from './ProductNumberInput.js'
import { ProductSelect } from './ProductSelect.js'
import { useAppMessage } from './locale.js'
import { failureMessage, failureReason } from './request-failure.js'

type SettingsConnection = Pick<DinksterConnection, 'fetchRuntimeSettings' | 'updateRuntimeSetting'>

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const sizeValue = (value: string): number | string => /^\d+$/.test(value.trim()) ? Number(value) : value.trim()

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  'memory-budgets': 'runtimeSettings.category.memoryBudgets',
  'memory-headroom': 'runtimeSettings.category.memoryHeadroom',
  'aimdo-policy': 'runtimeSettings.category.aimdoPolicy',
  'dtype-policy': 'runtimeSettings.category.dtypePolicy',
  'fp8-matmul': 'runtimeSettings.category.fp8Matmul',
  'worker-comfy-args': 'runtimeSettings.category.workerComfyArgs',
  jobs: 'runtimeSettings.category.jobs',
  logging: 'runtimeSettings.category.logging',
}

const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

interface LoggingRow { readonly id: number; readonly name: string; readonly level: string }
let loggingRowId = 0
interface ComfyArgRow { readonly id: number; readonly value: string }
let comfyArgRowId = 0

function EngineSettingRows(props: {
  readonly category: string
  readonly section: RuntimeSettingSection
  readonly editable: boolean
  readonly connection: SettingsConnection
  readonly onSaveStart: () => void
  readonly onSaved: (section: RuntimeSettingSection) => void
  readonly onCopyId: (id: string) => void
}) {
  const message = useAppMessage()
  const [value, setValue] = createSignal<unknown>(props.section.value)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<{ id: string; text: string }>()
  const [editing, setEditing] = createSignal(false)
  const [argumentsDraft, setArgumentsDraft] = createSignal<readonly ComfyArgRow[]>([])
  const [loggersDraft, setLoggersDraft] = createSignal<readonly LoggingRow[]>([])
  let live = true
  onCleanup(() => { live = false })
  createEffect(() => setValue(() => props.section.value))
  const save = async (id: string, next: unknown): Promise<boolean> => {
    if (saving() || !props.editable) return false
    setError(undefined)
    if (sameValue(next, props.section.value)) return true
    props.onSaveStart()
    setSaving(true)
    setValue(() => next)
    try {
      const updated = await props.connection.updateRuntimeSetting(props.category, next)
      if (!live) return false
      props.onSaved(updated)
      return true
    } catch (cause) {
      if (live) {
        setValue(() => props.section.value)
        setError({ id, text: failureReason(cause) ?? message('request.settingsSaveFailed') })
      }
      return false
    } finally {
      if (live) setSaving(false)
    }
  }
  const beginList = (): void => {
    setArgumentsDraft((Array.isArray(value()) ? value() as unknown[] : []).filter((item): item is string => typeof item === 'string').map((item) => ({ id: ++comfyArgRowId, value: item })))
    setLoggersDraft(Object.entries(asRecord(asRecord(value())['overrides'])).map(([name, level]) => ({ id: ++loggingRowId, name, level: String(level) })))
    setEditing(true)
  }
  const definitions = props.category === 'dtype-policy'
    ? [
        { part: 'diffusion', label: 'runtimeSettings.page.diffusion', kind: 'precision' },
        { part: 'textEncoder', label: 'runtimeSettings.page.textEncoder', kind: 'precision' },
        { part: 'vae', label: 'runtimeSettings.page.vae', kind: 'precision' },
      ]
    : props.category === 'logging'
      ? [{ part: 'level', label: 'runtimeSettings.logging.defaultLogLevel', kind: 'level' }, { part: 'overrides', label: 'runtimeSettings.page.loggerOverrides', kind: 'list' }]
      : [{ part: '', label: props.category === 'fp8-matmul' ? 'runtimeSettings.fp8.native' : props.category === 'jobs' ? 'runtimeSettings.jobs.maximumRunning' : props.category === 'worker-comfy-args' ? 'runtimeSettings.category.workerComfyArgs' : CATEGORY_LABELS[props.category] ?? props.category,
          kind: props.category === 'fp8-matmul' ? 'switch' : props.category === 'jobs' ? 'number' : props.category === 'worker-comfy-args' ? 'list' : 'locked' }]
  const prefix = createUniqueId()
  return <For each={definitions}>{(definition) => {
    const id = `${props.category}${definition.part ? `.${definition.part}` : ''}`
    const controlId = `${prefix}-${id}`
    const current = (): unknown => props.category === 'jobs' ? asRecord(value())['maxRunningJobs'] : definition.part ? asRecord(value())[definition.part] : value()
    const next = (item: unknown): unknown => props.category === 'jobs' ? { ...asRecord(value()), maxRunningJobs: item } : definition.part ? { ...asRecord(value()), [definition.part]: item } : item
    const count = (): number => Array.isArray(current()) ? (current() as unknown[]).length : Object.keys(asRecord(current())).length
    const shown = (): string => definition.kind === 'list' ? count() === 0 ? message('settingsPage.noneShortcut') : message(count() === 1 ? 'runtimeSettings.page.oneItem' : 'runtimeSettings.page.itemCount', { count: count() })
      : typeof current() === 'boolean' ? message(current() ? 'runtimeSettings.page.on' : 'runtimeSettings.page.off') : typeof current() === 'string' || typeof current() === 'number' ? String(current()) : message('runtimeSettings.page.unavailable')
    const description = (): string => props.section.source === 'runtime' && (!props.section.persistence.available || !props.section.persistence.persisted) ? message('runtimeSettings.page.memoryOnly') : ''
    const finishList = async (): Promise<void> => {
      const submitted = props.category === 'worker-comfy-args'
        ? argumentsDraft().map((row) => row.value).filter((item) => item.trim() !== '')
        : { ...asRecord(value()), overrides: Object.fromEntries(loggersDraft().map((row) => [row.name, row.level])) }
      if (await save(id, submitted)) setEditing(false)
    }
    return <ProductSettingRow id={id} controlId={controlId} label={message(definition.label)} description={description() || undefined}
      error={error()?.id === id ? error()?.text : undefined} fullWidth={definition.kind === 'list' && editing()}
      modified={false} resetLabel="" menuLabel={message('settingsPage.actions', { name: message(definition.label) })} copyIdLabel={message('runtimeSettings.page.copyId')}
      onReset={() => {}} onCopyId={() => props.onCopyId(id)} menuItems={[{ label: message('runtimeSettings.page.copyId'), description: id, onSelect: () => props.onCopyId(id) }]}>
      <Show when={props.editable && definition.kind !== 'locked'} fallback={<output id={controlId} class="dinkster-setting-locked">{shown()}</output>}>
        <Show when={definition.kind === 'precision' || definition.kind === 'level'}><SharedProductSelect id={controlId} aria-label={message(definition.label)} aria-describedby={error()?.id === id ? `${controlId}-error` : undefined} disabled={saving()} value={String(current())}
          options={(definition.kind === 'precision' ? ['auto', 'float16', 'bfloat16', 'float32'] : ['debug', 'info', 'warning', 'error', 'critical']).map((item) => ({ value: item, label: definition.kind === 'precision' ? ({ auto: message('runtimeSettings.dtype.auto'), float16: 'FP16', bfloat16: 'BF16', float32: 'FP32' }[item] ?? item) : item }))}
          onChange={(value) => { void save(id, next(value)) }} /></Show>
        <Show when={definition.kind === 'switch'}><ProductSwitch id={controlId} label={message(definition.label)} checked={current() === true} disabled={saving()} onChange={(item) => { void save(id, next(item)) }} /></Show>
        <Show when={definition.kind === 'number'}><ProductNumberInput id={controlId} ariaLabel={message(definition.label)} ariaDescribedBy={error()?.id === id ? `${controlId}-error` : undefined} value={Number(current())} min={1} integer disabled={saving()} onCommit={(raw) => { void save(id, next(Number(raw))) }} /></Show>
        <Show when={definition.kind === 'list'}><Show when={editing()} fallback={<><span class="dinkster-setting-none">{shown()}</span><ProductTextButton id={controlId} label={message('runtimeSettings.page.edit')} aria-label={message('runtimeSettings.page.editList', { name: message(definition.label) })} disabled={saving()} onClick={beginList} /></>}>
          <div class="dinkster-stack">
          <Show when={props.category === 'worker-comfy-args'} fallback={<>
            <Index each={loggersDraft()}>{(row) => <div class="dinkster-actions">
              <ProductTextInput aria-label={message('runtimeSettings.logging.loggerName')} value={row().name} disabled={saving()} onInput={(event) => setLoggersDraft((rows) => rows.map((item) => item.id === row().id ? { ...item, name: event.currentTarget.value } : item))} />
              <ProductTextInput aria-label={message('runtimeSettings.logging.logLevel', { logger: row().name || message('runtimeSettings.logging.newLogger') })} value={row().level} disabled={saving()} onInput={(event) => setLoggersDraft((rows) => rows.map((item) => item.id === row().id ? { ...item, level: event.currentTarget.value } : item))} />
              <ProductTextButton label={message('runtimeSettings.action.remove')} disabled={saving()} onClick={() => setLoggersDraft((rows) => rows.filter((item) => item.id !== row().id))} />
            </div>}</Index>
            <ProductTextButton label={message('runtimeSettings.logging.addOverride')} disabled={saving()} onClick={() => setLoggersDraft((rows) => [...rows, { id: ++loggingRowId, name: '', level: 'info' }])} />
          </>}>
            <Index each={argumentsDraft()}>{(row, index) => <div class="dinkster-actions"><ProductTextInput aria-label={message('runtimeSettings.worker.input', { number: index + 1 })} value={row().value} disabled={saving()} onInput={(event) => setArgumentsDraft((rows) => rows.map((item) => item.id === row().id ? { ...item, value: event.currentTarget.value } : item))} /><ProductTextButton label={message('runtimeSettings.action.remove')} disabled={saving()} onClick={() => setArgumentsDraft((rows) => rows.filter((item) => item.id !== row().id))} /></div>}</Index>
            <ProductTextButton label={message('runtimeSettings.worker.addArgument')} disabled={saving()} onClick={() => setArgumentsDraft((rows) => [...rows, { id: ++comfyArgRowId, value: '' }])} />
          </Show>
          <div class="dinkster-actions"><ProductTextButton label={message('runtimeSettings.page.done')} disabled={saving()} onClick={() => { void finishList() }} />
          <ProductTextButton label={message('runtimeSettings.page.cancel')} disabled={saving()} onClick={() => { setEditing(false); setError(undefined) }} />
          </div></div>
        </Show></Show>
      </Show>
    </ProductSettingRow>
  }}</For>
}

function CategoryEditor(props: {
  readonly category: string
  readonly section: RuntimeSettingSection
  readonly connection: SettingsConnection
  readonly onSaveStart: () => void
  readonly onSaved: (section: RuntimeSettingSection) => void
}) {
  const message = useAppMessage()
  const categoryLabel = (): string => {
    const key = CATEGORY_LABELS[props.category]
    return key === undefined ? props.category : message(key)
  }
  const [draft, setDraft] = createSignal<unknown>(props.section.value)
  const [loggingRows, setLoggingRows] = createSignal<readonly LoggingRow[]>([])
  const [comfyArgRows, setComfyArgRows] = createSignal<readonly ComfyArgRow[]>([])
  const [error, setError] = createSignal('')
  const [rejected, setRejected] = createSignal<{ readonly offendingFlag: string; readonly owner: string }>()
  const [saving, setSaving] = createSignal(false)
  const reset = (): void => {
    setDraft(props.section.value)
    setLoggingRows(Object.entries(asRecord(asRecord(props.section.value)['overrides'])).map(([name, level]) => ({ id: ++loggingRowId, name, level: String(level) })))
    setComfyArgRows((Array.isArray(props.section.value) ? props.section.value : []).filter((value): value is string => typeof value === 'string').map((value) => ({ id: ++comfyArgRowId, value })))
    setError('')
    setRejected(undefined)
  }
  createEffect(reset)
  const change = (value: unknown): void => { setDraft(value); setError(''); setRejected(undefined) }
  const submittedValue = (): unknown => props.category === 'worker-comfy-args'
    ? comfyArgRows().map((row) => row.value).filter((arg) => arg.trim() !== '')
    : draft()
  const dirty = (): boolean => !sameValue(submittedValue(), props.section.value)
  const save = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (!dirty() || saving()) return
    props.onSaveStart()
    setSaving(true)
    try {
      props.onSaved(await props.connection.updateRuntimeSetting(props.category, submittedValue()))
      setError('')
      setRejected(undefined)
    } catch (cause) {
      setError(failureMessage(cause, message('request.settingsSaveFailed')))
      setRejected(cause instanceof RuntimeSettingsError && cause.offendingFlag !== undefined && cause.owner !== undefined
        ? { offendingFlag: cause.offendingFlag, owner: cause.owner }
        : undefined)
    } finally {
      setSaving(false)
    }
  }
  const logging = () => asRecord(draft())
  const syncLogging = (level: unknown, rows: readonly LoggingRow[]): void => {
    setLoggingRows(rows)
    change({ level, overrides: Object.fromEntries(rows.map((row) => [row.name, row.level])) })
  }
  const syncComfyArgs = (rows: readonly ComfyArgRow[]): void => {
    setComfyArgRows(rows)
    change(rows.map((row) => row.value))
  }
  const editorId = createUniqueId()
  const fieldId = (name: string): string => `${editorId}-runtime-${props.category}-${encodeURIComponent(name)}`

  return (
    <form class="runtime-settings-editor" data-category={props.category} onSubmit={(event) => void save(event)}>
      <fieldset disabled={saving()}>
        <legend>{message('runtimeSettings.editor.legend', { category: categoryLabel() })}</legend>
        <Show when={props.category === 'memory-budgets'}>
          <For each={Object.keys(asRecord(props.section.value))}>{(device) => {
            const controlId = fieldId(`memory-${device}`)
            const ids = productFieldIds(controlId)
            return <ProductField controlId={controlId} label={device} layout="stack">
              <ProductTextInput id={controlId} aria-label={message('runtimeSettings.memory.budget', { device })} aria-labelledby={ids.label} value={String(asRecord(draft())[device])} onInput={(event) => change({ ...asRecord(draft()), [device]: sizeValue(event.currentTarget.value) })} />
            </ProductField>
          }}</For>
        </Show>
        <Show when={props.category === 'memory-headroom'}>
          {(() => {
            const controlId = fieldId('headroom')
            const ids = productFieldIds(controlId)
            return <ProductField controlId={controlId} label={message('runtimeSettings.memory.headroomBytes')} layout="stack">
              <ProductTextInput id={controlId} aria-label={message('runtimeSettings.memory.headroom')} aria-labelledby={ids.label} value={String(draft())} onInput={(event) => change(sizeValue(event.currentTarget.value))} />
            </ProductField>
          })()}
        </Show>
        <Show when={props.category === 'aimdo-policy'}>
          <ProductField controlId={fieldId('policy')} label={message('runtimeSettings.aimdo.policy')} layout="stack">
            <ProductSelect id={fieldId('policy')} ariaLabel={message('runtimeSettings.category.aimdoPolicy')} selectedId={String(draft())} options={['auto', 'on', 'off'].map((value) => ({ id: value, label: value, value }))} onSelect={(option) => change(option.value)} />
          </ProductField>
        </Show>
        <Show when={props.category === 'dtype-policy'}>
          <For each={[
            ['diffusion', 'runtimeSettings.dtype.diffusion'],
            ['textEncoder', 'runtimeSettings.dtype.textEncoders'],
            ['vae', 'runtimeSettings.dtype.vae'],
          ] as const}>{([component, labelKey]) => (
            <ProductField controlId={fieldId(component)} label={message(labelKey)} layout="stack"><ProductSelect
              id={fieldId(component)}
              ariaLabel={message('runtimeSettings.dtype.ariaLabel', { component: message(labelKey) })}
              selectedId={String(asRecord(draft())[component] ?? 'auto')}
              options={[
                { id: 'auto', label: message('runtimeSettings.dtype.auto'), value: 'auto' },
                { id: 'float16', label: 'FP16', value: 'float16' },
                { id: 'bfloat16', label: 'BF16', value: 'bfloat16' },
                { id: 'float32', label: 'FP32', value: 'float32' },
              ]}
              onSelect={(option) => change({ ...asRecord(draft()), [component]: option.value })}
            /></ProductField>
          )}</For>
          <ProductNotice tone="info">{message('runtimeSettings.dtype.notice')}</ProductNotice>
        </Show>
        <Show when={props.category === 'fp8-matmul'}>
          <ProductField controlId={fieldId('enabled')} label={message('runtimeSettings.fp8.native')} layout="stack">
            <ProductCheckbox id={fieldId('enabled')} ariaLabel={message('runtimeSettings.fp8.native')} checked={draft() === true} onChange={change} />
          </ProductField>
        </Show>
        <Show when={props.category === 'worker-comfy-args'}>
          <Index each={comfyArgRows()}>{(row, index) => (
            <ProductField
              controlId={fieldId(`argument-${row().id}`)}
              label={message('runtimeSettings.worker.argument', { number: index + 1 })}
              layout="compact"
              actions={<ProductButton size="compact" type="button" aria-label={message('runtimeSettings.worker.removeArgument', { number: index + 1 })} onClick={() => syncComfyArgs(comfyArgRows().filter((item) => item.id !== row().id))}>{message('runtimeSettings.action.remove')}</ProductButton>}
            >
              <ProductTextInput id={fieldId(`argument-${row().id}`)} aria-label={message('runtimeSettings.worker.input', { number: index + 1 })} value={row().value} onInput={(event) => syncComfyArgs(comfyArgRows().map((item) => item.id === row().id ? { ...item, value: event.currentTarget.value } : item))} />
            </ProductField>
          )}</Index>
          <ProductButton size="compact" type="button" class="product-form-add" onClick={() => syncComfyArgs([...comfyArgRows(), { id: ++comfyArgRowId, value: '' }])}>{message('runtimeSettings.worker.addArgument')}</ProductButton>
        </Show>
        <Show when={props.category === 'jobs'}>
          <ProductField controlId={fieldId('maximum-running')} label={message('runtimeSettings.jobs.maximumRunning')} layout="stack">
            <ProductNumberInput id={fieldId('maximum-running')} ariaLabel={message('runtimeSettings.jobs.maximumRunning')} inputMode="numeric" min={1} step={1} value={String(asRecord(draft())['maxRunningJobs'] ?? '')} onInput={(value) => change({ maxRunningJobs: Number(value) })} />
          </ProductField>
        </Show>
        <Show when={props.category === 'logging'}>
          <ProductField controlId={fieldId('default-level')} label={message('runtimeSettings.logging.defaultLevel')} layout="stack"><ProductSelect
            id={fieldId('default-level')}
            ariaLabel={message('runtimeSettings.logging.defaultLogLevel')}
            selectedId={String(logging()['level'] ?? '')}
            options={(() => {
              const current = String(logging()['level'] ?? '')
              const known = ['debug', 'info', 'warning', 'error', 'critical']
              return [...(!known.includes(current) ? [current] : []), ...known].map((value) => ({ id: value, label: value, value }))
            })()}
            onSelect={(option) => syncLogging(option.value, loggingRows())}
          /></ProductField>
          <Index each={loggingRows()}>{(row) => (
            <div class="runtime-override-group">
              <ProductField controlId={fieldId(`logger-${row().id}`)} label={message('runtimeSettings.logging.logger')} layout="compact">
                <ProductTextInput id={fieldId(`logger-${row().id}`)} aria-label={message('runtimeSettings.logging.loggerName')} value={row().name} onInput={(event) => syncLogging(logging()['level'], loggingRows().map((item) => item.id === row().id ? { ...item, name: event.currentTarget.value } : item))} />
              </ProductField>
              <ProductField
                controlId={fieldId(`level-${row().id}`)}
                label={message('runtimeSettings.logging.level')}
                layout="compact"
                actions={<ProductButton size="compact" type="button" aria-label={message('runtimeSettings.logging.removeOverride', { logger: row().name || message('runtimeSettings.logging.newLogger') })} onClick={() => syncLogging(logging()['level'], loggingRows().filter((item) => item.id !== row().id))}>{message('runtimeSettings.action.remove')}</ProductButton>}
              >
                <ProductTextInput id={fieldId(`level-${row().id}`)} aria-label={message('runtimeSettings.logging.logLevel', { logger: row().name || message('runtimeSettings.logging.newLogger') })} value={row().level} onInput={(event) => syncLogging(logging()['level'], loggingRows().map((item) => item.id === row().id ? { ...item, level: event.currentTarget.value } : item))} />
              </ProductField>
            </div>
          )}</Index>
          <ProductButton size="compact" type="button" class="product-form-add" onClick={() => syncLogging(logging()['level'], [...loggingRows(), { id: ++loggingRowId, name: '', level: 'info' }])}>{message('runtimeSettings.logging.addOverride')}</ProductButton>
        </Show>
        <ProductActionFooter status={message(saving() ? 'runtimeSettings.status.savingChanges' : dirty() ? 'runtimeSettings.status.unsavedChanges' : 'runtimeSettings.status.clean')}>
          <ProductButton size="compact" type="button" disabled={!dirty() || saving()} onClick={reset}>{message('runtimeSettings.action.reset')}</ProductButton>
          <ProductButton size="compact" type="submit" variant="primary" disabled={!dirty() || saving()}>{message(saving() ? 'runtimeSettings.status.saving' : 'runtimeSettings.action.apply')}</ProductButton>
        </ProductActionFooter>
      </fieldset>
      <Show when={error()}><ProductNotice tone="error"><span>{error()}</span><Show when={rejected()}>{(detail) => <><br /><span>{message('runtimeSettings.error.rejectedFlag', { flag: detail().offendingFlag, owner: detail().owner })}</span></>}</Show></ProductNotice></Show>
    </form>
  )
}

export function RuntimeSettingsPanel(props: { readonly connection: SettingsConnection; readonly backendLabel?: string; readonly categories?: readonly string[] | ((category: string) => boolean); readonly alwaysOpen?: boolean; readonly settingsPage?: boolean; readonly onCopyId?: (id: string) => void }) {
  const message = useAppMessage()
  const [open, setOpen] = createSignal(props.alwaysOpen === true)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const [data, setData] = createSignal<RuntimeSettings>()
  let requestSequence = 0
  const invalidateLoad = (): void => {
    requestSequence += 1
    setLoading(false)
    setError('')
  }
  const load = async (): Promise<void> => {
    const request = ++requestSequence
    setLoading(true)
    setError('')
    try {
      const result = await props.connection.fetchRuntimeSettings()
      if (request === requestSequence) setData(result)
    } catch (cause) {
      if (request === requestSequence) setError(failureMessage(cause, message('request.settingsLoadFailed')))
    } finally {
      if (request === requestSequence) setLoading(false)
    }
  }
  const toggle = (): void => {
    const next = !open()
    setOpen(next)
    if (next && data() === undefined && !loading()) void load()
  }
  onMount(() => { if (props.alwaysOpen === true) void load() })
  const categories = (): readonly string[] => {
    const current = data()
    if (!current) return []
    const all = [...current.categories.available, ...Object.keys(current.settings).filter((category) => !current.categories.available.includes(category))]
    return all.filter((category) => props.categories === undefined || (typeof props.categories === 'function' ? props.categories(category) : props.categories.includes(category)))
  }
  const editable = (category: string, section: RuntimeSettingSection): boolean =>
    (data()?.categories.granted.length ?? 0) > 0 && data()!.categories.granted.includes(category) && section.writable
  const knownEditor = (category: string): boolean => ['memory-budgets', 'memory-headroom', 'aimdo-policy', 'dtype-policy', 'fp8-matmul', 'worker-comfy-args', 'jobs', 'logging'].includes(category)
  const accessLabel = (category: string, section: RuntimeSettingSection): string => {
    if (!data()?.categories.granted.includes(category)) return message('runtimeSettings.access.grantRequired')
    if (!section.writable) return message('runtimeSettings.access.readOnly')
    if (!knownEditor(category)) return message('runtimeSettings.access.readOnlyBuild')
    return message('runtimeSettings.access.editable')
  }
  const categoryLabel = (category: string): string => {
    const key = CATEGORY_LABELS[category]
    return key === undefined ? category : message(key)
  }
  const replace = (category: string, section: RuntimeSettingSection): void => {
    const current = data()
    if (current) setData({ ...current, settings: { ...current.settings, [category]: section } })
  }
  const changeable = (): readonly string[] => categories().filter((category) => {
    const section = data()?.settings[category]
    return section !== undefined && editable(category, section) && knownEditor(category)
  })

  return (
    <Show when={props.settingsPage} fallback={<section class="runtime-settings" data-testid="runtime-settings" aria-label={message('runtimeSettings.panel.ariaLabel', { backend: props.backendLabel ?? message('runtimeSettings.backend') })}>
      <Show when={props.alwaysOpen !== true}><ProductButton size="compact" class="runtime-settings-toggle" aria-expanded={open()} onClick={toggle}><span>{message('runtimeSettings.panel.title')}</span>{' '}<span>{message(open() ? 'runtimeSettings.action.hide' : 'runtimeSettings.action.show')}</span></ProductButton></Show>
      <Show when={open()}>
        <div class="runtime-settings-body">
          <div class="runtime-settings-toolbar">
            <div><Show when={props.alwaysOpen === true}><h3>{message('runtimeSettings.panel.title')}</h3></Show><p>{message('runtimeSettings.panel.description')}</p></div>
            <ProductButton size="compact" type="button" disabled={loading()} aria-label={message('runtimeSettings.action.refreshAriaLabel', { backend: props.backendLabel ?? message('runtimeSettings.backendLower') })} onClick={() => void load()}>{message(loading() ? 'runtimeSettings.status.refreshing' : 'runtimeSettings.action.refresh')}</ProductButton>
          </div>
          <Show when={loading() && data() === undefined}><ProductNotice tone="status">{message('runtimeSettings.status.loading')}</ProductNotice></Show>
          <Show when={loading() && data() !== undefined}><ProductNotice tone="status">{message('runtimeSettings.status.refreshingVisible')}</ProductNotice></Show>
          <Show when={error()}><ProductNotice tone="error">{error()}{data() !== undefined ? message('runtimeSettings.error.previousVisible') : ''}</ProductNotice></Show>
          <Show when={data()}>{(settings) => (
            <>
            <Show when={categories().length === 0}><ProductNotice tone="info">{message('runtimeSettings.state.empty')}</ProductNotice></Show>
            <For each={categories()}>{(category) => {
              const section = () => settings().settings[category]
              return <Show when={section()}>{(item) => (
                <details class="runtime-setting-category" data-category={category} open>
                  <summary>
                    <span><strong>{categoryLabel(category)}</strong><small>{category}</small></span>
                    <span class="runtime-setting-access" data-access={accessLabel(category, item())}>{accessLabel(category, item())}</span>
                  </summary>
                  <div class="runtime-setting-content">
                    <dl class="runtime-setting-metadata">
                      <div><dt>{message('runtimeSettings.metadata.effectiveValue')}</dt><dd><code>{JSON.stringify(item().value)}</code></dd></div>
                      <div><dt>{message('runtimeSettings.metadata.source')}</dt><dd>{item().source}</dd></div>
                      <div><dt>{message('runtimeSettings.metadata.mutability')}</dt><dd>{item().mutability}</dd></div>
                      <div><dt>{message('runtimeSettings.metadata.persistence')}</dt><dd>{message(item().persistence.available ? item().persistence.persisted ? 'runtimeSettings.persistence.persisted' : 'runtimeSettings.persistence.notPersisted' : 'runtimeSettings.persistence.unavailable')}</dd></div>
                    </dl>
                    <Show when={item().mutability === 'on-worker-restart'}><ProductNotice tone="info">{message('runtimeSettings.notice.workerRestart')}</ProductNotice></Show>
                    <Show when={!settings().categories.granted.includes(category)}><ProductNotice tone="warning">{message('runtimeSettings.warning.categoryNotGranted', { category: categoryLabel(category) })}</ProductNotice></Show>
                    <Show when={settings().categories.granted.includes(category) && !item().writable}><ProductNotice tone="info">{message('runtimeSettings.notice.readOnly')}</ProductNotice></Show>
                    <Show when={editable(category, item()) && knownEditor(category)}><CategoryEditor category={category} section={item()} connection={props.connection} onSaveStart={invalidateLoad} onSaved={(updated) => replace(category, updated)} /></Show>
                    <Show when={item().source === 'runtime' && (!item().persistence.available || !item().persistence.persisted)}><ProductNotice tone="status">{message('runtimeSettings.notice.memoryOnly')}</ProductNotice></Show>
                  </div>
                </details>
              )}</Show>
            }}</For></>
          )}</Show>
        </div>
      </Show>
    </section>}>
      <section class="dinkster-stack" data-testid="runtime-settings" aria-label={message('runtimeSettings.panel.ariaLabel', { backend: props.backendLabel ?? message('runtimeSettings.backend') })}>
        <Show when={loading()}><p class="dinkster-settings-note" role="status">{message('runtimeSettings.status.loading')}</p></Show>
        <Show when={error()}><p class="dinkster-field-error" role="alert">{error()}</p></Show>
        <Show when={data()}>
          <Show when={categories().length === 0}><p class="dinkster-settings-note">{message('runtimeSettings.state.empty')}</p></Show>
          <For each={changeable().length === 0 ? [null] : [true, false]}>{(workers) => <Show when={categories().some((category) => workers === null || (data()?.settings[category]?.mutability === 'on-worker-restart') === workers)}>
            <ProductSettingsSection title={<><Show when={workers === null}><ProductIcon icon={LockKeyhole} /></Show>{props.backendLabel ?? message('runtimeSettings.backend')}<Show when={workers !== null}>{` - ${message(workers ? 'runtimeSettings.page.workerNotice' : 'runtimeSettings.page.immediate')}`}</Show></>}>
          <Show when={workers === null}><p class="dinkster-settings-note">{message('runtimeSettings.page.locked')}</p></Show>
          <For each={categories().filter((category) => workers === null || (data()?.settings[category]?.mutability === 'on-worker-restart') === workers)}>{(category) => <Show when={data()?.settings[category]}>{(section) => <EngineSettingRows category={category} section={section()}
            editable={editable(category, section()) && knownEditor(category)}
            connection={props.connection} onSaveStart={invalidateLoad} onSaved={(updated) => replace(category, updated)} onCopyId={(id) => props.onCopyId?.(id)} />}</Show>}</For>
            </ProductSettingsSection>
          </Show>}</For>
        </Show>
      </section>
    </Show>
  )
}

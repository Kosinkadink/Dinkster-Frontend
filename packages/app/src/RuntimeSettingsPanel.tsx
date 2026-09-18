import { createEffect, createSignal, createUniqueId, For, Index, onMount, Show } from 'solid-js'
import {
  RuntimeSettingsError,
  type DinksterConnection,
  type RuntimeSettingSection,
  type RuntimeSettings,
} from '@dinkster/client'
import { ProductCheckbox } from './ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from './ProductForm.js'
import { ProductNumberInput } from './ProductNumberInput.js'
import { ProductSelect } from './ProductSelect.js'
import { ProductSlider } from './ProductSlider.js'
import { useAppMessage } from './locale.js'

type SettingsConnection = Pick<DinksterConnection, 'fetchRuntimeSettings' | 'updateRuntimeSetting'>

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const sizeValue = (value: string): number | string => /^\d+$/.test(value.trim()) ? Number(value) : value.trim()

const sizeBytes = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  const match = typeof value === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)b?\s*$/i.exec(value) : null
  if (match === null) return 0
  const power = ['', 'k', 'm', 'g', 't'].indexOf(match[2]!.toLowerCase())
  return Number(match[1]) * 1024 ** Math.max(0, power)
}

const sizeMiB = (value: unknown): number => Math.round(sizeBytes(value) / 1024 ** 2)

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

function CategoryEditor(props: {
  readonly category: string
  readonly section: RuntimeSettingSection
  readonly connection: SettingsConnection
  readonly onSaveStart: () => void
  readonly onSaved: (section: RuntimeSettingSection) => void
  readonly memoryControls?: boolean
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
  const [budgetMaximums, setBudgetMaximums] = createSignal<Readonly<Record<string, number>>>({})
  const [headroomMaximum, setHeadroomMaximum] = createSignal(1024)
  const reset = (): void => {
    setDraft(props.section.value)
    setBudgetMaximums((current) => Object.fromEntries(Object.entries(asRecord(props.section.value)).map(([device, value]) => [device, Math.max(current[device] ?? 1024, sizeMiB(value) * 2)])))
    setHeadroomMaximum((current) => Math.max(current, sizeMiB(props.section.value) * 4))
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
      setError(cause instanceof RuntimeSettingsError ? cause.message : cause instanceof Error ? cause.message : String(cause))
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
            return <ProductField controlId={controlId} label={props.memoryControls ? message('runtimeSettings.memory.budgetMiB', { device }) : device} layout="stack">
              <Show when={props.memoryControls} fallback={
                <input id={controlId} aria-label={message('runtimeSettings.memory.budget', { device })} aria-labelledby={ids.label} value={String(asRecord(draft())[device])} onInput={(event) => change({ ...asRecord(draft()), [device]: sizeValue(event.currentTarget.value) })} />
              }>
                <div class="runtime-memory-control">
                  <ProductNumberInput id={controlId} ariaLabel={message('runtimeSettings.memory.budget', { device })} ariaLabelledBy={ids.label} inputMode="numeric" min={0} step={64} value={sizeMiB(asRecord(draft())[device])} onInput={(value) => change({ ...asRecord(draft()), [device]: Number(value) * 1024 ** 2 })} />
                  <ProductSlider ariaLabel={message('runtimeSettings.memory.budgetSlider', { device })} min={0} max={budgetMaximums()[device] ?? 1024} step={64} value={sizeMiB(asRecord(draft())[device])} onInput={(value) => change({ ...asRecord(draft()), [device]: value * 1024 ** 2 })} />
                </div>
              </Show>
            </ProductField>
          }}</For>
        </Show>
        <Show when={props.category === 'memory-headroom'}>
          {(() => {
            const controlId = fieldId('headroom')
            const ids = productFieldIds(controlId)
            return <ProductField controlId={controlId} label={message(props.memoryControls ? 'runtimeSettings.memory.headroomMiB' : 'runtimeSettings.memory.headroomBytes')} layout="stack">
              <Show when={props.memoryControls} fallback={<input id={controlId} aria-label={message('runtimeSettings.memory.headroom')} aria-labelledby={ids.label} value={String(draft())} onInput={(event) => change(sizeValue(event.currentTarget.value))} />}>
                <div class="runtime-memory-control">
                  <ProductNumberInput id={controlId} ariaLabel={message('runtimeSettings.memory.headroom')} ariaLabelledBy={ids.label} inputMode="numeric" min={0} step={64} value={sizeMiB(draft())} onInput={(value) => change(Number(value) * 1024 ** 2)} />
                  <ProductSlider ariaLabel={message('runtimeSettings.memory.headroomSlider')} min={0} max={headroomMaximum()} step={64} value={sizeMiB(draft())} onInput={(value) => change(value * 1024 ** 2)} />
                </div>
              </Show>
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
              actions={<button type="button" aria-label={message('runtimeSettings.worker.removeArgument', { number: index + 1 })} onClick={() => syncComfyArgs(comfyArgRows().filter((item) => item.id !== row().id))}>{message('runtimeSettings.action.remove')}</button>}
            >
              <input id={fieldId(`argument-${row().id}`)} aria-label={message('runtimeSettings.worker.input', { number: index + 1 })} value={row().value} onInput={(event) => syncComfyArgs(comfyArgRows().map((item) => item.id === row().id ? { ...item, value: event.currentTarget.value } : item))} />
            </ProductField>
          )}</Index>
          <button type="button" class="product-form-add" onClick={() => syncComfyArgs([...comfyArgRows(), { id: ++comfyArgRowId, value: '' }])}>{message('runtimeSettings.worker.addArgument')}</button>
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
                <input id={fieldId(`logger-${row().id}`)} aria-label={message('runtimeSettings.logging.loggerName')} value={row().name} onInput={(event) => syncLogging(logging()['level'], loggingRows().map((item) => item.id === row().id ? { ...item, name: event.currentTarget.value } : item))} />
              </ProductField>
              <ProductField
                controlId={fieldId(`level-${row().id}`)}
                label={message('runtimeSettings.logging.level')}
                layout="compact"
                actions={<button type="button" aria-label={message('runtimeSettings.logging.removeOverride', { logger: row().name || message('runtimeSettings.logging.newLogger') })} onClick={() => syncLogging(logging()['level'], loggingRows().filter((item) => item.id !== row().id))}>{message('runtimeSettings.action.remove')}</button>}
              >
                <input id={fieldId(`level-${row().id}`)} aria-label={message('runtimeSettings.logging.logLevel', { logger: row().name || message('runtimeSettings.logging.newLogger') })} value={row().level} onInput={(event) => syncLogging(logging()['level'], loggingRows().map((item) => item.id === row().id ? { ...item, level: event.currentTarget.value } : item))} />
              </ProductField>
            </div>
          )}</Index>
          <button type="button" class="product-form-add" onClick={() => syncLogging(logging()['level'], [...loggingRows(), { id: ++loggingRowId, name: '', level: 'info' }])}>{message('runtimeSettings.logging.addOverride')}</button>
        </Show>
        <ProductActionFooter status={message(saving() ? 'runtimeSettings.status.savingChanges' : dirty() ? 'runtimeSettings.status.unsavedChanges' : 'runtimeSettings.status.clean')}>
          <button type="button" disabled={!dirty() || saving()} onClick={reset}>{message('runtimeSettings.action.reset')}</button>
          <button type="submit" class="primary" disabled={!dirty() || saving()}>{message(saving() ? 'runtimeSettings.status.saving' : 'runtimeSettings.action.apply')}</button>
        </ProductActionFooter>
      </fieldset>
      <Show when={error()}><ProductNotice tone="error"><span>{error()}</span><Show when={rejected()}>{(detail) => <><br /><span>{message('runtimeSettings.error.rejectedFlag', { flag: detail().offendingFlag, owner: detail().owner })}</span></>}</Show></ProductNotice></Show>
    </form>
  )
}

export function RuntimeSettingsPanel(props: { readonly connection: SettingsConnection; readonly backendLabel?: string; readonly categories?: readonly string[]; readonly alwaysOpen?: boolean; readonly memoryControls?: boolean; readonly showGrantWarnings?: boolean }) {
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
      if (request === requestSequence) setError(cause instanceof Error ? cause.message : String(cause))
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
    return props.categories === undefined ? all : all.filter((category) => props.categories!.includes(category))
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

  return (
    <section class="runtime-settings" data-testid="runtime-settings" aria-label={message('runtimeSettings.panel.ariaLabel', { backend: props.backendLabel ?? message('runtimeSettings.backend') })}>
      <Show when={props.alwaysOpen !== true}><button class="runtime-settings-toggle" aria-expanded={open()} aria-label={message('runtimeSettings.panel.ariaLabel', { backend: props.backendLabel ?? message('runtimeSettings.backend') })} onClick={toggle}><span>{message('runtimeSettings.panel.title')}</span><span aria-hidden="true">{message(open() ? 'runtimeSettings.action.hide' : 'runtimeSettings.action.show')}</span></button></Show>
      <Show when={open()}>
        <div class="runtime-settings-body">
          <div class="runtime-settings-toolbar">
            <div><Show when={props.alwaysOpen === true}><h3>{message('runtimeSettings.panel.title')}</h3></Show><p>{message('runtimeSettings.panel.description')}</p></div>
            <button type="button" disabled={loading()} aria-label={message('runtimeSettings.action.refreshAriaLabel', { backend: props.backendLabel ?? message('runtimeSettings.backendLower') })} onClick={() => void load()}>{message(loading() ? 'runtimeSettings.status.refreshing' : 'runtimeSettings.action.refresh')}</button>
          </div>
          <Show when={loading() && data() === undefined}><ProductNotice tone="status">{message('runtimeSettings.status.loading')}</ProductNotice></Show>
          <Show when={loading() && data() !== undefined}><ProductNotice tone="status">{message('runtimeSettings.status.refreshingVisible')}</ProductNotice></Show>
          <Show when={error()}><ProductNotice tone="error">{error()}{data() !== undefined ? message('runtimeSettings.error.previousVisible') : ''}</ProductNotice></Show>
          <Show when={data()}>{(settings) => (
            <>
            <Show when={props.showGrantWarnings === true}><For each={(props.categories ?? []).filter((category) => !settings().categories.granted.includes(category) || settings().settings[category]?.writable !== true)}>{(category) => <ProductNotice tone="warning">{message('runtimeSettings.warning.missingGrant', { category })}</ProductNotice>}</For></Show>
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
                    <Show when={editable(category, item()) && knownEditor(category)}><CategoryEditor category={category} section={item()} connection={props.connection} onSaveStart={invalidateLoad} onSaved={(updated) => replace(category, updated)} {...(props.memoryControls === undefined ? {} : { memoryControls: props.memoryControls })} /></Show>
                    <Show when={item().source === 'runtime' && (!item().persistence.available || !item().persistence.persisted)}><ProductNotice tone="status">{message('runtimeSettings.notice.memoryOnly')}</ProductNotice></Show>
                  </div>
                </details>
              )}</Show>
            }}</For></>
          )}</Show>
        </div>
      </Show>
    </section>
  )
}

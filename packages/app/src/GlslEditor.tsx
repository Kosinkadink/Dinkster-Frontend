import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import {
  asNodeId,
  GLSL_STATE_PREVIEW_CHANNEL,
  GLSL_STATE_PREVIEW_STREAM,
  glslShaderStateOf,
  occurrenceKey,
  type GlslShaderState,
} from '@dinkster/core'
import type { PreviewData } from '@dinkster/client'
import type { AppState, GlslEditorTarget } from './app-state.js'
import type { EditorHostContext } from './editors.js'
import {
  createGlslShaderRunner,
  type GlslShaderRunner,
  type GlslShaderResult,
} from './glsl-shader-runner.js'
import { useSignal } from './solid-adapter.js'

interface RuntimeGlslState {
  readonly state: GlslShaderState
  readonly frames: Readonly<Record<string, PreviewData | undefined>>
  readonly timestamp: number
}

const payloadBlob = (frame: PreviewData | undefined): Blob | undefined => {
  if (frame?.payload instanceof Blob) return frame.payload
  if (frame?.payload instanceof ArrayBuffer) return new Blob([frame.payload], { type: frame.channel })
  return undefined
}

export function GlslEditor(props: {
  readonly app: AppState
  readonly host?: EditorHostContext
  readonly createRunner?: () => GlslShaderRunner
}) {
  const activeTarget = useSignal(props.app.glslEditorTarget)
  const tabs = useSignal(props.app.tabs)
  const executions = useSignal(props.app.store.executions)
  const globalActiveTabId = useSignal(props.app.activeTabId)
  const activeTabId = (): string => props.host?.tabId() ?? globalActiveTabId()
  const [documentTick, setDocumentTick] = createSignal(0)
  const [draft, setDraft] = createSignal('')
  const [output, setOutput] = createSignal<0 | 1 | 2 | 3>(0)
  const [images, setImages] = createSignal<Readonly<Record<string, HTMLImageElement>>>({})
  const [result, setResult] = createSignal<GlslShaderResult>()
  const [applyError, setApplyError] = createSignal<string>()
  const runner = (props.createRunner ?? createGlslShaderRunner)()
  let initializedTarget: GlslEditorTarget | undefined
  let decodeGeneration = 0
  let canvas: HTMLCanvasElement | undefined
  onCleanup(() => runner.dispose())

  createEffect(() => {
    const request = activeTarget()
    const active = activeTabId()
    if (request === initializedTarget && request?.tabId === active) return
    initializedTarget = request?.tabId === active ? request : undefined
    setDraft(initializedTarget?.openedValue ?? '')
    setOutput(0)
    setApplyError(undefined)
    setResult(undefined)
  })

  createEffect(() => {
    const request = activeTarget()
    const tab = request && request.tabId === activeTabId()
      ? tabs().find((candidate) => candidate.id === request.tabId)
      : undefined
    if (!tab) return
    const unsubscribe = tab.store.document.subscribe(() => setDocumentTick((tick) => tick + 1))
    onCleanup(unsubscribe)
  })

  const currentTarget = createMemo((): GlslEditorTarget | undefined => {
    documentTick()
    const request = activeTarget()
    return request && request.tabId === activeTabId()
      ? props.app.validateGlslTarget(request)
      : undefined
  })

  const runtime = createMemo((): RuntimeGlslState | undefined => {
    executions()
    const request = currentTarget()
    const tab = request && tabs().find((candidate) => candidate.id === request.tabId)
    const execution = tab ? props.app.executionForTab(tab) : undefined
    if (!request || !execution?.artifact) return undefined
    const source = occurrenceKey({
      instancePath: request.instancePath.map(asNodeId),
      node: asNodeId(request.nodeId),
    })
    return (execution.artifact.provenance.fromSource[source] ?? []).flatMap((runtimeNodeId) => {
      const stateFrame = execution.previews[runtimeNodeId]?.[GLSL_STATE_PREVIEW_STREAM]
      const state = stateFrame?.channel === GLSL_STATE_PREVIEW_CHANNEL
        ? glslShaderStateOf(stateFrame.payload)
        : undefined
      if (!state) return []
      return [{
        state,
        frames: Object.fromEntries(state.inputs.map((input) =>
          [input.name, execution.previews[runtimeNodeId]?.[input.stream]])),
        timestamp: stateFrame?.timestamp ?? 0,
      }]
    }).sort((left, right) => right.timestamp - left.timestamp)[0]
  })

  createEffect(() => {
    const value = runtime()
    const generation = ++decodeGeneration
    setImages({})
    setResult(undefined)
    if (!value) return
    const urls: string[] = []
    let disposed = false
    onCleanup(() => {
      disposed = true
      for (const url of urls) URL.revokeObjectURL(url)
    })
    void Promise.all(value.state.inputs.map(async (input) => {
      const blob = payloadBlob(value.frames[input.name])
      if (!blob) throw new Error(`Preview image ${input.name} is unavailable`)
      const url = URL.createObjectURL(blob)
      urls.push(url)
      const image = new Image()
      image.src = url
      await image.decode()
      return [input.name, image] as const
    })).then((entries) => {
      if (!disposed && generation === decodeGeneration) setImages(Object.fromEntries(entries))
    }).catch((error: unknown) => {
      if (!disposed && generation === decodeGeneration) {
        setResult({ ok: false, diagnostics: [error instanceof Error ? error.message : String(error)] })
      }
    })
  })

  createEffect(() => {
    const source = draft()
    const state = runtime()?.state
    const decoded = images()
    const selectedOutput = output()
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!state) {
      setResult(undefined)
    } else if (state.inputs.every((input) => decoded[input.name] !== undefined)) {
      timer = setTimeout(() => setResult(runner.render({
        source,
        state,
        images: decoded,
        output: selectedOutput,
      })), 50)
    }
    onCleanup(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  })

  createEffect(() => {
    const preview = result()
    if (!preview?.ok || !canvas) return
    canvas.width = preview.image.width
    canvas.height = preview.image.height
    canvas.getContext('2d')?.putImageData(preview.image, 0, 0)
  })

  const apply = (): void => {
    const request = activeTarget()
    const current = request ? props.app.validateGlslTarget(request) : undefined
    const tab = current && tabs().find((candidate) => candidate.id === current.tabId)
    if (!request || !current || !tab) {
      setApplyError('The shader input changed or became linked while editing')
      return
    }
    const outcome = props.app.dispatchTo(tab, {
      command: 'node.setValue',
      params: {
        graphId: request.graphId,
        nodeId: request.nodeId,
        inputId: request.inputId,
        value: draft(),
      },
    })
    if (!outcome.ok) {
      setApplyError(outcome.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ??
        'Shader update was refused')
      return
    }
    props.app.closeGlslEditor(request)
  }

  const state = createMemo(() => runtime()?.state)
  const diagnostics = createMemo(() => {
    const value = result()
    return value && !value.ok ? value.diagnostics : []
  })

  return <section class="glsl-editor" data-testid="glsl-editor">
    <Show when={activeTarget()} fallback={<div class="editor-missing">No GLSL Shader target is active.</div>}>
      {(request) => <>
        <header class="glsl-editor-header">
          <div><strong>GLSL Shader</strong><small>{request().nodeId} / {request().inputId}</small></div>
          <div>
            <button onClick={() => props.app.closeGlslEditor(request())}>Cancel</button>
            <button class="primary" disabled={currentTarget() === undefined} onClick={apply}>Apply</button>
          </div>
        </header>
        <div class="glsl-editor-body">
          <label class="glsl-source-panel">
            <span>Fragment shader</span>
            <textarea
              data-testid="glsl-source"
              aria-label="Fragment shader source"
              value={draft()}
              spellcheck={false}
              disabled={currentTarget() === undefined}
              onInput={(event) => {
                setDraft(event.currentTarget.value)
                setApplyError(undefined)
              }}
            />
            <small>{new TextEncoder().encode(draft()).byteLength} / 65536 UTF-8 bytes</small>
          </label>
          <main class="glsl-preview-panel">
            <div class="glsl-preview-toolbar">
              <label>Preview output<select
                aria-label="Preview output"
                value={String(output())}
                onChange={(event) => setOutput(Number(event.currentTarget.value) as 0 | 1 | 2 | 3)}
              >
                <option value="0">fragColor0</option>
                <option value="1">fragColor1</option>
                <option value="2">fragColor2</option>
                <option value="3">fragColor3</option>
              </select></label>
              <Show when={state()}>{(value) => <span>{value().width} x {value().height}</span>}</Show>
            </div>
            <div class="glsl-preview-viewport" data-testid="glsl-preview">
              <Show when={result()?.ok} fallback={
                <div class="glsl-preview-empty">
                  {state() ? 'Browser preview unavailable.' : 'Run the node to load authoritative input previews.'}
                </div>
              }>
                <canvas ref={canvas} aria-label="GLSL browser preview" />
              </Show>
            </div>
            <p>Browser preview uses bounded run inputs. Native execution is authoritative.</p>
            <Show when={diagnostics().length > 0}>
              <ul class="glsl-diagnostics" role="alert">
                <For each={diagnostics()}>{(diagnostic) => <li>{diagnostic}</li>}</For>
              </ul>
            </Show>
          </main>
          <aside class="glsl-uniform-panel" aria-label="Shader inputs">
            <h3>Run inputs</h3>
            <Show when={state()} fallback={<p>No runtime state.</p>}>
              {(value) => <>
                <dl>
                  <For each={value().inputs}>{(input) => <div><dt>{input.name}</dt><dd>image</dd></div>}</For>
                  <For each={Object.entries(value().floats)}>{([name, scalar]) => <div><dt>{name}</dt><dd>{scalar}</dd></div>}</For>
                  <For each={Object.entries(value().ints)}>{([name, scalar]) => <div><dt>{name}</dt><dd>{scalar}</dd></div>}</For>
                  <For each={Object.entries(value().bools)}>{([name, scalar]) => <div><dt>{name}</dt><dd>{String(scalar)}</dd></div>}</For>
                  <For each={Object.keys(value().curves)}>{(name) => <div><dt>{name}</dt><dd>256 samples</dd></div>}</For>
                </dl>
              </>}
            </Show>
          </aside>
        </div>
        <Show when={currentTarget() === undefined}>
          <div class="glsl-editor-error" role="alert">This input is linked or no longer available. Disconnect it to edit.</div>
        </Show>
        <Show when={applyError()}>{(message) => <div class="glsl-editor-error" role="alert">{message()}</div>}</Show>
      </>}
    </Show>
  </section>
}

import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from 'solid-js'
import { Download } from 'lucide-solid'
import { ProductFacts } from './account.js'
import { ProductTextButton } from './controls.js'
import { ProductList, ProductListRow } from './layout.js'
import { ProductProgress } from './messages.js'
import { useProductStrings } from './strings.js'

export interface ProductModelVersion {
  readonly id: string
  readonly name: string
  readonly size?: string
  readonly precision?: string
  readonly state:
    | 'installed'
    | 'not-downloaded'
    | 'downloading'
    | 'checking'
    | 'failed'
    | 'unavailable'
  readonly progress?: number | undefined
  readonly message?: string
  readonly facts?: readonly {
    readonly label: string
    readonly value: string
    readonly monospace?: boolean
  }[]
}

export interface ProductModel {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly versions: readonly ProductModelVersion[]
}

export interface ProductModelListProps {
  readonly label: string
  readonly models: readonly ProductModel[]
  /** Opaque app-owned keys, including the digest when versions require it. */
  readonly selected?: readonly {
    readonly modelId: string
    readonly versionId: string
  }[]
  readonly inlineDetails?: boolean
  readonly ref?: (handle: ProductModelListHandle) => void
  /** Inspects any version without changing chosen keys or starting a download. */
  readonly onSelect?: (modelId: string, versionId: string) => void
  /** Installed activation only; browse callers can commit through their own action. */
  readonly onChoose?: (modelId: string, versionId: string) => void
  readonly onDownload?: (modelId: string, versionId: string) => void
  readonly onShowFolder?: (modelId: string, versionId: string) => void
  readonly onCopyName?: (modelId: string, versionId: string) => void
  readonly onHide?: (modelId: string, versionId: string) => void
}

export interface ProductModelListHandle {
  /** Focuses the first visible row; arrow keys then inspect without choosing. */
  focusFirst(): void
}

/** Presentation only: callers retain exact model identity, filtering and acquisition. */
export function ProductModelList(props: ProductModelListProps) {
  const strings = useProductStrings()
  const [expandedModels, setExpandedModels] = createSignal<ReadonlySet<string>>(
    new Set(),
  )
  const [expandedVersions, setExpandedVersions] = createSignal<
    ReadonlySet<string>
  >(new Set())
  const [focusedKey, setFocusedKey] = createSignal<string>()
  const controls = new Map<
    string,
    { button: HTMLButtonElement; inspect?: () => void }
  >()
  const modelKey = (model: ProductModel) => JSON.stringify([model.id])
  const versionKey = (model: ProductModel, version: ProductModelVersion) =>
    JSON.stringify([model.id, version.id])
  const visibleKeys = createMemo(() =>
    props.models.flatMap((model) =>
      model.versions.length > 1
        ? [
            modelKey(model),
            ...(expandedModels().has(model.id)
              ? model.versions.map((version) => versionKey(model, version))
              : []),
          ]
        : model.versions.map((version) => versionKey(model, version)),
    ),
  )
  const tabStop = createMemo(
    () => visibleKeys().find((key) => key === focusedKey()) ?? visibleKeys()[0],
  )
  const register = (
    key: string,
    button: HTMLButtonElement,
    inspect?: () => void,
  ) => {
    controls.set(key, { button, ...(inspect ? { inspect } : {}) })
    onCleanup(() => {
      if (controls.get(key)?.button === button) controls.delete(key)
    })
  }
  const controlOf = (target: EventTarget | null) =>
    [...controls].find(([, control]) => control.button === target)
  onMount(() =>
    props.ref?.({
      focusFirst: () => {
        const first = visibleKeys()[0]
        if (first !== undefined) controls.get(first)?.button.focus()
      },
    }),
  )
  const focus = (event: FocusEvent) => {
    const entry = controlOf(event.target)
    if (!entry) return
    setFocusedKey(entry[0])
    entry[1].inspect?.()
  }
  const move = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    const entry = controlOf(event.target)
    if (!entry) return
    const keys = visibleKeys()
    const index = keys.indexOf(entry[0])
    let next: number
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(index + 1, keys.length - 1)
        break
      case 'ArrowUp':
        next = Math.max(index - 1, 0)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = keys.length - 1
        break
      default:
        return
    }
    const key = keys[next]
    if (key === undefined) return
    event.preventDefault()
    controls.get(key)?.button.focus()
  }
  function Version(propsRow: {
    model: ProductModel
    version: ProductModelVersion
    grouped: boolean
  }) {
    const version = () => propsRow.version
    const model = () => propsRow.model
    const key = () => versionKey(model(), version())
    const open = () => expandedVersions().has(key())
    const hasDetails = () =>
      props.inlineDetails !== false &&
      (Boolean(version().facts?.length) ||
        (version().state === 'installed' &&
          Boolean(props.onShowFolder || props.onCopyName || props.onHide)))
    const title = () => (propsRow.grouped ? version().name : model().name)
    const selected = () =>
      props.selected?.some(
        (item) =>
          item.modelId === model().id && item.versionId === version().id,
      ) ?? false
    const stateLabel = () => {
      switch (version().state) {
        case 'installed':
          return ''
        case 'not-downloaded':
          return strings.modelNotDownloaded
        case 'downloading':
          return strings.modelDownloading
        case 'checking':
          return strings.modelChecking
        case 'failed':
          return strings.modelDownloadFailed
        case 'unavailable':
          return strings.modelUnavailable
      }
    }
    const act = (
      callback: ((modelId: string, versionId: string) => void) | undefined,
    ) => callback?.(model().id, version().id)
    const progressing = () =>
      version().state === 'downloading' || version().state === 'checking'
    const downloadable = () =>
      version().state === 'not-downloaded' && props.onDownload !== undefined
    const activate = () => {
      act(props.onSelect)
      setFocusedKey(key())
      if (version().state === 'installed') act(props.onChoose)
    }
    const toggle = (expanded: boolean) => {
      setExpandedVersions((previous) => {
        const next = new Set(previous)
        if (expanded) next.add(key())
        else next.delete(key())
        return next
      })
      activate()
    }
    return (
      <ProductListRow
        ref={(button) => register(key(), button, () => act(props.onSelect))}
        tabIndex={tabStop() === key() ? 0 : -1}
        pressed={selected()}
        {...(hasDetails()
          ? {
              get expanded() {
                return open()
              },
              onToggle: toggle,
            }
          : { onActivate: activate })}
        title={<span class="dinkster-model-name">{title()}</span>}
        description={
          <span class="dinkster-model-summary" data-state={version().state}>
            {[
              propsRow.grouped ? undefined : model().kind,
              version().precision,
              progressing() ? undefined : (version().message ?? stateLabel()),
            ]
              .filter(Boolean)
              .join(', ')}
          </span>
        }
        status={
          progressing() ? (
            <div class="dinkster-model-progress">
              <ProductProgress
                label={`${model().name}: ${version().name}`}
                value={version().progress}
              />
            </div>
          ) : undefined
        }
        trailing={
          !downloadable() ? (
            <span class="dinkster-model-size">
              {progressing()
                ? (version().message ?? stateLabel())
                : version().size}
            </span>
          ) : undefined
        }
        action={
          downloadable() ? (
            <div class="dinkster-model-download">
              <ProductTextButton
                icon={Download}
                label={version().size ?? strings.modelDownload}
                aria-label={`${strings.modelDownload}: ${title()}`}
                intent="add"
                onClick={() => act(props.onDownload)}
              />
            </div>
          ) : undefined
        }
      >
        <Show when={version().facts?.length}>
          <ProductFacts
            label={title()}
            items={(version().facts ?? []).map((fact) => ({
              label: fact.label,
              value: fact.monospace ? (
                <span class="dinkster-mono">{fact.value}</span>
              ) : (
                fact.value
              ),
            }))}
          />
        </Show>
        <Show when={version().state === 'installed'}>
          <div class="dinkster-model-actions">
            <Show when={props.onShowFolder}>
              <ProductTextButton
                label={strings.modelShowFolder}
                onClick={() => act(props.onShowFolder)}
              />
            </Show>
            <Show when={props.onCopyName}>
              <ProductTextButton
                label={strings.modelCopyName}
                onClick={() => act(props.onCopyName)}
              />
            </Show>
            <Show when={props.onHide}>
              <div class="dinkster-model-hide">
                <ProductTextButton
                  label={strings.modelHide}
                  onClick={() => act(props.onHide)}
                />
              </div>
            </Show>
          </div>
        </Show>
      </ProductListRow>
    )
  }
  function Model(propsRow: { model: ProductModel }) {
    const model = () => propsRow.model
    const open = () => expandedModels().has(model().id)
    const installed = () =>
      model().versions.filter((version) => version.state === 'installed').length
    const missing = () =>
      model().versions.filter(
        (version) =>
          version.state !== 'installed' && version.state !== 'unavailable',
      ).length
    return (
      <Show
        when={model().versions.length > 1}
        fallback={
          <Show when={model().versions[0]}>
            {(version) => (
              <Version model={model()} version={version()} grouped={false} />
            )}
          </Show>
        }
      >
        <ProductListRow
          ref={(button) => register(modelKey(model()), button)}
          tabIndex={tabStop() === modelKey(model()) ? 0 : -1}
          title={<span class="dinkster-model-name">{model().name}</span>}
          description={[
            model().kind,
            strings.modelHere.replace('{count}', String(installed())),
            strings.modelToDownload.replace('{count}', String(missing())),
          ].join(', ')}
          trailing={
            <span class="dinkster-model-size">
              {strings.modelVersions.replace(
                '{count}',
                String(model().versions.length),
              )}
            </span>
          }
          expanded={open()}
          onToggle={(expanded) =>
            setExpandedModels((previous) => {
              const next = new Set(previous)
              if (expanded) next.add(model().id)
              else next.delete(model().id)
              return next
            })
          }
        >
          <ProductList label={model().name} variant="grouped">
            <For each={model().versions}>
              {(version) => (
                <Version model={model()} version={version} grouped />
              )}
            </For>
          </ProductList>
        </ProductListRow>
      </Show>
    )
  }
  return (
    <div class="dinkster-models" onFocusIn={focus} onKeyDown={move}>
      <ProductList label={props.label} variant="plain">
        <For each={props.models}>{(model) => <Model model={model} />}</For>
      </ProductList>
    </div>
  )
}

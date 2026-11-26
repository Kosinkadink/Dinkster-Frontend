import { For, Show, createSignal } from 'solid-js'
import { ChevronDown, ChevronRight, Download } from 'lucide-solid'
import { ProductFacts } from './account.js'
import { ProductIcon, ProductTextButton } from './controls.js'
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
  readonly selected?:
    | { readonly modelId: string; readonly versionId: string }
    | undefined
  readonly onChoose?: (modelId: string, versionId: string) => void
  readonly onDownload?: (modelId: string, versionId: string) => void
  readonly onShowFolder?: (modelId: string, versionId: string) => void
  readonly onCopyName?: (modelId: string, versionId: string) => void
  readonly onHide?: (modelId: string, versionId: string) => void
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
  function Version(propsRow: {
    model: ProductModel
    version: ProductModelVersion
    grouped: boolean
  }) {
    const version = () => propsRow.version
    const model = () => propsRow.model
    const key = () => JSON.stringify([model().id, version().id])
    const open = () => expandedVersions().has(key())
    const title = () => (propsRow.grouped ? version().name : model().name)
    const selected = () =>
      props.selected?.modelId === model().id &&
      props.selected.versionId === version().id
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
    return (
      <ProductListRow
        title={
          <span
            class="dinkster-model-name"
            data-selected={selected() ? '' : undefined}
          >
            {title()}
          </span>
        }
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
          <Show when={progressing()}>
            <div class="dinkster-model-progress">
              <ProductProgress
                label={`${model().name}: ${version().name}`}
                value={version().progress}
              />
            </div>
          </Show>
        }
        trailing={
          <Show when={!downloadable()}>
            <span class="dinkster-model-size">
              {progressing()
                ? (version().message ?? stateLabel())
                : version().size}
            </span>
          </Show>
        }
        action={
          <Show when={downloadable()}>
            <div class="dinkster-model-download">
              <ProductTextButton
                icon={Download}
                label={version().size ?? strings.modelDownload}
                aria-label={`${strings.modelDownload}: ${title()}`}
                intent="add"
                onClick={() => act(props.onDownload)}
              />
            </div>
          </Show>
        }
        expanded={open()}
        onToggle={() => {
          setExpandedVersions((previous) => {
            const next = new Set(previous)
            if (next.has(key())) next.delete(key())
            else next.add(key())
            return next
          })
          if (version().state === 'installed') act(props.onChoose)
        }}
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
          title={<span class="dinkster-model-name">{model().name}</span>}
          description={[
            model().kind,
            strings.modelHere.replace('{count}', String(installed())),
            strings.modelToDownload.replace('{count}', String(missing())),
          ].join(', ')}
          leading={<ProductIcon icon={open() ? ChevronDown : ChevronRight} />}
          trailing={
            <span class="dinkster-model-size">
              {strings.modelVersions.replace(
                '{count}',
                String(model().versions.length),
              )}
            </span>
          }
          expanded={open()}
          onToggle={() =>
            setExpandedModels((previous) => {
              const next = new Set(previous)
              if (next.has(model().id)) next.delete(model().id)
              else next.add(model().id)
              return next
            })
          }
        >
          <ProductList label={model().name} appearance="grouped">
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
    <div class="dinkster-models">
      <ProductList label={props.label} appearance="plain">
        <For each={props.models}>{(model) => <Model model={model} />}</For>
      </ProductList>
    </div>
  )
}

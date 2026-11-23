import { Show, createSignal, onCleanup, type Component } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { Json } from '@dinkster/core'
import { committableAssetRef, formatSize, isCompatible, mediaKindForAccept } from '../asset-browser/helpers.js'
import { localAssetSource } from '../asset-browser/localAssetSource.js'
import { localMountScanAdapter, scanSource } from '../asset-browser/local-mount-logical-model.js'
import { ingestLogicalModels } from '../asset-browser/logical-model-merge.js'
import { logicalModelVariantName } from '../asset-browser/logical-model-collection-source.js'
import { mountAssetSources } from '../asset-browser/mountAssetSource.js'
import type { WidgetEditorImplementationProps } from '../WidgetEditorController.js'
import { inRowValueKept } from '../widget-editor-anchor.js'
import { AssetWidgetEditor } from './AssetWidgetEditor.js'
import { createInRowList, type RowListOption, type RowListSource } from './InRowListEditor.js'

interface StoredAsset {
  readonly digest: string
  readonly name: string
  readonly virtualPath: string
}

const storedAsset = (value: Json | undefined): StoredAsset | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { digest, name, virtualPath } = value as Record<string, Json>
  return typeof digest === 'string' && typeof name === 'string' && typeof virtualPath === 'string'
    ? { digest, name, virtualPath }
    : undefined
}

const nounFor = (kind: string | undefined): string =>
  kind?.startsWith('model/') === true ? 'models'
    : kind === 'media/image' ? 'images'
      : kind === 'media/video' ? 'videos'
        : kind === 'media/audio' ? 'audio files'
          : kind === 'data/latent' ? 'latents' : 'assets'

const errorText = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

/**
 * An asset or model field's list: every entry the field may take now, read
 * once from the same sources and checks as the asset browser. Entries store
 * their canonical reference, never the visible name. Models without a local
 * file are named but cannot be chosen. The browser stays one action away for
 * preparing, uploading and richer search; closing it without storing
 * returns to this list as it was.
 */
const assetRowSource = (props: WidgetEditorImplementationProps, setBrowsing: (open: boolean) => void, browsing: () => boolean): RowListSource => {
  const host = props.editor
  const ed = host.ed
  const spec = ed.spec!
  const accept = Array.isArray(spec.options['accept'])
    ? spec.options['accept'].filter((value): value is string => typeof value === 'string')
    : []
  const kind = typeof spec.kind === 'string' && spec.kind !== '' ? spec.kind : mediaKindForAccept(accept)
  const models = kind?.startsWith('model/') === true
  const noun = nounFor(kind)
  let live = true
  let load = 0
  let abort: AbortController | undefined
  onCleanup(() => { live = false; abort?.abort() })

  const [state, setState] = createSignal<ReturnType<RowListSource['state']>>({ kind: 'loading' })
  const read = async (): Promise<void> => {
    const current = ++load
    abort?.abort()
    const signal = (abort = new AbortController()).signal
    setState({ kind: 'loading' })
    const backend = host.app.backendForTab(ed.tab)
    if (backend.protocol !== 'dinkster') {
      setState({ kind: 'failed', message: `Listing ${noun} requires a native Dinkster backend` })
      return
    }
    try {
      const sources = [localAssetSource(backend.connection), ...await mountAssetSources(backend.connection, kind).catch(() => [])]
      const failures: string[] = []
      let options: RowListOption[]
      if (models) {
        const adapter = await localMountScanAdapter(sources, kind!, accept, { signal, onSourceError: (message) => failures.push(message) })
        options = ingestLogicalModels([adapter]).models.flatMap((model) => model.variants.map((variant): RowListOption => {
          const facts = [
            ...(model.variants.length > 1 ? [logicalModelVariantName(variant)] : []),
            ...(variant.size !== undefined ? [formatSize(variant.size)] : []),
          ]
          return variant.localRef === undefined
            ? { value: `${model.displayName} ${variant.variantId}`, label: model.displayName, info: 'Not on this machine - cannot be chosen', unavailable: true }
            : { value: variant.localRef.virtualPath || variant.localRef.name, label: model.displayName, ...(facts.length > 0 ? { info: facts.join(' / ') } : {}), stores: variant.localRef }
        }))
      } else {
        const scanned = await Promise.all(sources.map((source) => scanSource(source, kind, signal).catch((reason: unknown) => {
          signal.throwIfAborted()
          failures.push(`${source.label}: ${errorText(reason)}`)
          return []
        })))
        options = scanned.flat().flatMap((item): RowListOption[] => {
          const ref = committableAssetRef(item)
          if (ref === undefined || !isCompatible(item, accept, kind)) return []
          const folder = ref.virtualPath.split('/').slice(0, -1).join('/')
          return [{
            value: ref.virtualPath || ref.name,
            label: item.name,
            info: [item.source.label, ...(folder !== '' ? [folder] : []), formatSize(item.size)].join(' / '),
            stores: ref,
          }]
        })
      }
      if (!live || current !== load) return
      setState(failures.length > 0 && failures.length >= sources.length
        ? { kind: 'failed', message: failures.join('; ') }
        : { kind: 'ready', options })
    } catch (reason) {
      if (live && current === load && !signal.aborted) setState({ kind: 'failed', message: errorText(reason) })
    }
  }
  void read()

  return {
    state,
    retry: () => { void read() },
    same: (stored, pick) => {
      const saved = storedAsset(stored)
      const candidate = storedAsset(pick)
      if (saved === undefined || candidate === undefined || saved.digest !== candidate.digest) return false
      return models || saved.virtualPath === '' || saved.virtualPath === candidate.virtualPath
    },
    describe: (stored) => storedAsset(stored)?.name ?? (typeof stored === 'string' ? stored : JSON.stringify(stored)),
    loadingText: `Loading ${noun}`,
    emptyText: `No ${noun} available`,
    more: { label: models ? 'Browse models' : 'Browse all assets', open: () => setBrowsing(true), busy: browsing },
  }
}

export const InRowAssetList: Component<WidgetEditorImplementationProps> = (props) => {
  const host = props.editor
  const [browsing, setBrowsing] = createSignal(false)
  const { inRow: _inRow, ...browserEd } = host.ed
  const List = createInRowList((listProps) => assetRowSource(listProps, setBrowsing, browsing))
  // A store from the browser changes the saved value, which ends this list;
  // the keyboard then stays on the row, as after any pick.
  onCleanup(() => {
    const target = host.ed.target
    if (browsing() && target.kind === 'input' && !inRowValueKept(host.ed, host.ed.tab.store.doc))
      queueMicrotask(() => host.focusRow?.({ nodeId: target.nodeId, valueKey: target.valueKey }))
  })
  return (
    <>
      <List {...props} />
      {/* Outside the pointer-transparent popover layer, as when the browser opens from the canvas. */}
      <Show when={browsing()}><Portal>
        <AssetWidgetEditor
          app={host.app}
          ed={browserEd}
          viewport={host.viewport}
          {...(host.boundary === undefined ? {} : { boundary: host.boundary })}
          {...(host.onAssetBackdropPointerDown === undefined ? {} : { onAssetBackdropPointerDown: host.onAssetBackdropPointerDown })}
          onClose={() => setBrowsing(false)}
        />
      </Portal></Show>
    </>
  )
}

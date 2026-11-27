import { For, Show } from 'solid-js'
import type { CollectionSource } from '@dinkster/core'
import { ProductSegmented, ProductTextButton } from '@dinkster/ui'
import type { CollectionViewMode } from '../collections.js'
import { ProductSelect } from '../ProductSelect.js'
import { useAppMessage } from '../locale.js'

export function AssetBrowserNavigation(props: {
  readonly sources: readonly CollectionSource[]
  readonly selectedId: string
  readonly select: (id: string) => void
  readonly folder: string
  readonly navigate: (path: string) => void
  readonly recursive: boolean
  readonly setRecursive: (value: boolean) => void
  readonly mode: CollectionViewMode
  readonly setMode: (mode: CollectionViewMode) => void
}) {
  const message = useAppMessage()
  const segments = () => props.folder.split('/').filter(Boolean)
  return <div class="asset-browser-navigation">
    <nav class="asset-path" aria-label={message('collection.folder.ariaLabel')}>
      <ProductSelect class="asset-source-select" testId="asset-source-select" ariaLabel={message('assets.mounts.label')}
        selectedId={props.selectedId} options={props.sources.map((source) => ({
          id: source.id, label: source.id === 'all-mounts' ? message('assets.mounts.all') : source.label, value: source.id,
        }))}
        onReselect={() => props.navigate('')}
        onSelect={(option) => { props.setRecursive(true); props.select(option.value) }} />
      <div class="asset-path-segments"><For each={segments()}>{(part, index) => <>
        <span aria-hidden="true">/</span>
        <Show when={index() < segments().length - 1} fallback={<span aria-current="page">{part}</span>}>
          <ProductTextButton label={part} onClick={() => props.navigate(segments().slice(0, index() + 1).join('/'))} />
        </Show>
      </>}</For></div>
    </nav>
    <div class="asset-view-controls">
      <Show when={props.selectedId !== 'all-mounts'}>
        <ProductSegmented label={message('assets.depth.label')} value={String(props.recursive)} onChange={(value) => props.setRecursive(value === 'true')}
          options={[{ value: 'false', label: message('assets.depth.this') }, { value: 'true', label: message('assets.depth.subfolders') }]} />
      </Show>
      <div class="asset-view-switch">
        <ProductSegmented label={message('assets.view.label')} value={props.mode} onChange={(value) => props.setMode(value as CollectionViewMode)}
          options={[{ value: 'list', label: message('assets.view.names') }, { value: 'grid', label: message('assets.view.pictures') }]} />
      </div>
    </div>
    <p class="asset-scope" data-testid="asset-scope">{message(props.recursive ? 'assets.scope.subfolders' : 'assets.scope.this', {
      path: `${props.selectedId === 'all-mounts' ? message('assets.mounts.all') : props.selectedId.slice('mount:'.length)}${props.folder ? `/${props.folder}` : ''}`,
    })}</p>
  </div>
}

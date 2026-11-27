import { For, Show, createSignal } from 'solid-js'
import {
  ProductButton,
  ProductDialog,
  ProductErrorBanner,
  ProductField,
  ProductModelDownloads,
  ProductRadio,
  ProductTextInput,
  ProductToast,
  type ProductModelDownloadRow,
} from '../src/index.js'

const scenes = [
  ['ready', 'Ready to download'],
  ['needs', 'A model needs something'],
  ['access', 'Sign in and file access'],
  ['waiting', 'Waiting'],
  ['downloading', 'Downloading'],
  ['failed', 'One failed'],
  ['run', 'All ready with Run'],
  ['done', 'All ready without Run'],
  ['many', 'Twelve models'],
] as const
type Scene = (typeof scenes)[number][0]

const files = [
  {
    id: 'base',
    name: 'sd_xl_base_1.0.safetensors',
    metadata: '6.4 GB - Hugging Face',
    folder: 'checkpoints',
  },
  {
    id: 'vae',
    name: 'sdxl_vae.safetensors',
    metadata: '320 MB - Hugging Face',
    folder: 'vae',
  },
  {
    id: 'upscale',
    name: '4x-UltraSharp.pth',
    metadata: '64 MB - Civitai',
    folder: 'upscale_models',
  },
] as const

function SourceChoices(props: {
  readonly sources: readonly string[]
  readonly onCheck: (source: string) => void
}) {
  const [source, setSource] = createSignal('')
  return (
    <div class="dinkster-model-download-source">
      <For each={props.sources}>
        {(url) => (
          <ProductRadio
            name="gallery-model-source"
            label={url}
            checked={source() === url}
            onChange={() => setSource(url)}
          />
        )}
      </For>
      <div class="dinkster-model-download-source-check">
        <ProductField label="Or paste a Hugging Face or Civitai file address">
          {(attributes) => (
            <ProductTextInput
              id={attributes.id}
              type="url"
              value={source()}
              onInput={(event) => setSource(event.currentTarget.value)}
            />
          )}
        </ProductField>
        <ProductButton
          disabled={!source()}
          onClick={() => props.onCheck(source())}
        >
          Check
        </ProductButton>
      </div>
    </div>
  )
}

function DownloadExample(props: {
  readonly scene: Scene
  readonly onClose: () => void
}) {
  const [selected, setSelected] = createSignal(
    new Set(
      props.scene === 'many'
        ? Array.from({ length: 12 }, (_, index) => `model-${index}`)
        : files.map((file) => file.id as string),
    ),
  )
  const [sourceOpen, setSourceOpen] = createSignal<string>()
  const [action, setAction] = createSignal('')
  const [copied, setCopied] = createSignal<{ message: string }>()
  const [copyError, setCopyError] = createSignal('')
  const [stopped, setStopped] = createSignal(false)
  const [waitingStopped, setWaitingStopped] = createSignal(false)
  const locations = [
    { id: 'shared', name: 'Shared models', path: '/models/shared' },
    { id: 'portable', name: 'Portable models', path: '/media/portable/models' },
  ]
  const [locationId, setLocationId] = createSignal('shared')
  const destination = () =>
    locations.find((location) => location.id === locationId())!
  const select = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  const available = (
    index: number,
  ): Extract<ProductModelDownloadRow, { state: 'available' }> => ({
    ...files[index]!,
    state: 'available',
    selected: selected().has(files[index]!.id),
    onSelect: (checked) => select(files[index]!.id, checked),
    detailsLabel: `Details for ${files[index]!.name}`,
    initiallyExpanded: false,
    facts: [
      {
        label: 'From',
        value: `example/models on ${index === 2 ? 'Civitai' : 'Hugging Face'}`,
      },
      { label: 'License', value: 'Apache-2.0' },
      {
        label: 'File',
        value: `${destination().path}/${files[index]!.folder}/${files[index]!.name}`,
      },
    ],
    factsAction: {
      label: 'Copy revision and checksum',
      onClick: () => {
        setCopyError('')
        void navigator.clipboard
          .writeText(
            `Revision: 462165984030deed462165984030deed46216598\nSHA-256: ${'31e35c80fc4829d1'.repeat(4)}`,
          )
          .then(() => setCopied({ message: 'Revision and checksum copied' }))
          .catch(() =>
            setCopyError(
              'Could not copy the revision and checksum. Try again.',
            ),
          )
      },
    },
  })
  const ready = (index: number): ProductModelDownloadRow => ({
    ...files[index]!,
    state: 'ready',
    readyLabel: 'Ready',
    metadata: `${files[index]!.metadata} - ${index === 1 ? 'an identical file was already here' : `saved to ${destination().path}/${files[index]!.folder}`}`,
  })
  const needs = (id: string, reason: string, label: string) => ({
    id,
    name: `${id}.safetensors`,
    metadata: 'Diffusion model',
    state: 'needs' as const,
    reason,
    action: { label, onClick: () => setAction(`${label} for ${id}`) },
  })
  const rows = (): readonly ProductModelDownloadRow[] => {
    if (props.scene === 'access')
      return [
        needs(
          'huggingface-sign-in',
          'Not signed in to Hugging Face',
          'Sign in',
        ),
        needs(
          'huggingface-access',
          'No access to this file on Hugging Face',
          'Open Hugging Face',
        ),
        needs(
          'civitai-access',
          'No access to this file on Civitai',
          'Open Civitai',
        ),
      ]
    if (props.scene === 'waiting')
      return [
        {
          ...files[0],
          state: 'downloading',
          progress: 0.17,
          progressLabel: 'Downloading - 1.1 GB of 6.4 GB',
          stop: {
            label: 'Stop',
            onClick: () => setAction('Stop requested for base'),
          },
        },
        waitingStopped()
          ? { ...available(1), selected: false }
          : {
              ...files[1],
              state: 'waiting',
              progressLabel: 'Waiting',
              stop: { label: 'Stop', onClick: () => setWaitingStopped(true) },
            },
        ready(2),
      ]
    if (props.scene === 'many')
      return Array.from({ length: 12 }, (_, index) => ({
        ...available(index % files.length),
        id: `model-${index}`,
        name: `model-${index + 1}.safetensors`,
        metadata: '2.3 GB - Hugging Face',
        selected: selected().has(`model-${index}`),
        onSelect: (checked: boolean) => select(`model-${index}`, checked),
        initiallyExpanded: index === 0,
      }))
    if (props.scene === 'ready')
      return files.map((_, index) => available(index))
    if (props.scene === 'needs')
      return [
        {
          ...needs('unknown-source', 'No known source', 'Choose a source'),
          action: {
            label: 'Choose a source',
            onClick: () =>
              setSourceOpen(
                sourceOpen() === 'unknown-source'
                  ? undefined
                  : 'unknown-source',
              ),
          },
          details: (
            <Show when={sourceOpen() === 'unknown-source'}>
              <SourceChoices
                sources={[]}
                onCheck={(source) => setAction(`Checked ${source}`)}
              />
            </Show>
          ),
        },
        {
          ...needs(
            'several-sources',
            'More than one source',
            'Choose a source',
          ),
          action: {
            label: 'Choose a source',
            onClick: () =>
              setSourceOpen(
                sourceOpen() === 'several-sources'
                  ? undefined
                  : 'several-sources',
              ),
          },
          details: (
            <Show when={sourceOpen() === 'several-sources'}>
              <SourceChoices
                sources={[
                  'https://huggingface.co/stabilityai/sdxl-vae/resolve/main/sdxl_vae.safetensors',
                  'https://civitai.com/models/101055',
                ]}
                onCheck={(source) => setAction(`Checked ${source}`)}
              />
            </Show>
          ),
        },
        needs('no-destination', 'No folder to save it in', 'Choose a folder'),
        needs(
          'disabled-folder',
          'Already in /mnt/models/vae',
          'Use that folder',
        ),
        needs(
          'duplicate-model',
          'Two files have this name',
          'Choose one on the node',
        ),
        needs('hidden-model', 'Hidden on this computer', 'Show it'),
        needs(
          'host-permission',
          'No access to this file on Hugging Face',
          'Open Hugging Face',
        ),
      ]
    if (props.scene === 'downloading')
      return [
        stopped()
          ? {
              ...files[0],
              state: 'failed',
              reason: 'The download was stopped.',
              action: { label: 'Try again', onClick: () => setStopped(false) },
            }
          : {
              ...files[0],
              state: 'downloading',
              progress: 0.17,
              progressLabel: 'Downloading - 1.1 GB of 6.4 GB',
              stop: { label: 'Stop', onClick: () => setStopped(true) },
            },
        { ...files[1], state: 'checking', progressLabel: 'Checking the file' },
        ready(2),
      ]
    if (props.scene === 'failed')
      return [
        {
          ...files[0],
          state: 'failed',
          reason: 'The download stopped at 1.2 GB.',
          action: {
            label: 'Try again',
            onClick: () => setAction('Retry requested'),
          },
        },
        ready(1),
        ready(2),
      ]
    return files.map((_, index) => ready(index))
  }
  const allReady = () => props.scene === 'run' || props.scene === 'done'
  const count = () => selected().size
  const insufficient = () =>
    (props.scene === 'many' && count() > 8) ||
    (props.scene === 'ready' && count() > 0 && locationId() === 'portable')
  const primary = () =>
    props.scene === 'ready' || props.scene === 'many'
      ? {
          label: `Download ${count()} ${count() === 1 ? 'model' : 'models'}`,
          disabled: count() === 0 || insufficient(),
          onClick: () => setAction(`Download requested for ${count()} models`),
        }
      : props.scene === 'run'
        ? { label: 'Run', onClick: () => setAction('Run requested') }
        : undefined
  return (
    <ProductDialog
      title="Download models"
      size="wide"
      onDismiss={props.onClose}
    >
      <ProductModelDownloads
        rows={rows()}
        listLabel="Models"
        notice={
          <>
            <Show when={copyError()}>
              <ProductErrorBanner onDismiss={() => setCopyError('')}>
                {copyError()}
              </ProductErrorBanner>
            </Show>
            <ProductToast
              notification={copied()}
              onDismiss={() => setCopied(undefined)}
            />
          </>
        }
        destination={{
          label: 'Save to',
          selectedId: locationId(),
          emptyLabel: 'Choose a folder',
          freeSpace: locationId() === 'portable' ? '200 MB free' : '20 GB free',
          locations,
          onSelect: setLocationId,
        }}
        summary={
          allReady()
            ? 'Image starter has every model it needs.'
            : `Image starter needs ${rows().filter((row) => row.state !== 'ready').length} models that are not ${props.scene === 'needs' || props.scene === 'access' ? 'ready on' : 'on'} this computer.`
        }
        footer={
          insufficient()
            ? `${props.scene === 'many' ? count() * 2.25 : 6.8} GB to download, ${locationId() === 'portable' ? '200 MB' : '20 GB'} free. Untick some models or free up space.`
            : action() ||
              (props.scene === 'downloading' || props.scene === 'waiting'
                ? 'You can close this. Downloads keep going and show under tasks in the status bar.'
                : allReady()
                  ? '3 models ready.'
                  : props.scene === 'ready'
                    ? '6.8 GB to download'
                    : props.scene === 'failed'
                      ? ''
                      : 'Nothing can be downloaded yet.')
        }
        footerWarning={insufficient()}
        closeLabel="Close"
        onClose={props.onClose}
        {...(props.scene === 'ready' || props.scene === 'many'
          ? {
              selection: {
                label: count() === rows().length ? 'Select none' : 'Select all',
                onClick: () =>
                  setSelected(
                    count() === rows().length
                      ? new Set<string>()
                      : new Set(rows().map((row) => row.id)),
                  ),
              },
            }
          : {})}
        {...(primary() ? { primary: primary()! } : {})}
      />
    </ProductDialog>
  )
}

export function ModelDownloadsGallery() {
  const requested = new URLSearchParams(window.location.search).get(
    'downloadState',
  )
  const [scene, setScene] = createSignal<Scene | undefined>(
    scenes.find(([key]) => key === requested)?.[0],
  )
  return (
    <main class="dinkster-model-download-gallery">
      <h1 class="dinkster-title">Download models</h1>
      <p class="dinkster-description">
        Product components with example models. Actions stay in this gallery; no
        model is downloaded and no workflow is run.
      </p>
      <div class="dinkster-actions">
        <For each={scenes}>
          {([key, label]) => (
            <div class="dinkster-stack">
              <ProductButton onClick={() => setScene(key)}>
                {label}
              </ProductButton>
              <p class="dinkster-description">
                {key === 'run'
                  ? 'Opened after a run stopped for missing models.'
                  : 'Opened from Problems: Download models.'}
              </p>
            </div>
          )}
        </For>
      </div>
      <Show when={scene()} keyed>
        {(current) => (
          <DownloadExample
            scene={current}
            onClose={() => setScene(undefined)}
          />
        )}
      </Show>
    </main>
  )
}

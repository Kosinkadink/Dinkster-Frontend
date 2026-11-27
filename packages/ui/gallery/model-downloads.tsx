import { For, Show, createSignal } from 'solid-js'
import { formatByteProgress, formatByteSize } from '@dinkster/core'
import {
  ProductButton,
  ProductDialog,
  ProductField,
  ProductModelDownloads,
  ProductRadio,
  ProductTextInput,
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

const files = (
  [
    {
      id: 'base',
      name: 'sd_xl_base_1.0.safetensors',
      kind: 'Checkpoint',
      bytes: 6_900_000_000,
      source: 'Hugging Face, stabilityai/stable-diffusion-xl-base-1.0',
    },
    {
      id: 'vae',
      name: 'sdxl_vae.safetensors',
      kind: 'VAE',
      bytes: 335_000_000,
      source: 'Hugging Face, stabilityai/sdxl-vae',
    },
    {
      id: 'upscale',
      name: '4x-UltraSharp.pth',
      kind: 'Upscale model',
      bytes: 67_000_000,
      source: 'Civitai, 4x-UltraSharp',
    },
  ] as const
).map((file) => ({
  ...file,
  metadata: `${file.kind} - ${formatByteSize(file.bytes)} - ${file.source}`,
}))
const freeBytes = 20 * 1024 ** 3
const manyModelBytes = 2.25 * 1024 ** 3
const receivedBytes = 1_200_000_000
const downloadProgress = formatByteProgress(receivedBytes, files[0]!.bytes)
const downloadProgressLabel = `Downloading - ${downloadProgress.received} of ${downloadProgress.total}`

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
  const [stopped, setStopped] = createSignal(false)
  const [waitingStopped, setWaitingStopped] = createSignal(false)
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
    initiallyExpanded: index === 0,
    facts: [
      {
        label: 'From',
        value: 'Hugging Face, stabilityai/stable-diffusion-xl-base-1.0',
      },
      { label: 'Version', value: '462165984030deed462165984030deed46216598' },
      { label: 'License', value: 'openrail++' },
      { label: 'Saves to', value: '/home/you/Dinkster/models/checkpoints/' },
      { label: 'Checked by', value: `SHA-256 ${'31e35c80fc4829d1'.repeat(4)}` },
    ],
  })
  const ready = (index: number): ProductModelDownloadRow => ({
    ...files[index]!,
    state: 'ready',
    readyLabel: 'Ready',
    metadata: `${files[index]!.metadata} - ${index === 1 ? 'an identical file was already here' : 'saved to /home/you/Dinkster/models/'}`,
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
          ...files[0]!,
          state: 'downloading',
          progress: receivedBytes / files[0]!.bytes,
          progressLabel: downloadProgressLabel,
          stop: {
            label: 'Stop',
            onClick: () => setAction('Stop requested for base'),
          },
        },
        waitingStopped()
          ? { ...available(1), selected: false }
          : {
              ...files[1]!,
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
        metadata: `Checkpoint - ${formatByteSize(manyModelBytes)} - Hugging Face, example/models`,
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
              ...files[0]!,
              state: 'failed',
              reason: 'The download was stopped.',
              action: { label: 'Try again', onClick: () => setStopped(false) },
            }
          : {
              ...files[0]!,
              state: 'downloading',
              progress: receivedBytes / files[0]!.bytes,
              progressLabel: downloadProgressLabel,
              stop: { label: 'Stop', onClick: () => setStopped(true) },
            },
        { ...files[1]!, state: 'checking', progressLabel: 'Checking the file' },
        ready(2),
      ]
    if (props.scene === 'failed')
      return [
        {
          ...files[0]!,
          state: 'failed',
          reason: `The download stopped at ${formatByteSize(receivedBytes)}.`,
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
  const downloadBytes = () =>
    props.scene === 'many'
      ? count() * manyModelBytes
      : files.reduce(
          (total, file) => total + (selected().has(file.id) ? file.bytes : 0),
          0,
        )
  const insufficient = () =>
    props.scene === 'many' && downloadBytes() > freeBytes
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
        summary={
          allReady()
            ? 'Image starter has every model it needs.'
            : `Image starter needs ${rows().filter((row) => row.state !== 'ready').length} models that are not ${props.scene === 'needs' || props.scene === 'access' ? 'ready on' : 'on'} this computer.`
        }
        footer={
          action() ||
          (insufficient()
            ? `${formatByteSize(downloadBytes())} to download, ${formatByteSize(freeBytes)} free. Untick some models or free up space.`
            : props.scene === 'downloading' || props.scene === 'waiting'
              ? 'You can close this. Downloads keep going and show under tasks in the status bar.'
              : allReady()
                ? '3 models ready.'
                : props.scene === 'ready'
                  ? `${formatByteSize(downloadBytes())} to download - ${formatByteSize(freeBytes)} free`
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

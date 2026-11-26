import { For, Show, createSignal } from 'solid-js'
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
  ['downloading', 'Downloading'],
  ['failed', 'One failed'],
  ['run', 'All ready with Run'],
  ['done', 'All ready without Run'],
] as const
type Scene = (typeof scenes)[number][0]

const files = [
  {
    id: 'base',
    name: 'sd_xl_base_1.0.safetensors',
    metadata:
      'Checkpoint - 6.9 GB - Hugging Face, stabilityai/stable-diffusion-xl-base-1.0',
  },
  {
    id: 'vae',
    name: 'sdxl_vae.safetensors',
    metadata: 'VAE - 335 MB - Hugging Face, stabilityai/sdxl-vae',
  },
  {
    id: 'upscale',
    name: '4x-UltraSharp.pth',
    metadata: 'Upscale model - 67 MB - Civitai, 4x-UltraSharp',
  },
] as const

function SourceChoices(props: { readonly onCheck: (source: string) => void }) {
  const [source, setSource] = createSignal('')
  const sources = [
    'https://huggingface.co/stabilityai/sdxl-vae/resolve/main/sdxl_vae.safetensors',
    'https://civitai.com/models/101055',
  ]
  return (
    <div class="dinkster-model-download-source">
      <For each={sources}>
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
        <ProductField label="Or paste the file's address">
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
    new Set(files.map((file) => file.id as string)),
  )
  const [sourceOpen, setSourceOpen] = createSignal(false)
  const [action, setAction] = createSignal('')
  const [stopped, setStopped] = createSignal(false)
  const select = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  const available = (index: number): ProductModelDownloadRow => ({
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
    if (props.scene === 'ready')
      return files.map((_, index) => available(index))
    if (props.scene === 'needs')
      return [
        {
          ...needs('unknown-source', 'No known source', 'Choose a source'),
          action: {
            label: 'Choose a source',
            onClick: () => setSourceOpen(!sourceOpen()),
          },
          details: (
            <Show when={sourceOpen()}>
              <SourceChoices
                onCheck={(source) => setAction(`Checked ${source}`)}
              />
            </Show>
          ),
        },
        needs('several-sources', 'More than one source', 'Choose a source'),
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
          'Its license must be accepted first',
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
              progressLabel: 'Downloading - 1.2 GB of 6.9 GB',
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
  const primary = () =>
    props.scene === 'ready' && count() > 0
      ? {
          label: `Download ${count()} ${count() === 1 ? 'model' : 'models'}`,
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
            : `Image starter needs ${rows().filter((row) => row.state !== 'ready').length} models that are not ${props.scene === 'needs' ? 'ready on' : 'on'} this computer.`
        }
        footer={
          action() ||
          (props.scene === 'downloading'
            ? 'You can close this. Downloads keep going and show under tasks in the status bar.'
            : allReady()
              ? '3 models ready.'
              : props.scene === 'ready'
                ? 'Nothing downloads until you press Download.'
                : props.scene === 'failed'
                  ? '2 of 3 models are ready.'
                  : 'Nothing can be downloaded yet.')
        }
        closeLabel="Close"
        onClose={props.onClose}
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
            <ProductButton onClick={() => setScene(key)}>{label}</ProductButton>
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

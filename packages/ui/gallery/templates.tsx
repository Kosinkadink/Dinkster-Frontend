import { For, Show, createMemo, createSignal } from 'solid-js'
import { Download } from 'lucide-solid'
import type { CanvasGalleryPage } from '../../canvas/gallery/fixtures.js'
import {
  ProductButton,
  ProductField,
  ProductIcon,
  ProductPage,
  ProductSelect,
  ProductTemplateDetail,
  ProductTemplateTiles,
  ProductTemplatesPage,
  type ProductTemplateEntry,
  type ProductTemplateGroup,
} from '../src/index.js'
import { WorkflowPicture } from './projects.js'

type Makes = 'image' | 'video' | 'audio' | 'tool'

interface MockModel {
  name: string
  size: string
  gigabytes: number
  here: boolean
}

interface MockTemplate extends ProductTemplateEntry {
  makes: Makes
  description: string
  scene: CanvasGalleryPage
  models: readonly MockModel[]
  pack: string
  version: string
  from: string
}

const makesLabels: Record<Makes, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  tool: 'Loops and tools',
}

const model = (name: string, gigabytes: number, here: boolean): MockModel => ({
  name,
  size: `${gigabytes.toFixed(1)} GB`,
  gigabytes,
  here,
})
const sd15 = [model('v1-5-pruned-emaonly.safetensors', 4.3, true)]
const sdxl = (here: boolean) => [
  model('sd_xl_base_1.0.safetensors', 6.9, true),
  model('sd_xl_inpaint_0.1.safetensors', 5.1, here),
  model('sdxl_vae.safetensors', 1.3, here),
]
const h3 = [
  model('minimax_h3_video.safetensors', 12.6, false),
  model('minimax_h3_text_encoder.safetensors', 1.6, false),
]

const missing = (models: readonly MockModel[]) => {
  const left = models.filter((entry) => !entry.here)
  const amount = left.reduce((total, entry) => total + entry.gigabytes, 0)
  return left.length > 0 ? `${amount.toFixed(1)} GB` : undefined
}

const generation = { pack: 'Generation', version: '0.4.2', from: 'Built in' }
const loops = { pack: 'Loops', version: '0.2.0', from: 'Built in' }

/** Example data only: names, pictures, sizes and counts stand in for real templates. */
const mockTemplates: readonly MockTemplate[] = ([
  {
    id: 'text-to-image',
    name: 'Text to image',
    family: 'SD 1.5',
    makes: 'image',
    picture: 'templates/valley.jpg',
    description: 'Describe a picture in words and get it back.',
    scene: 'structure',
    models: sd15,
    ...generation,
  },
  {
    id: 'image-to-image',
    name: 'Image to image',
    family: 'SD 1.5',
    makes: 'image',
    picture: 'templates/teapot.jpg',
    description: 'Start from a picture you have and change it with words.',
    scene: 'anatomy',
    models: sd15,
    ...generation,
  },
  {
    id: 'inpaint-a-region',
    name: 'Inpaint a region',
    family: 'SDXL',
    makes: 'image',
    picture: 'templates/bookshop.jpg',
    description:
      'Paint over part of a picture and describe what goes there. The rest of the picture is kept.',
    scene: 'previews',
    models: sdxl(false),
    ...generation,
  },
  {
    id: 'upscale-2x',
    name: 'Upscale 2x',
    family: 'Upscale model',
    makes: 'image',
    picture: 'templates/diner.jpg',
    description: 'Make a picture twice as large and keep its detail.',
    scene: 'titles',
    models: [model('4x-UltraSharp.pth', 0.1, true)],
    ...generation,
  },
  {
    id: 'text-to-video',
    name: 'Text to video',
    family: 'MiniMax H3',
    makes: 'video',
    picture: 'templates/diner.jpg',
    length: '0:05',
    description: 'Describe a short scene in words and get a five second video.',
    scene: 'boundary',
    models: h3,
    ...generation,
  },
  {
    id: 'image-to-video',
    name: 'Image to video',
    family: 'MiniMax H3',
    makes: 'video',
    picture: 'templates/valley.jpg',
    length: '0:05',
    description: 'Bring a still picture to life as a short video.',
    scene: 'widget-driven',
    models: h3,
    ...generation,
  },
  {
    id: 'portrait-with-a-control-picture',
    name: 'Portrait with a control picture',
    family: 'SDXL',
    makes: 'image',
    picture: 'templates/teapot.jpg',
    progress: 0.41,
    description:
      'Keep the pose and outline of a control picture and paint a new portrait over it.',
    scene: 'anatomy',
    models: sdxl(false),
    ...generation,
  },
  {
    id: 'run-a-workflow-over-a-list',
    name: 'Run a workflow over a list',
    family: 'No models',
    makes: 'tool',
    description: 'Run the same steps once for each item of a list and collect the results.',
    scene: 'structure',
    models: [],
    ...loops,
  },
  {
    id: 'repeat-until-a-condition',
    name: 'Repeat until a condition',
    family: 'No models',
    makes: 'tool',
    description: 'Run steps again and again until a condition you choose is met.',
    scene: 'boundary',
    models: [],
    ...loops,
  },
  {
    id: 'song-from-lyrics',
    name: 'Song from lyrics',
    family: 'ACE-Step',
    makes: 'audio',
    description: 'Write lyrics and a style and get a song back.',
    scene: 'widget-driven',
    models: [model('ace_step_v1_3.5b.safetensors', 7.7, true)],
    ...generation,
  },
  {
    id: 'sketch-to-image',
    name: 'Sketch to image',
    family: 'SDXL',
    makes: 'image',
    picture: 'templates/bookshop.jpg',
    description: 'Turn a rough sketch into a finished picture.',
    scene: 'previews',
    models: sdxl(true),
    ...generation,
  },
  {
    id: 'batch-of-prompts',
    name: 'Batch of prompts',
    family: 'No models',
    makes: 'tool',
    description: 'Feed a list of prompts into any workflow, one run each.',
    scene: 'titles',
    models: [],
    ...loops,
  },
] satisfies readonly MockTemplate[]).map((template: MockTemplate) =>
  template.progress !== undefined
    ? template
    : { ...template, missing: missing(template.models) },
)

const states = {
  ready: 'Ready',
  loading: 'Loading',
} as const

const drawing = (entry: ProductTemplateEntry) => (
  <WorkflowPicture
    scene={
      mockTemplates.find((template) => template.id === entry.id)?.scene ??
      'structure'
    }
  />
)

/**
 * The Templates page as it opens in a tab: groups by what a template makes
 * and its model family, the tiles, and the selected template explained.
 * Every name, picture, size and count is example data.
 */
export function TemplatesGallery() {
  const [state, setState] = createSignal<keyof typeof states>('ready')
  const [group, setGroup] = createSignal('all')
  const [search, setSearch] = createSignal('')
  const [selected, setSelected] = createSignal('inpaint-a-region')
  const [view, setView] = createSignal<'result' | 'workflow'>('result')
  const [downloads, setDownloads] = createSignal<ReadonlyMap<string, number>>(
    new Map(),
  )
  const [activity, setActivity] = createSignal('No action yet')

  const all = (): MockTemplate[] =>
    mockTemplates.map((template) => {
      const progress = downloads().get(template.id)
      return progress === undefined
        ? template
        : { ...template, missing: undefined, progress }
    })
  const inGroup = (template: MockTemplate, id: string) =>
    id === 'all' ||
    id === `makes:${template.makes}` ||
    id === `family:${template.family}`
  const groups = createMemo(() => {
    const templates = all()
    const count = (id: string) =>
      templates.filter((template) => inGroup(template, id)).length
    const makes = (Object.keys(makesLabels) as Makes[])
      .map((id) => ({ id: `makes:${id}`, label: makesLabels[id] }))
      .filter((row) => count(row.id) > 0)
    const families = [
      ...new Set(templates.map((template) => template.family)),
    ]
      .sort((a, b) =>
        a === 'No models' ? 1 : b === 'No models' ? -1 : a.localeCompare(b),
      )
      .map((family) => ({ id: `family:${family}`, label: family }))
    const rows = (list: { id: string; label: string }[]) =>
      list.map((row): ProductTemplateGroup => ({ ...row, count: count(row.id) }))
    return [
      { label: 'Makes', rows: rows([{ id: 'all', label: 'All' }, ...makes]) },
      { label: 'Model family', rows: rows(families) },
    ]
  })
  const shown = () => {
    if (state() === 'loading') return undefined
    const query = search().trim().toLowerCase()
    return all().filter(
      (template) =>
        inGroup(template, group()) &&
        (query === '' ||
          [template.name, template.family, template.description].some(
            (text) => text.toLowerCase().includes(query),
          )),
    )
  }
  const current = () =>
    state() === 'loading'
      ? undefined
      : all().find((template) => template.id === selected())
  const open = (id: string) =>
    setActivity(
      `Opened ${all().find((template) => template.id === id)?.name ?? id}`,
    )

  return (
    <main class="dinkster-page dinkster-stack" data-testid="templates-gallery">
      <div class="dinkster-templates-frame dinkster-root" data-theme="dark">
        <ProductTemplatesPage
          title="Templates"
          groups={groups()}
          group={group()}
          onGroup={setGroup}
          searchLabel="Search templates"
          search={search()}
          onSearch={setSearch}
          leave={
            <ProductButton onClick={() => setActivity('Blank workflow opened')}>
              Blank workflow
            </ProductButton>
          }
          templates={shown()}
          selected={selected()}
          onSelect={(id) => {
            setSelected(id)
            setView('result')
          }}
          onOpen={open}
          drawing={drawing}
          loadingLabel="Loading templates"
          empty="No template matches. Try other words or another group."
        >
          <Show when={current()}>
            {(template) => {
              const left = () => template().models.filter((entry) => !entry.here)
              return (
                <ProductTemplateDetail
                  template={template()}
                  drawing={drawing}
                  view={view()}
                  onView={setView}
                  viewLabels={{ result: 'Result', workflow: 'Workflow' }}
                  summary={`${template().family} - ${makesLabels[template().makes]}`}
                  description={template().description}
                  needs={
                    template().models.length > 0
                      ? {
                          label: 'Needs',
                          summary: `${template().models.length - left().length} of ${template().models.length} on this computer`,
                          hereLabel: 'Here',
                          missingLabel: 'Missing',
                          models: template().models,
                        }
                      : undefined
                  }
                  facts={[
                    {
                      label: 'Pack',
                      value: template().pack,
                      detail: template().version,
                    },
                    { label: 'From', value: template().from },
                  ]}
                  actions={
                    <>
                      <ProductButton
                        fill="solid"
                        onClick={() => open(template().id)}
                      >
                        Use template
                      </ProductButton>
                      <Show when={template().missing}>
                        {(amount) => (
                          <ProductButton
                            onClick={() => {
                              setDownloads(
                                new Map([
                                  ...downloads(),
                                  [template().id, 0.12],
                                ]),
                              )
                              setActivity(
                                `Downloading ${left().length} models for ${template().name}`,
                              )
                            }}
                          >
                            <ProductIcon icon={Download} />
                            {`Download ${left().length} ${left().length === 1 ? 'model' : 'models'}`}
                            <span class="dinkster-template-fact-detail">
                              {amount()}
                            </span>
                          </ProductButton>
                        )}
                      </Show>
                    </>
                  }
                />
              )
            }}
          </Show>
        </ProductTemplatesPage>
      </div>
      <section class="dinkster-stack" aria-labelledby="template-tile-states">
        <h2 id="template-tile-states" class="dinkster-heading">
          A tile, in each state
        </h2>
        <p class="dinkster-description">
          A ready tile says nothing about models. Missing models show how much there is to download, which becomes a percentage with a thin line while downloading. A template with no picture shows its workflow, drawn as the minimap draws one. Selected has the fill and a mark; under the pointer has the fill only.
        </p>
        <div class="dinkster-template-states">
          <For
            each={
              [
                ['Ready', 'text-to-image'],
                ['Models missing', 'inpaint-a-region'],
                ['Downloading', 'portrait-with-a-control-picture'],
                ['No picture', 'run-a-workflow-over-a-list'],
                ['Selected', 'image-to-image'],
              ] as const
            }
          >
            {([label, id]) => (
              <div>
                <ProductTemplateTiles
                  label={label}
                  templates={mockTemplates.filter(
                    (template) => template.id === id,
                  )}
                  selected={label === 'Selected' ? id : undefined}
                  onSelect={() => undefined}
                  onOpen={open}
                  drawing={drawing}
                />
                <span class="dinkster-metadata">{label}</span>
              </div>
            )}
          </For>
        </div>
      </section>
      <ProductPage
        title="Templates page"
        description="It opens in a tab, like a workflow does. Groups on the left, pictures in the middle, and the one you clicked explained on the right. One click selects, a double click, Enter or Use template opens it. Every name, picture, size and count is example data."
      >
        <ProductField label="State">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={state()}
              onChange={(event) =>
                setState(event.currentTarget.value as keyof typeof states)
              }
            >
              <For each={Object.entries(states)}>
                {([value, label]) => <option value={value}>{label}</option>}
              </For>
            </ProductSelect>
          )}
        </ProductField>
        <p role="status">{activity()}</p>
      </ProductPage>
    </main>
  )
}

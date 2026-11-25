import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from 'solid-js'
import {
  AudioLines,
  BookOpen,
  Database,
  Ellipsis,
  Eye,
  EyeOff,
  LayoutGrid,
  Search,
  Server,
  Settings,
  Workflow,
} from 'lucide-solid'
import { registerCatalog } from '@dinkster/core'
import english from '../../app/src/locales/en.json'
import {
  canvasColorsForTheme,
  canvasPaintTokens,
  canvasTypePaintForTheme,
  defaultTokens,
  drawMinimapGraph,
  type DesignTokens,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import {
  createWidgetRegistry,
  registerCoreWidgets,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import {
  createCanvasGalleryFixture,
  type CanvasGalleryPage,
} from '../../canvas/gallery/fixtures.js'
import {
  ProductAccountMenu,
  ProductBrandMark,
  ProductButton,
  ProductCheckbox,
  ProductConfirmation,
  ProductDialog,
  ProductEmptyState,
  ProductErrorBanner,
  ProductField,
  ProductIcon,
  ProductIconButton,
  ProductMenu,
  ProductPage,
  ProductProjectFacts,
  ProductProjectHeader,
  ProductProjectList,
  ProductProjectSection,
  ProductProjectsView,
  ProductSegmented,
  ProductSelect,
  ProductSkeleton,
  ProductTextButton,
  ProductTextInput,
  ProductTile,
  ProductTileGrid,
  ProductWindowAction,
  ProductWindowToolbar,
  type ProductProjectEntry,
} from '../src/index.js'

interface MockWorkflow {
  name: string
  date: string
  scene: CanvasGalleryPage
}
interface MockOutput {
  name: string
  kind: 'image' | 'audio'
  hue: number
}
interface MockProject {
  id: string
  name: string
  opened: string
  path: string
  runsOn: string
  packs: string
  size: string
  outputCount: string
  workflows: readonly MockWorkflow[]
  outputs: readonly MockOutput[]
}

const scenes: readonly CanvasGalleryPage[] = [
  'structure',
  'anatomy',
  'previews',
  'boundary',
  'titles',
  'widget-driven',
]
const workflows = (names: readonly [string, string][]) =>
  names.map(([name, date], index) => ({
    name,
    date,
    scene: scenes[index % scenes.length]!,
  }))
const outputs = (hues: readonly number[]): MockOutput[] =>
  hues.map((hue, index) => ({
    name: `Output ${index + 1}.png`,
    kind: 'image',
    hue,
  }))

const projects: readonly MockProject[] = [
  {
    id: 'film-grain-tests',
    name: 'Film grain tests',
    opened: '2 hours ago',
    path: '/home/kosin/Dinkster/projects/film-grain-tests',
    runsOn: 'Stable 0.0.18',
    packs: '4 enabled',
    size: '3.1 GB',
    outputCount: '212 outputs',
    workflows: workflows([
      ['Grain pass, 35mm', '2 hours ago'],
      ['Grain pass, 16mm', 'Yesterday'],
      ['Halation', 'Nov 20'],
      ['Diner establishing shot', 'Nov 19'],
      ['Upscale and sharpen', 'Nov 18'],
      ['Contact sheet', 'Nov 18'],
    ]),
    outputs: [
      ...outputs([24, 200, 32, 350, 190]),
      { name: 'Diner ambience.flac', kind: 'audio', hue: 0 },
    ],
  },
  {
    id: 'teapot-product-shots',
    name: 'Teapot product shots',
    opened: 'Yesterday',
    path: '/home/kosin/Dinkster/projects/teapot-product-shots',
    runsOn: 'Stable 0.0.18',
    packs: '2 enabled',
    size: '640 MB',
    outputCount: '38 outputs',
    workflows: workflows([
      ['Studio light', 'Yesterday'],
      ['Turntable', 'Nov 21'],
      ['Background swap', 'Nov 21'],
    ]),
    outputs: outputs([40, 45, 38, 50, 42, 36]),
  },
  {
    id: 'valley-matte-paintings',
    name: 'Valley matte paintings',
    opened: '3 days ago',
    path: '/home/kosin/Dinkster/projects/valley-matte-paintings',
    runsOn: 'Stable 0.0.18',
    packs: '3 enabled',
    size: '1.4 GB',
    outputCount: '96 outputs',
    workflows: workflows([
      ['Sunrise', '3 days ago'],
      ['Mist layers', 'Nov 19'],
      ['Wide plate', 'Nov 15'],
      ['Sky replacement', 'Nov 14'],
    ]),
    outputs: outputs([20, 28, 210, 140, 30, 220]),
  },
  {
    id: 'bookshop-diorama',
    name: 'Bookshop diorama',
    opened: 'Nov 12',
    path: '/home/kosin/Dinkster/projects/bookshop-diorama',
    runsOn: 'Nightly',
    packs: '5 enabled',
    size: '820 MB',
    outputCount: '41 outputs',
    workflows: workflows([
      ['Isometric room', 'Nov 12'],
      ['Shelf props', 'Nov 10'],
    ]),
    outputs: outputs([18, 26, 14, 22]),
  },
  {
    id: 'audio-experiments',
    name: 'Audio experiments',
    opened: 'Nov 3',
    path: '/home/kosin/Dinkster/projects/audio-experiments',
    runsOn: 'Stable 0.0.16',
    packs: '1 enabled',
    size: '12 MB',
    outputCount: '3 outputs',
    workflows: workflows([['Stem split', 'Nov 3']]),
    outputs: [
      { name: 'Stem vocals.flac', kind: 'audio', hue: 0 },
      { name: 'Stem drums.flac', kind: 'audio', hue: 0 },
      { name: 'Stem bass.flac', kind: 'audio', hue: 0 },
    ],
  },
  {
    id: 'default',
    name: 'Default',
    opened: 'Never opened',
    path: '/home/kosin/Dinkster/projects/default',
    runsOn: 'Stable 0.0.18',
    packs: 'None',
    size: '0 B',
    outputCount: 'no outputs',
    workflows: [],
    outputs: [],
  },
]

const extraNames = [
  'Storyboard frames',
  'Character turnarounds',
  'Lighting studies',
  'Texture library',
  'Logo animation',
  'Archive restoration with a long name that does not fit the list',
  'Comic panels',
  'Weekend sketches',
]

const platforms = {
  browser: 'Browser',
  linux: 'Linux',
  win32: 'Windows',
  darwin: 'macOS',
} as const

const states = {
  ready: 'Ready',
  loading: 'Loading',
  'first-run': 'First run',
  new: 'New project',
  opening: 'Opening',
  'opening-own-editor': "Opening in an installation's own editor",
  failed: 'Failed to open',
} as const

type State = keyof typeof states
type Place = 'projects' | 'installations' | 'models' | 'docs'

/**
 * Draws one mock workflow as the minimap draws a graph: node boxes and wires,
 * no text, the whole graph fitted inside the tile.
 */
function WorkflowPicture(props: { scene: CanvasGalleryPage }) {
  let canvas!: HTMLCanvasElement
  onMount(() => {
    const paint = () => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (width === 0 || height === 0) return
      const colors = canvasColorsForTheme('dark')
      const tokens: DesignTokens = {
        ...defaultTokens,
        ...canvasTypePaintForTheme('dark'),
        colors,
      }
      const context = document.createElement('canvas').getContext('2d')!
      const measure: TextMeasurer = (text, role) => {
        const title = role === 'title' || role === 'renamedTitle'
        context.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
        return context.measureText(text).width
      }
      const widgetMeasure: WidgetMeasure = (spec) => {
        const kind = widgets.kind(spec.widgetType)
        const view = widgets
          .viewsFor(spec.widgetType)
          .find((candidate) => candidate.id === kind?.defaultView(spec))
        return view
          ? { viewId: view.id, rows: view.measure(spec).rows }
          : undefined
      }
      const { scene } = createCanvasGalleryFixture(
        props.scene,
        tokens,
        measure,
        widgetMeasure,
      )
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      const graphics = canvas.getContext('2d')!
      graphics.setTransform(ratio, 0, 0, ratio, 0, 0)
      drawMinimapGraph(graphics, {
        width,
        height,
        tokens,
        nodes: scene.nodes.map((node) => ({
          x: node.x,
          y: node.y,
          width: node.layout.width,
          height: node.layout.height,
          bypassed: node.node.mode === 'bypassed',
          ...(node.color !== undefined ? { color: node.color } : {}),
        })),
        groups: scene.groups.map((group) => ({
          x: group.x,
          y: group.y,
          width: group.width,
          height: group.height,
          ...(group.color !== undefined ? { color: group.color } : {}),
        })),
        links: scene.links
          .filter((link) => link.hidden !== true)
          .map((link) => ({
            from: { x: link.x1, y: link.y1 },
            to: { x: link.x2, y: link.y2 },
            ...(link.typeName !== undefined ? { typeName: link.typeName } : {}),
          })),
        reroutes: scene.reroutes.map((point) => ({ x: point.x, y: point.y })),
      })
    }
    void fonts.then(paint)
    const observer = new ResizeObserver(() => void fonts.then(paint))
    observer.observe(canvas)
    onCleanup(() => observer.disconnect())
  })
  return <canvas ref={canvas} aria-hidden="true" />
}

registerCatalog('en', english)
const widgets = createWidgetRegistry()
registerCoreWidgets(widgetRegistrationDoors(widgets))
const fonts = Promise.all([
  document.fonts.load(
    `${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`,
  ),
  document.fonts.load(
    `${canvasPaintTokens.type.semiboldWeight} ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`,
  ),
])

/** A generated landscape standing in for an output image; its colors are picture content, not interface colors. */
function outputPicture(hue: number, seed: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 200
  const context = canvas.getContext('2d')!
  const sky = context.createLinearGradient(0, 0, 0, 200)
  sky.addColorStop(0, `hsl(${hue} 45% 22%)`)
  sky.addColorStop(1, `hsl(${(hue + 30) % 360} 55% 48%)`)
  context.fillStyle = sky
  context.fillRect(0, 0, 320, 200)
  for (let layer = 0; layer < 3; layer += 1) {
    context.fillStyle = `hsl(${(hue + 180 + layer * 20) % 360} 30% ${18 + layer * 8}%)`
    context.beginPath()
    context.moveTo(0, 200)
    for (let x = 0; x <= 320; x += 20)
      context.lineTo(
        x,
        120 + layer * 22 + Math.sin(x / (30 + layer * 9) + seed + layer) * 18,
      )
    context.lineTo(320, 200)
    context.fill()
  }
  context.fillStyle = `hsl(${(hue + 40) % 360} 80% 75%)`
  context.beginPath()
  context.arc(60 + ((seed * 47) % 200), 52, 14, 0, Math.PI * 2)
  context.fill()
  return canvas.toDataURL('image/png')
}

/**
 * The projects page as Dinkster draws it at launch: the left icon bar with
 * Projects, Installations, Models and Docs, the project list, and the selected
 * project's detail. Every value here is mock data.
 */
export function ProjectsGallery() {
  const [state, setState] = createSignal<State>('ready')
  const [platform, setPlatform] =
    createSignal<keyof typeof platforms>('browser')
  const [iconBar, setIconBar] = createSignal(true)
  const [many, setMany] = createSignal(false)
  const [previews, setPreviews] = createSignal(true)
  // "Template" is offered only while the engine's templates are on.
  const [templates, setTemplates] = createSignal(false)
  const [place, setPlace] = createSignal<Place>('projects')
  const [selected, setSelected] = createSignal('film-grain-tests')
  const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set())
  const [dialog, setDialog] = createSignal<'rename' | 'delete'>()
  const [banner, setBanner] = createSignal(true)
  const [name, setName] = createSignal('Night market')
  const [startWith, setStartWith] = createSignal('empty')
  const [activity, setActivity] = createSignal('No action yet')
  const pictures = new Map<string, string>()
  const picture = (output: MockOutput, index: number) => {
    const key = `${output.hue}-${index}`
    if (!pictures.has(key)) pictures.set(key, outputPicture(output.hue, index))
    return pictures.get(key)!
  }
  const allProjects = (): MockProject[] => [
    ...projects,
    ...(many()
      ? extraNames.map((name, index) => ({
          ...projects[5]!,
          id: `extra-${index}`,
          name,
          opened: 'Oct 30',
        }))
      : []),
  ]
  const project = () =>
    allProjects().find((entry) => entry.id === selected()) ?? projects[0]!
  const ownEditor = () => state() === 'opening-own-editor'
  const opening = () => (ownEditor() ? 'audio-experiments' : 'bookshop-diorama')
  const entries = (): ProductProjectEntry[] | undefined => {
    if (state() === 'loading') return undefined
    const list = allProjects().map(
      (entry): ProductProjectEntry => ({
        id: entry.id,
        name: entry.name,
        detail: entry.opened,
        state: undefined,
      }),
    )
    if (state() === 'opening' || state() === 'failed' || ownEditor()) {
      const target = list.find((entry) => entry.id === opening())!
      target.state = state() === 'failed' ? 'failed' : 'opening'
      target.detail = ownEditor()
        ? "Opening in Stable 0.0.16's own editor"
        : state() === 'opening'
          ? 'Stopping Stable, starting Nightly'
          : 'Nightly did not start'
      if (ownEditor()) target.reason = 'This installation uses an older editor.'
    }
    if (state() === 'new')
      list.unshift({
        id: 'new',
        name: 'New project',
        detail: 'Not created yet',
        state: 'draft',
      })
    return list
  }
  createEffect(() => {
    if (state() === 'opening' || state() === 'failed' || ownEditor())
      setSelected(opening())
    if (state() === 'failed') setBanner(true)
  })
  const listSelection = () => (state() === 'new' ? 'new' : selected())
  const engineStatus = () =>
    state() === 'first-run'
      ? 'No installation'
      : ownEditor()
        ? 'Starting Stable 0.0.16'
        : state() === 'opening'
          ? 'Starting Nightly'
          : state() === 'failed'
            ? 'Nightly stopped'
            : 'No engine running'
  const logoInBar = () => platform() === 'darwin' && iconBar()
  const logoMenu = () => (
    <ProductMenu
      label="Dinkster"
      triggerName="Dinkster menu"
      icon={() => <ProductBrandMark />}
      iconOnly
      items={[
        { label: 'New project', onSelect: () => setState('new') },
        {
          label: 'Open workflow file',
          onSelect: () => setActivity('Open workflow file'),
        },
        'separator',
        { label: 'Settings', onSelect: () => setActivity('Settings opened') },
        { label: 'Docs', onSelect: () => setPlace('docs') },
        {
          label: 'About Dinkster',
          onSelect: () => setActivity('About opened'),
        },
        {
          label: 'Check for updates',
          onSelect: () => setActivity('Checking for updates'),
        },
      ]}
    />
  )
  const outputsHidden = () => hidden().has(project().id)
  const toggleOutputs = () => {
    const next = new Set(hidden())
    if (next.has(project().id)) next.delete(project().id)
    else next.add(project().id)
    setHidden(next)
  }
  const detail = () => (
    <>
      <ProductProjectHeader
        title={project().name}
        subtitle={
          project().opened === 'Never opened'
            ? 'Never opened'
            : `Opened ${project().opened}`
        }
        actions={
          <Show
            when={state() !== 'opening' && !ownEditor()}
            fallback={
              <>
                <ProductButton onClick={() => setState('ready')}>
                  Cancel
                </ProductButton>
                <ProductButton fill="solid" pending>
                  Opening
                </ProductButton>
              </>
            }
          >
            <ProductMenu
              label="Project actions"
              icon={Ellipsis}
              iconOnly
              items={[
                { label: 'Rename', onSelect: () => setDialog('rename') },
                {
                  label: 'Duplicate',
                  onSelect: () => setActivity('Duplicated'),
                },
                {
                  label: 'Open in a new window',
                  onSelect: () => setActivity('Opened in a new window'),
                },
                'separator',
                {
                  label: 'Change installation',
                  onSelect: () => setActivity('Change installation'),
                },
                {
                  label: 'Move files',
                  onSelect: () => setActivity('Move files'),
                },
                { label: 'Export', onSelect: () => setActivity('Export') },
                'separator',
                {
                  label: 'Delete',
                  intent: 'remove',
                  disabled: project().id === 'default',
                  onSelect: () => setDialog('delete'),
                },
              ]}
            />
            <ProductButton
              fill="solid"
              onClick={() => setActivity(`Opened ${project().name}`)}
            >
              {state() === 'failed' ? 'Try again' : 'Open'}
            </ProductButton>
          </Show>
        }
      />
      <Show when={state() === 'failed' && banner()}>
        <ProductErrorBanner onDismiss={() => setBanner(false)}>
          Nightly did not start, so Bookshop diorama could not open. Stable is
          running again.{' '}
          <ProductTextButton
            label="Show log"
            onClick={() => setActivity('Log opened')}
          />
        </ProductErrorBanner>
      </Show>
      <ProductProjectFacts
        label="About this project"
        columns={[
          [
            {
              label: 'Files',
              value: project().path,
              action: (
                <ProductTextButton
                  label="Show in folder"
                  onClick={() => setActivity('Shown in folder')}
                />
              ),
            },
            {
              label: 'Runs on',
              value: project().runsOn,
              detail: 'this computer',
              action: (
                <ProductTextButton
                  label="Change"
                  onClick={() => setActivity('Change installation')}
                />
              ),
            },
          ],
          [
            {
              label: 'Packs',
              value: project().packs,
              action: (
                <ProductTextButton
                  label="Manage"
                  onClick={() => setActivity('Packs opened')}
                />
              ),
            },
            {
              label: 'Size',
              value: project().size,
              detail: project().outputCount,
            },
          ],
        ]}
      />
      <ProductProjectSection
        title="Workflows"
        aside={
          <span class="dinkster-metadata">{project().workflows.length}</span>
        }
      >
        <Show
          when={project().workflows.length > 0}
          fallback={
            <ProductEmptyState message="No workflows yet. Open the project to make one." />
          }
        >
          <ProductTileGrid size="wide">
            <For each={project().workflows}>
              {(workflow) => (
                <ProductTile
                  label={workflow.name}
                  caption={workflow.name}
                  detail={workflow.date}
                  picture={
                    previews() ? (
                      <WorkflowPicture scene={workflow.scene} />
                    ) : undefined
                  }
                  empty={<ProductIcon icon={Workflow} />}
                  onClick={() => setActivity(`Opened ${workflow.name}`)}
                />
              )}
            </For>
          </ProductTileGrid>
        </Show>
      </ProductProjectSection>
      <ProductProjectSection
        title="Latest outputs"
        aside={
          <Show when={project().outputs.length > 0}>
            <Show
              when={outputsHidden()}
              fallback={
                <ProductTextButton
                  label="Hide"
                  icon={EyeOff}
                  onClick={toggleOutputs}
                />
              }
            >
              <span class="dinkster-actions">
                <span class="dinkster-metadata">Hidden on this page</span>
                <ProductTextButton
                  label="Show"
                  icon={Eye}
                  onClick={toggleOutputs}
                />
              </span>
            </Show>
          </Show>
        }
      >
        <Show
          when={project().outputs.length > 0}
          fallback={<ProductEmptyState message="No outputs yet." />}
        >
          <Show when={!outputsHidden()}>
            <ProductTileGrid size="narrow">
              <For each={project().outputs}>
                {(output, index) => (
                  <ProductTile
                    label={output.name}
                    picture={
                      output.kind === 'image' ? (
                        <img src={picture(output, index())} alt="" />
                      ) : undefined
                    }
                    empty={
                      <>
                        <ProductIcon icon={AudioLines} />
                        <span>{output.name}</span>
                        <span>Audio</span>
                      </>
                    }
                    onClick={() => setActivity(`Opened ${output.name}`)}
                  />
                )}
              </For>
            </ProductTileGrid>
          </Show>
        </Show>
      </ProductProjectSection>
    </>
  )
  const newProject = () => (
    <>
      <ProductProjectHeader title="New project" />
      <form
        class="dinkster-project-form"
        onSubmit={(event) => {
          event.preventDefault()
          setActivity(`Created ${name()}`)
          setState('ready')
        }}
      >
        <label for="new-project-name">Name</label>
        <ProductTextInput
          id="new-project-name"
          value={name()}
          autofocus
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <span>Files</span>
        <span class="dinkster-project-form-path">
          <span>
            /home/kosin/Dinkster/projects/
            {name()
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/gu, '-')}
          </span>
          <ProductTextButton
            label="Change"
            onClick={() => setActivity('Folder browser opened')}
          />
        </span>
        <label for="new-project-runs-on">Runs on</label>
        <ProductSelect id="new-project-runs-on">
          <option>Stable 0.0.18 - this computer</option>
          <option>Nightly - this computer</option>
        </ProductSelect>
        <span>Start with</span>
        <span>
          <ProductSegmented
            label="Start with"
            value={startWith()}
            onChange={setStartWith}
            options={[
              { value: 'empty', label: 'Empty' },
              ...(templates()
                ? [{ value: 'template', label: 'Template' }]
                : []),
              { value: 'file', label: 'Workflow file' },
              { value: 'copy', label: 'Copy of a project' },
            ]}
          />
        </span>
        <div class="dinkster-actions">
          <ProductButton onClick={() => setState('ready')}>
            Cancel
          </ProductButton>
          <ProductButton
            type="submit"
            intent="add"
            fill="solid"
            disabled={name().trim() === ''}
          >
            Create
          </ProductButton>
        </div>
      </form>
    </>
  )
  const loadingDetail = () => (
    <div class="dinkster-stack" role="status" aria-label="Loading projects">
      <ProductSkeleton shape="title" />
      <ProductSkeleton shape="line" />
      <ProductSkeleton shape="line" />
      <ProductTileGrid size="wide">
        <Index each={[0, 1, 2, 3]}>
          {() => <ProductSkeleton shape="tile" />}
        </Index>
      </ProductTileGrid>
    </div>
  )
  const setup = () => (
    <div class="dinkster-projects-setup">
      <form
        class="dinkster-project-form"
        onSubmit={(event) => {
          event.preventDefault()
          setActivity('Install started')
        }}
      >
        <h1 class="dinkster-title">Set up Dinkster</h1>
        <span>Install to</span>
        <span class="dinkster-project-form-path">
          <span>/home/kosin/Dinkster</span>
          <ProductTextButton
            label="Change"
            onClick={() => setActivity('Folder browser opened')}
          />
        </span>
        <span>Graphics card</span>
        <span class="dinkster-project-form-path">
          <span>NVIDIA GeForce RTX 4090</span>
          <ProductTextButton
            label="Change"
            onClick={() => setActivity('Graphics card choice opened')}
          />
        </span>
        <span>Download</span>
        <span class="dinkster-project-form-path">
          <span>
            4.2 GB{' '}
            <span class="dinkster-project-fact-detail">- 512 GB free</span>
          </span>
        </span>
        <div class="dinkster-actions">
          <ProductTextButton
            label="Connect to a remote engine"
            onClick={() => setActivity('Remote engine form opened')}
          />
          <ProductButton type="submit" fill="solid">
            Install
          </ProductButton>
        </div>
      </form>
    </div>
  )
  const otherPlace = (title: string) => (
    <ProductProjectsView>
      <ProductProjectHeader title={title} />
      <ProductEmptyState
        message={`${title} opens here, as the editor's ${title} panel does.`}
      />
    </ProductProjectsView>
  )
  return (
    <main class="dinkster-stack">
      <div
        class="dinkster-editor-preview dinkster-root"
        data-page="projects"
        data-theme="dark"
        role="region"
        aria-label="Projects page"
      >
        <ProductWindowToolbar
          title="Application controls"
          platform={
            platform() === 'browser'
              ? 'linux'
              : (platform() as 'darwin' | 'win32' | 'linux')
          }
          brand={<Show when={!logoInBar()}>{logoMenu()}</Show>}
          search={
            <ProductWindowAction
              label={english['command.search.open']}
              icon={Search}
              shortcut="Ctrl+K"
              onClick={() => setActivity('Search opened')}
            />
          }
          actions={<></>}
        />
        <div class="dinkster-editor-preview-body">
          <Show when={iconBar()}>
            <nav
              class="dinkster-editor-preview-rail"
              aria-label="Primary navigation"
            >
              <Show when={logoInBar()}>{logoMenu()}</Show>
              <For
                each={
                  [
                    ['projects', 'Projects', LayoutGrid],
                    ['installations', 'Installations', Server],
                    ['models', 'Models', Database],
                    ['docs', 'Docs', BookOpen],
                  ] as const
                }
              >
                {([id, label, icon]) => (
                  <ProductIconButton
                    label={label}
                    icon={icon}
                    aria-pressed={place() === id}
                    onClick={() => setPlace(id)}
                  />
                )}
              </For>
              <span class="dinkster-editor-preview-rail-end">
                <ProductAccountMenu
                  rail
                  name="Alex Rivers"
                  email="alex@example.test"
                  onSignOut={() => setActivity('Signed out')}
                />
                <ProductIconButton
                  label="Settings"
                  icon={Settings}
                  onClick={() => setActivity('Settings opened')}
                />
              </span>
            </nav>
          </Show>
          <div class="dinkster-editor-preview-page">
            <Switch>
              <Match when={place() === 'installations'}>
                {otherPlace('Installations')}
              </Match>
              <Match when={place() === 'models'}>{otherPlace('Models')}</Match>
              <Match when={place() === 'docs'}>{otherPlace('Docs')}</Match>
              <Match when={state() === 'first-run'}>
                <ProductProjectsView>{setup()}</ProductProjectsView>
              </Match>
              <Match when={true}>
                <ProductProjectsView
                  list={
                    <ProductProjectList
                      title="Projects"
                      newLabel="New"
                      onNew={() => setState('new')}
                      projects={entries()}
                      selected={listSelection()}
                      onSelect={(id) => {
                        if (id === 'new') return
                        if (state() === 'new') setState('ready')
                        setSelected(id)
                      }}
                      loadingLabel="Loading projects"
                    />
                  }
                >
                  <Switch fallback={detail()}>
                    <Match when={state() === 'loading'}>
                      {loadingDetail()}
                    </Match>
                    <Match when={state() === 'new'}>{newProject()}</Match>
                  </Switch>
                </ProductProjectsView>
              </Match>
            </Switch>
          </div>
        </div>
        <footer class="dinkster-editor-preview-status">
          <span class="dinkster-editor-preview-connection">
            <span class="dinkster-connection-dot" aria-hidden="true" />
            Local
          </span>
          <span>{engineStatus()}</span>
          <span>
            {state() === 'first-run' || state() === 'loading'
              ? ''
              : `${allProjects().length} projects`}
          </span>
        </footer>
      </div>
      <Show when={dialog() === 'rename'}>
        <ProductDialog
          title="Rename project"
          onDismiss={() => setDialog(undefined)}
        >
          <ProductField label="Name">
            {(attributes) => (
              <ProductTextInput {...attributes} value={project().name} />
            )}
          </ProductField>
          <div class="dinkster-actions">
            <ProductButton
              fill="solid"
              onClick={() => {
                setDialog(undefined)
                setActivity('Renamed')
              }}
            >
              Save
            </ProductButton>
            <ProductButton onClick={() => setDialog(undefined)}>
              Cancel
            </ProductButton>
          </div>
        </ProductDialog>
      </Show>
      <Show when={dialog() === 'delete'}>
        <ProductDialog
          title={`Delete ${project().name}?`}
          onDismiss={() => setDialog(undefined)}
        >
          <ProductConfirmation
            consequence="Its workflows and outputs leave the project list. Files in its folder stay on disk."
            actionLabel="Delete project"
            intent="remove"
            onConfirm={() => {
              setDialog(undefined)
              setActivity(`Deleted ${project().name}`)
            }}
            onCancel={() => setDialog(undefined)}
          />
        </ProductDialog>
      </Show>
      <ProductPage
        title="Projects page"
        description="The page Dinkster opens on: the left icon bar, the project list, and the selected project. All data here is mock data."
      >
        <ProductField label="State">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={state()}
              onChange={(event) => {
                setPlace('projects')
                setState(event.currentTarget.value as State)
              }}
            >
              <For each={Object.entries(states)}>
                {([value, label]) => <option value={value}>{label}</option>}
              </For>
            </ProductSelect>
          )}
        </ProductField>
        <ProductField label="Platform">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={platform()}
              onChange={(event) =>
                setPlatform(event.currentTarget.value as keyof typeof platforms)
              }
            >
              <For each={Object.entries(platforms)}>
                {([value, label]) => <option value={value}>{label}</option>}
              </For>
            </ProductSelect>
          )}
        </ProductField>
        <ProductCheckbox
          label="Icon bar"
          checked={iconBar()}
          onChange={(event) => setIconBar(event.currentTarget.checked)}
        />
        <ProductCheckbox
          label="Many projects"
          checked={many()}
          onChange={(event) => setMany(event.currentTarget.checked)}
        />
        <ProductCheckbox
          label="Workflow previews drawn"
          checked={previews()}
          onChange={(event) => setPreviews(event.currentTarget.checked)}
        />
        <ProductCheckbox
          label="Engine templates on"
          checked={templates()}
          onChange={(event) => setTemplates(event.currentTarget.checked)}
        />
        <p role="status">{activity()}</p>
      </ProductPage>
    </main>
  )
}

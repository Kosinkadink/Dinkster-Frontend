/**
 * The projects page under the always-on process: every project in the shared
 * library on the left, the selected one on the right with where it runs, its
 * workflows and its latest outputs. It reads the process with no engine
 * running. Opening a project goes through the shell, which writes the opening
 * line and the failure the page draws.
 */
import { createEffect, createMemo, createSignal, createUniqueId, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { AudioLines, BookOpen, Database, Ellipsis, Eye, EyeOff, File, Image as ImageIcon, LayoutGrid, Search, Server, Workflow } from 'lucide-solid'
import { activeLocale, asConnectionId, loadDocument, type SchemaResolver, type WorkflowDocument } from '@dinkster/core'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import {
  buildDinksterRegistry,
  DinksterConnection,
  uuidv4,
  type LibraryProject,
  type LibraryRecord,
  type LocalAssetCatalogEntry,
  type ProjectCreation,
  type ProjectNeeds,
} from '@dinkster/client'
import {
  ProductBrandMark,
  ProductButton,
  ProductConfirmationDialog,
  ProductDialog,
  ProductEmptyState,
  ProductErrorBanner,
  ProductField,
  ProductIcon,
  ProductMenu,
  createPageLoad,
  ProductPageAnswer,
  ProductPageLoad,
  ProductProjectFacts,
  ProductProjectHeader,
  ProductProjectListHeader,
  ProductProjectRows,
  ProductProjectSection,
  ProductProjectsView,
  ProductSegmented,
  ProductSelect,
  ProductTextButton,
  ProductTextInput,
  ProductTile,
  ProductTileGrid,
  ProductWindowAction,
  ProductWindowToolbar,
  type ProductProjectEntry,
} from '@dinkster/ui'
import { useAppMessage } from '../locale.js'
import { SetupForm, type SetupStatus } from '../SetupForm.js'
import { desktopFileBridge } from '../desktop-bridge.js'
import { ProductFileInput } from '../ProductControls.js'
import { setupInProgress } from '../setup-job.js'
import { AccountControl, createAccountSession } from '../AccountControl.js'
import { ActivityBarButton, IconBar, ShellTooltip, windowBarPlatform } from '../ShellChrome.js'
import { attachDomTooltips, TooltipController, type DomTooltipTarget } from '../tooltips.js'
import { useSignal } from '../solid-adapter.js'
import { DEFAULT_PROJECT_ID } from '../projects.js'
import '@dinkster/ui/styles.css'
import './projects-page.css'
import { byProjectTime, formatBytes, formatWhen, projectTime } from './project-facts.js'
import { WorkflowPicture } from './workflow-picture.js'
import { EngineLogDialog } from '../EngineRunControl.js'

/** An installation a project can run on. */
export interface PageInstallation {
  readonly root: string
  readonly engine: string
  readonly name: string
}

/** What the page reads; the process in the app, a stand-in in tests. */
export interface ProjectsSource {
  /** Every project, deleted ones included. */
  listProjects(): Promise<readonly LibraryProject[]>
  registerProject(id: string, name: string, creation?: ProjectCreation): Promise<LibraryProject>
  renameProject(project: LibraryProject, name: string): Promise<LibraryProject>
  deleteProject(project: LibraryProject): Promise<LibraryProject>
  restoreProject(project: LibraryProject): Promise<LibraryProject>
  listWorkflows(project: string): Promise<readonly LibraryRecord[]>
  needs(project: string): Promise<ProjectNeeds>
  /** A saved workflow's document; undefined when its bytes cannot be read or loaded. */
  workflowDocument(digest: string): Promise<WorkflowDocument | undefined>
  /** The node definitions the project last ran with; undefined when the process has none. */
  definitions(project: string): Promise<SchemaResolver | undefined>
  listOutputs(project: string, limit: number): Promise<readonly LocalAssetCatalogEntry[]>
  /** Stored bytes and output count; undefined while the process cannot tell. */
  usage(project: string): Promise<{ readonly outputs: number; readonly bytes: number } | undefined>
  /** Every installation, the one that is open, if any, the state of its engine, and whether the process can open folders. */
  installations(): Promise<{
    readonly all: readonly PageInstallation[]
    readonly open?: PageInstallation
    readonly engine?: EngineState
    readonly openFolder?: boolean
    readonly projectsFolder?: string
    readonly settingUp?: boolean
  }>
  /** Opens the project's folder in this computer's file manager. */
  openFolder(project: string): Promise<void>
}

/** The process's engine state, from /supervisor/status. */
export type EngineState = 'stopped' | 'starting' | 'ready' | 'failed'

/** The part of the shell's navigation the page uses. */
export interface ProjectsPageShell {
  readonly view: () =>
    | { readonly kind: 'projects'; readonly newProject: boolean }
    | { readonly kind: 'editor'; readonly projectId: string }
  readonly opening: () =>
    | { readonly projectId: string; readonly line: string; readonly reason?: string; readonly failed?: string; readonly showLog?: boolean }
    | undefined
  readonly selectedProjectId: () => string | undefined
  openProject(projectId: string, installation?: PageInstallation): void
  showProjects(options?: { readonly newProject?: boolean }): void
  cancelOpening(): void
}

const OUTPUT_LIMIT = 6

/** Per-project page choices live under the project's own storage prefix, beside its editor settings. */
function pageKey(project: string, name: string): string {
  return project === DEFAULT_PROJECT_ID ? `dinkster.projectsPage.${name}` : `dinkster.p.${project}.projectsPage.${name}`
}

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === 'true'
  } catch {
    return false
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) globalThis.localStorage?.setItem(key, 'true')
    else globalThis.localStorage?.removeItem(key)
  } catch {
    // Storage that refuses writes keeps the choice for this page only.
  }
}

function readChoice(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function folderName(root: string): string {
  return root.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() || root
}

function processConnection(): DinksterConnection {
  return new DinksterConnection({ id: asConnectionId('projects-page'), baseUrl: '', clientId: 'projects-page' })
}

/** The page's reads from the always-on process serving this page. */
export function processSource(connection: DinksterConnection = processConnection()): ProjectsSource {
  return {
    async listProjects() {
      const projects: LibraryProject[] = []
      let cursor: string | undefined
      do {
        const page = await connection.listProjects(cursor, undefined, true)
        projects.push(...page.items)
        cursor = page.cursor ?? undefined
      } while (cursor !== undefined)
      return projects
    },
    registerProject: (id, name, creation) => connection.registerProject(id, name, creation),
    renameProject: (project, name) => connection.renameProject(project.id, name, project.revision),
    deleteProject: (project) => connection.deleteProject(project.id, project.revision),
    restoreProject: (project) => connection.restoreProject(project.id, project.revision),
    needs: (project) => connection.projectNeeds(project),
    async listWorkflows(project) {
      const records: LibraryRecord[] = []
      let cursor: string | undefined
      do {
        const page = await connection.listLibrary({ scope: 'local', mediaType: 'application/x-dinkster-workflow+json', project, limit: 200,
          ...(cursor !== undefined ? { cursor } : {}) })
        records.push(...page.records)
        cursor = page.cursor
      } while (cursor !== undefined)
      return records
    },
    async workflowDocument(digest) {
      const response = await fetch(`/api/assets/${encodeURIComponent(digest)}`)
      return response.ok ? loadDocument(await response.json()).document : undefined
    },
    async definitions(project) {
      const response = await fetch(`/api/nodes/provisional?${new URLSearchParams({ project })}`, { cache: 'no-store' })
      if (!response.ok) return undefined
      return buildDinksterRegistry(asConnectionId('projects-page'), await response.json()).resolve
    },
    async listOutputs(project, limit) {
      return (await connection.listProjectOutputs(project, { limit })).assets
    },
    async usage(project) {
      const response = await fetch(`/api/projects/${encodeURIComponent(project)}/usage`, { cache: 'no-store' })
      if (!response.ok) return undefined
      const body = (await response.json()) as { outputs?: unknown; bytes?: unknown }
      return typeof body.outputs === 'number' && typeof body.bytes === 'number'
        ? { outputs: body.outputs, bytes: body.bytes }
        : undefined
    },
    async installations() {
      const [status, rows] = await Promise.all([
        fetch('/supervisor/status', { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : {}))
          .catch(() => ({})),
        // A list the process cannot give fails the read, so the page never takes it for "no installations".
        fetch('/supervisor/installations', { cache: 'no-store' }).then((response) => {
          if (!response.ok) throw new Error(`GET /supervisor/installations failed: ${response.status}`)
          return response.json()
        }),
      ]) as [
        { state?: EngineState; open?: { root: string; engine: string }; openFolder?: boolean; projectsFolder?: string },
        { installations?: readonly { root: string }[] },
      ]
      const named = (root: string, engine = 'main'): PageInstallation => ({ root, engine, name: folderName(root) })
      const all = (rows.installations ?? []).map((row) => named(row.root))
      const open = status.open ? named(status.open.root, status.open.engine) : undefined
      if (open && !all.some((row) => row.root === open.root)) all.unshift(open)
      return {
        all,
        ...(open ? { open } : {}),
        ...(status.state ? { engine: status.state } : {}),
        openFolder: status.openFolder === true,
        ...(typeof status.projectsFolder === 'string' && status.projectsFolder !== '' ? { projectsFolder: status.projectsFolder } : {}),
        settingUp: !open && all.length > 0 && await setupInProgress(),
      }
    },
    async openFolder(project) {
      const response = await fetch(`/supervisor/projects/${encodeURIComponent(project)}/folder`, { method: 'POST' })
      if (!response.ok) throw new Error(`POST /supervisor/projects/${project}/folder failed: ${response.status}`)
    },
  }
}

type Place = 'projects' | 'installations' | 'models' | 'docs'

const PLACES = [
  ['projects', LayoutGrid],
  ['installations', Server],
  ['models', Database],
  ['docs', BookOpen],
] as const

/**
 * The page with the editor's frame around it: the same top bar, left icon
 * bar and status bar, in the same places, so the frame does not move when the
 * shell fades between the page and an editor.
 */
export function ProjectsPage(props: { readonly shell: ProjectsPageShell }) {
  const message = useAppMessage()
  const connection = processConnection()
  const source = processSource(connection)
  const account = createAccountSession(() => connection)
  const [place, setPlace] = createSignal<Place>('projects')
  const [count, setCount] = createSignal<number>()
  const [setupStatus, setSetupStatus] = createSignal<SetupStatus>()
  const [engine, setEngine] = createSignal<{ state?: EngineState; open?: PageInstallation; notSetUp: boolean }>({ notSetUp: false })
  const openingLine = () => {
    const opening = props.shell.opening()
    return opening?.failed === undefined ? opening?.line : undefined
  }
  // The editor's tooltips, so the frame's controls explain themselves here too.
  const tooltips = new TooltipController()
  tooltips.register({
    id: 'core.dom',
    resolve: (target) => {
      const dom = target as Partial<DomTooltipTarget>
      return dom.kind === 'dom' && dom.label ? { lines: [dom.label] } : undefined
    },
  })
  const [tooltip, setTooltip] = createSignal(tooltips.visible)
  let frame!: HTMLDivElement
  const barPlatform = windowBarPlatform(() => frame)
  const logoInLeftBar = () => barPlatform() === 'darwin'
  onMount(() => {
    const detach = attachDomTooltips(frame, tooltips)
    const unsubscribe = tooltips.subscribe(() => setTooltip(tooltips.visible))
    onCleanup(() => {
      detach()
      unsubscribe()
    })
  })
  const logo = () => (
    <ProductMenu
      label={message('projects.logoMenu')}
      icon={() => <ProductBrandMark />}
      iconOnly
      windowAction
      items={[{ label: message('projects.new.title'), onSelect: () => props.shell.showProjects({ newProject: true }) }]}
    />
  )
  return (
    <div class="shell" data-testid="projects-page" ref={frame}>
      <h1 class="visually-hidden">{message('shell.applicationTitle')}</h1>
      <ProductWindowToolbar
        title={message('shell.applicationControls')}
        platform="linux"
        brand={<Show when={!logoInLeftBar()}>{logo()}</Show>}
        search={
          // Search needs an open project's catalog; until the page has its own, it says so.
          <ProductWindowAction
            label={message('projects.unavailable.search')}
            labelContent={message('command.search.open')}
            icon={Search}
            aria-disabled="true"
            data-testid="topbar-search"
            data-tooltip-label={message('projects.unavailable.search')}
          />
        }
        actions={<></>}
      />
      <div class="body">
        <IconBar
          hidden={false}
          logo={logoInLeftBar() ? logo : undefined}
          account={<AccountControl session={account} rail />}
          onSettings={() => {}}
          settingsUnavailable={message('projects.unavailable.settings')}
        >
          <For each={PLACES}>
            {([id, icon]) => (
              <ActivityBarButton
                icon={icon}
                label={message(`projects.place.${id}`)}
                accessibleName={message(`projects.place.${id}`)}
                tooltip={message(`projects.place.${id}`)}
                pressed={place() === id}
                testId={`projects-place-${id}`}
                onActivate={() => setPlace(id)}
              />
            )}
          </For>
        </IconBar>
        <div class="projects-page-body dinkster-root">
          <Switch>
            <Match when={place() === 'projects'}>
              <ProjectsView shell={props.shell} source={source} onCount={setCount} onEngine={setEngine} onSetupStatusChange={setSetupStatus} />
            </Match>
            <Match when={true}>
              <ProductProjectsView>
                <ProductProjectHeader title={message(`projects.place.${place()}`)} />
                <ProductEmptyState message={message('projects.place.later')} />
              </ProductProjectsView>
            </Match>
          </Switch>
        </div>
      </div>
      <footer class="statusbar statusbar-state" aria-label={message('shell.applicationStatus')}>
        <div class="status-items">
          <span class="status-item status-connection projects-page-status" data-state={engineDot(engine().state)}>
            <span class="status-connection-dot" aria-hidden="true" />
            <span class="status-connection-name">{message('projects.status.local')}</span>
            <Show when={!openingLine() && setupStatus()}>{(status) => <span>{message(status() === 'setting-up' ? 'shell.status.settingUp' : 'shell.status.notSetUp')}</span>}</Show>
          </span>
          <Show when={openingLine() || (!setupStatus() && engine().state)}><span class="status-item" data-testid="projects-engine-status">
            {openingLine() ?? (engine().notSetUp ? message('shell.status.notSetUp')
              : engine().state === 'ready' && engine().open
              ? message('projects.status.ready', { installation: engine().open!.name })
              : message(ENGINE_WORDS[engine().state ?? 'stopped']))}
          </span></Show>
          <Show when={count() !== undefined}>
            <span class="status-item projects-page-count">{message('projects.status.count', { count: count()! })}</span>
          </Show>
        </div>
      </footer>
      <Show when={tooltip()}>{(tip) => <ShellTooltip tip={tip()} />}</Show>
    </div>
  )
}

export function ProjectsView(props: {
  readonly shell: ProjectsPageShell
  readonly source: ProjectsSource
  /** Told how many projects the list holds once it has read them. */
  readonly onCount?: (count: number) => void
  /** Told the engine's state and the open installation once the page has read them. */
  readonly onEngine?: (engine: { state?: EngineState; open?: PageInstallation; notSetUp: boolean }) => void
  readonly onSetupStatusChange?: (status: SetupStatus | undefined) => void
}) {
  const message = useAppMessage()
  const locale = useSignal(activeLocale)
  // A read that fails resolves to null, so one missing route leaves the rest of the page working.
  const readPage = async () => {
    const [projects, installations] = await Promise.all([
      props.source.listProjects().then(byProjectTime, () => null),
      props.source.installations().catch(() => null),
    ])
    return { projects, installations }
  }
  const page = createPageLoad<Awaited<ReturnType<typeof readPage>>>()
  const rereadPage = () => page.load(readPage)
  const projects = () => page.value()?.projects
  const installations = () => page.value()?.installations
  let projectUpdate = Promise.resolve()
  const setProjects = (update: (list: LibraryProject[] | null) => LibraryProject[] | null | undefined) => {
    projectUpdate = projectUpdate.then(() => {
      const current = page.value()
      return current && page.load(async () => ({ ...current, projects: update(current.projects) ?? null }))
    })
    return projectUpdate
  }
  const painted = () => page.value() !== undefined
  const projectHeading = createUniqueId()
  const renameForm = createUniqueId()
  const folderForm = createUniqueId()
  void rereadPage()
  const firstRun = () => installations()?.all.length === 0 || installations()?.settingUp === true
  onMount(() => {
    const reread = () => {
      void rereadPage()
    }
    globalThis.addEventListener('focus', reread)
    onCleanup(() => globalThis.removeEventListener('focus', reread))
  })
  // The list holds deleted projects too; they show only under "Deleted projects".
  const live = () => projects()?.filter((project) => !project.deleted)
  const setupOnly = () => firstRun() && !projects()?.length
  const gone = () =>
    projects()
      ?.filter((project) => project.deleted)
      .sort((a, b) => deletedAt(b) - deletedAt(a))
  createEffect(() => {
    const list = live()
    if (painted() && list && !setupOnly()) props.onCount?.(list.length)
  })
  createEffect(() => {
    const found = installations()
    if (painted() && found) props.onEngine?.({ ...(found.engine ? { state: found.engine } : {}), ...(found.open ? { open: found.open } : {}), notSetUp: found.all.length === 0 })
  })
  const [chosen, setChosen] = createSignal<string>()
  const [narrowDetail, setNarrowDetail] = createSignal(!!props.shell.selectedProjectId())
  const [bannerShown, setBannerShown] = createSignal(true)
  const [folderFailed, setFolderFailed] = createSignal<string>()
  const [runsOnChoice, setRunsOnChoice] = createSignal(0)
  const [hiddenChange, setHiddenChange] = createSignal(0)
  const [restoreFailed, setRestoreFailed] = createSignal<string>()

  const selectedId = (): string | undefined =>
    chosen() ?? props.shell.selectedProjectId() ?? live()?.[0]?.id
  const selected = createMemo(() => live()?.find((project) => project.id === selectedId()))
  const readDetail = async (project: LibraryProject) => {
    const [workflows, outputs, usage, definitions, needs] = await Promise.all([
      props.source.listWorkflows(project.id).catch(() => null),
      props.source.listOutputs(project.id, OUTPUT_LIMIT).catch(() => null),
      props.source.usage(project.id).catch(() => undefined),
      props.source.definitions(project.id).catch(() => undefined),
      props.source.needs(project.id).catch(() => null),
    ])
    const documents = new Map(await Promise.all((workflows ?? []).map(async (workflow) =>
      [workflow.digest, await props.source.workflowDocument(workflow.digest).catch(() => undefined)] as const,
    )))
    return { project, workflows, outputs, usage, definitions, documents, needs }
  }
  const projectDetail = createPageLoad<Awaited<ReturnType<typeof readDetail>>>()
  createEffect(() => {
    const project = selected()
    if (project) void projectDetail.load(() => readDetail(project))
  })

  const when = (at: number) => {
    locale()
    return formatWhen(at, locale().tag)
  }
  const opening = () => props.shell.opening()
  const newProject = () => {
    const view = props.shell.view()
    return view.kind === 'projects' && view.newProject
  }

  const runsOn = (project: string): PageInstallation | undefined => {
    runsOnChoice()
    const found = installations()
    if (!found) return undefined
    const root = readChoice(pageKey(project, 'runsOn'))
    return found.all.find((row) => row.root === root) ?? found.open ?? found.all[0]
  }

  const [entries, setEntries] = createStore<ProductProjectEntry[]>([])
  createEffect(() => {
    const list = live()
    if (!list) return
    const now = opening()
    setEntries(reconcile(list.map((project) => {
      const time = projectTime(project)
      const entry: ProductProjectEntry = {
        id: project.id,
        name: project.name,
        detail: time === null ? message('projects.time.neverOpened') : message('projects.time.opened', { when: when(time) }),
      }
      if (now?.projectId === project.id) {
        entry.state = now.failed !== undefined ? 'failed' : 'opening'
        entry.detail = now.failed ?? now.line
        entry.reason = now.reason
      }
      return entry
    })))
  })

  const [dialog, setDialog] = createSignal<'rename' | 'delete'>()
  const [dialogError, setDialogError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [newName, setNewName] = createSignal('')
  const [logProject, setLogProject] = createSignal<string>()
  const closeDialog = () => {
    setDialog(undefined)
    setDialogError(undefined)
  }
  const act = async (work: () => Promise<void>) => {
    setBusy(true)
    setDialogError(undefined)
    try {
      await work()
      closeDialog()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const rename = (project: LibraryProject) =>
    act(async () => {
      const renamed = await props.source.renameProject(project, newName().trim())
      await setProjects((list) => list?.map((entry) => (entry.id === renamed.id ? renamed : entry)))
    })
  const replace = (changed: LibraryProject) =>
    setProjects((list) => list && byProjectTime(list.map((entry) => (entry.id === changed.id ? changed : entry))))
  // After Delete the next project down is selected, or the one above when it was the last.
  const remove = (project: LibraryProject) =>
    act(async () => {
      const list = live() ?? []
      const index = list.findIndex((entry) => entry.id === project.id)
      await replace(await props.source.deleteProject(project))
      setChosen((list[index + 1] ?? list[index - 1])?.id)
    })
  const restore = async (project: LibraryProject) => {
    setRestoreFailed(undefined)
    try {
      await replace(await props.source.restoreProject(project))
      setChosen(project.id)
      setNarrowDetail(true)
      if (newProject()) props.shell.showProjects()
    } catch {
      setRestoreFailed(project.name)
    }
  }

  const open = (project: LibraryProject) => {
    if (!runsOn(project.id)) return
    setBannerShown(true)
    props.shell.openProject(project.id, runsOn(project.id))
  }

  const outputsHidden = (project: string) => {
    hiddenChange()
    return readFlag(pageKey(project, 'outputsHidden'))
  }
  const toggleOutputs = (project: string) => {
    writeFlag(pageKey(project, 'outputsHidden'), !outputsHidden(project))
    setHiddenChange((n) => n + 1)
  }

  const detail = (project: () => LibraryProject) => {
    const data = () => projectDetail.value()?.project.id === project().id ? projectDetail.value() : undefined
    const workflows = () => data()?.workflows
    const outputs = () => data()?.outputs
    const usage = () => data()?.usage
    const definitions = () => data()?.definitions
    const packs = createMemo(() => {
      const needs = data()?.needs
      if (!needs) return undefined
      const required = new Set(needs.packs.map(({ pack }) => pack))
      const added = new Set(needs.extra.filter((pack) => !required.has(pack)))
      const unchecked = needs.unknown.length
      const count = required.size
      const value = unchecked > 0
        ? count > 0 ? message('projects.packs.atLeast', { count }) : message('projects.packs.unknown')
        : count > 0 ? message('projects.packs.needed', { count }) : message('projects.packs.none')
      return {
        value: value + (added.size > 0 ? message('projects.packs.added', { count: added.size }) : ''),
        unchecked: unchecked > 0 ? message(count > 0 ? 'projects.packs.uncheckedYet' : 'projects.packs.unchecked', { count: unchecked }) : '',
        names: [...required, ...added].sort().join('\n'),
      }
    })
    const packFact = {
      get label() { return message('projects.facts.packs') },
      value: <ProductPageAnswer page={projectDetail}><span data-tooltip-label={packs()?.names || undefined}>
        {data() ? packs()?.value ?? message('projects.packs.unknown') : ''}
        <Show when={packs()?.unchecked}><span class="dinkster-project-fact-detail">{'. '}{packs()!.unchecked}</span></Show>
      </span></ProductPageAnswer>,
    }
    const time = () => projectTime(project())
    const here = () => opening()?.projectId === project().id ? opening() : undefined
    const installation = () => runsOn(project().id)
    const unavailable = () => message(installations() === null ? 'projects.facts.unknownInstallation' : 'projects.open.noInstallation')
    const locationFacts = createMemo(() => [
      ...(project().filesFolder || project().folder ? [{
        label: message('projects.facts.filesFolder'),
        value: <ProductPageAnswer page={page}>{project().filesFolder ?? project().folder}</ProductPageAnswer>,
        action: <Show when={installations()?.openFolder}>
          <ProductTextButton label={message('projects.facts.showInFolder')} onClick={() => {
            setFolderFailed(undefined)
            props.source.openFolder(project().id).catch(() => setFolderFailed(project().id))
          }} />
        </Show>,
      }] : []),
      {
        label: message('projects.facts.runsOn'),
        value: <ProductPageAnswer page={page}>
          {installation()?.name ?? message(installations() === null ? 'projects.facts.unknownInstallation' : 'projects.facts.noInstallation')}
          <Show when={installation()}><span class="dinkster-project-fact-detail">{' - '}{message('projects.facts.thisComputer')}</span></Show>
        </ProductPageAnswer>,
        action: <Show when={(installations()?.all.length ?? 0) > 1}>
          <ProductMenu label={message('projects.facts.change')} items={(installations()?.all ?? []).map((row) => ({
            label: row.name,
            onSelect: () => {
              writeChoice(pageKey(project().id, 'runsOn'), row.root)
              setRunsOnChoice((n) => n + 1)
            },
          }))} />
        </Show>,
      },
    ])
    return (
      <>
      <ProductPageLoad
        page={projectDetail}
        read={() => readDetail(project())}
        loadingLabel={message('projects.detail.loading')}
        arrival="fade"
        known={<>
        <ProductProjectHeader
          title={project().name}
          subtitle={time() === null ? message('projects.time.neverOpened') : message('projects.time.opened', { when: when(time()!) })}
          actions={
            <Show
              when={here() && here()!.failed === undefined}
              fallback={
                <>
                  <ProductMenu
                    label={message('projects.menu.label')}
                    icon={Ellipsis}
                    iconOnly
                    items={[
                      {
                        label: message('projects.menu.rename'),
                        onSelect: () => {
                          setNewName(project().name)
                          setDialog('rename')
                        },
                      },
                      // The default project cannot be deleted, so it has no Delete.
                      ...(project().id === DEFAULT_PROJECT_ID
                        ? []
                        : [
                            'separator' as const,
                            {
                              label: message('projects.menu.delete'),
                              intent: 'remove' as const,
                              onSelect: () => setDialog('delete'),
                            },
                          ]),
                    ]}
                  />
                  <ProductButton
                    fill="solid"
                    aria-disabled={installation() ? undefined : 'true'}
                    data-tooltip-label={installation() ? undefined : unavailable()}
                    data-testid="projects-open"
                    onClick={() => {
                      if (installation()) open(project())
                    }}
                  >
                    {here()?.failed !== undefined ? message('projects.action.tryAgain') : message('projects.action.open')}
                  </ProductButton>
                </>
              }
            >
              <ProductButton onClick={() => props.shell.cancelOpening()}>{message('projects.action.cancel')}</ProductButton>
              <ProductButton fill="solid" pending>
                {message('projects.action.opening')}
              </ProductButton>
            </Show>
          }
        />
        <Show when={here()?.failed !== undefined && bannerShown()}>
          <ProductErrorBanner onDismiss={() => setBannerShown(false)}>
            {message('projects.failed.banner', { failed: here()!.failed!, project: project().name })}
            <Show when={here()?.showLog}>
              {' '}<ProductTextButton label={message('shell.engine.showLog')} onClick={() => setLogProject(project().id)} />
            </Show>
          </ProductErrorBanner>
        </Show>
        <Show when={logProject() === project().id}>
          <EngineLogDialog baseUrl="" onDismiss={() => setLogProject(undefined)} />
        </Show>
        <Show when={restoreFailed()}>
          {(name) => (
            <ProductErrorBanner onDismiss={() => setRestoreFailed(undefined)}>
              {message('projects.restore.failed', { project: name() })}
            </ProductErrorBanner>
          )}
        </Show>
        <Show when={folderFailed() === project().id}>
          <ProductErrorBanner onDismiss={() => setFolderFailed(undefined)}>
            {message('projects.facts.folderFailed')}
          </ProductErrorBanner>
        </Show>
        <Show when={data()}>
        <Show when={firstRun()}>{setupInstructions()}</Show>
        </Show>
        <ProductProjectFacts
          label={message('projects.facts.label')}
          columns={[
            locationFacts(),
            [
              packFact,
              ...(usage() ? [
                {
                  label: message('projects.facts.size'),
                  value: <ProductPageAnswer page={projectDetail}>
                    {formatBytes(usage()!.bytes, locale().tag)}
                    <span class="dinkster-project-fact-detail">{' - '}{message('projects.facts.outputs', { count: usage()!.outputs })}</span>
                  </ProductPageAnswer>,
                },
              ] : []),
            ],
          ]}
        />
        <ProductProjectSection
          title={message('projects.workflows.title')}
          aside={<span class="dinkster-metadata">{workflows()?.length ?? ''}</span>}
        />
        </>}
      >
        <div class="projects-page-detail">
            <Show
              when={(workflows()?.length ?? 0) > 0}
              fallback={
                <ProductEmptyState
                  message={message(workflows() === null ? 'projects.workflows.unreadable' : installation() ? 'projects.workflows.empty' : 'projects.workflows.emptyWithoutInstallation')}
                />
              }
            >
              <ProductTileGrid size="wide">
                <For each={workflows()}>
                  {(workflow) => {
                    // Draw saved documents as the minimap does; unreadable documents keep the icon.
                    const document = () => data()?.documents.get(workflow.digest)
                    return (
                      <ProductTile
                        label={workflow.name}
                        caption={workflow.name}
                        disabled={!installation()}
                        tooltip={installation() ? undefined : unavailable()}
                        // Library records carry seconds.
                        detail={when(workflow.modified * 1000)}
                        picture={
                          document() ? (
                            <WorkflowPicture document={document()!} resolve={definitions() ?? noDefinitions} widgets={widgets} />
                          ) : undefined
                        }
                        empty={<ProductIcon icon={Workflow} />}
                        onClick={() => open(project())}
                      />
                    )
                  }}
                </For>
              </ProductTileGrid>
            </Show>
        <ProductProjectSection
          title={message('projects.outputs.title')}
          aside={
            <Show when={(outputs()?.length ?? 0) > 0}>
              <Show
                when={outputsHidden(project().id)}
                fallback={
                  <ProductTextButton
                    label={message('projects.outputs.hide')}
                    icon={EyeOff}
                    onClick={() => toggleOutputs(project().id)}
                  />
                }
              >
                <span class="dinkster-actions">
                  <span class="dinkster-metadata">{message('projects.outputs.hidden')}</span>
                  <ProductTextButton
                    label={message('projects.outputs.show')}
                    icon={Eye}
                    onClick={() => toggleOutputs(project().id)}
                  />
                </span>
              </Show>
            </Show>
          }
        >
          <Show
            when={(outputs()?.length ?? 0) > 0}
            fallback={
              <ProductEmptyState
                message={message(outputs() === null ? 'projects.outputs.unreadable' : 'projects.outputs.empty')}
              />
            }
          >
            <Show when={!outputsHidden(project().id)}>
              <ProductTileGrid size="narrow">
                <For each={outputs()}>
                  {(output) => {
                    const [pictureFailed, setPictureFailed] = createSignal(false)
                    return (
                      <ProductTile
                        label={output.asset.name}
                        disabled={!installation()}
                        tooltip={installation() ? undefined : unavailable()}
                        picture={output.asset.mediaType.startsWith('image/') && !pictureFailed()
                          ? <img src={`/api/assets/${encodeURIComponent(output.asset.digest)}/preview`} alt="" loading="lazy" onError={() => setPictureFailed(true)} />
                          : undefined}
                        empty={
                          <>
                            <ProductIcon icon={output.asset.mediaType.startsWith('image/') ? ImageIcon : output.asset.mediaType.startsWith('audio/') ? AudioLines : File} />
                            <span>{output.asset.name}</span>
                            <span>{output.asset.mediaType.split('/')[0]}</span>
                          </>
                        }
                        onClick={() => open(project())}
                      />
                    )
                  }}
                </For>
              </ProductTileGrid>
            </Show>
          </Show>
        </ProductProjectSection>
        </div>
      </ProductPageLoad>
        <Show when={dialog() === 'rename'}>
          <ProductDialog title={message('projects.rename.title')} onDismiss={closeDialog} pending={busy()}
            action={<ProductButton type="submit" form={renameForm} fill="solid" disabled={newName().trim() === '' || busy()}>{message('projects.rename.save')}</ProductButton>}>
            <form
              id={renameForm}
              class="dinkster-stack"
              onSubmit={(event) => {
                event.preventDefault()
                if (newName().trim() !== '') void rename(project())
              }}
            >
              <ProductField
                label={message('projects.new.name')}
                {...(dialogError() === undefined ? {} : { error: dialogError()! })}
              >
                {(attributes) => (
                  <ProductTextInput
                    {...attributes}
                    value={newName()}
                    autofocus
                    onInput={(event) => setNewName(event.currentTarget.value)}
                  />
                )}
              </ProductField>
            </form>
          </ProductDialog>
        </Show>
        <Show when={dialog() === 'delete'}>
          <ProductConfirmationDialog
            title={message('projects.delete.title', { project: project().name })}
            consequence={message('projects.delete.consequence')}
            error={dialogError()}
            actionLabel={message('projects.delete.action')}
            intent="remove"
            pending={busy()}
            onConfirm={() => void remove(project())}
            onCancel={closeDialog}
          />
        </Show>
      </>
    )
  }

  const [name, setName] = createSignal('')
  const [newInstallation, setNewInstallation] = createSignal<string>()
  const creationInstallations = createMemo<readonly PageInstallation[]>((previous) => installations()?.all ?? previous, [])
  const creationProjects = createMemo<readonly LibraryProject[]>((previous) => live() ?? previous, [])
  const chosenInstallation = () => creationInstallations().find((row) => row.root === newInstallation())
    ?? installations()?.open ?? creationInstallations()[0]
  const [createError, setCreateError] = createSignal<string>()
  const [creating, setCreating] = createSignal(false)
  const [creationAttempt, setCreationAttempt] = createSignal<{ readonly id: string; readonly creation: ProjectCreation }>()
  const [filesChoice, setFilesChoice] = createSignal<string>()
  const [folderDraft, setFolderDraft] = createSignal<string>()
  const [choosingFolder, setChoosingFolder] = createSignal(false)
  const [startChoice, setStartChoice] = createSignal('empty')
  const [copySource, setCopySource] = createSignal<string>()
  const [workflowFile, setWorkflowFile] = createSignal<{ readonly name: string; readonly content: string }>()
  const [readingWorkflow, setReadingWorkflow] = createSignal(false)
  const [workflowError, setWorkflowError] = createSignal<string>()
  let workflowInput!: HTMLInputElement
  const creationLocked = () => creating() || readingWorkflow() || choosingFolder() || creationAttempt() !== undefined
  const filesFolder = () => {
    const held = creationAttempt()?.creation.filesFolder ?? filesChoice()
    if (held !== undefined) return held
    const parent = installations()?.projectsFolder
    if (!parent) return ''
    const leaf = name().trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/gu, '') || 'project'
    return `${parent.replace(/[\\/]+$/u, '')}${parent.includes('\\') ? '\\' : '/'}${leaf}`
  }
  const startingProject = () => copySource() ?? selected()?.id
  const startingContents = (): ProjectCreation['startWith'] => creationAttempt()?.creation.startWith ?? (startChoice() === 'workflow'
    ? workflowFile() && { kind: 'workflow', ...workflowFile()! }
    : startChoice() === 'project'
      ? live()?.some((row) => row.id === startingProject()) ? { kind: 'project', project: startingProject()! } : undefined
      : { kind: 'empty' })
  const chooseFilesFolder = async () => {
    setChoosingFolder(true)
    try {
      const bridge = desktopFileBridge()
      const url = new URL('/', location.href).href
      if (bridge && (await bridge.fileCapabilities(url)).nativeFolderChoice) {
        const chosen = await bridge.chooseDirectory(url)
        if (chosen) setFilesChoice(chosen)
      } else setFolderDraft(filesFolder())
    } catch {
      setCreateError(message('projects.new.folderFailed'))
    } finally {
      setChoosingFolder(false)
    }
  }
  const readWorkflow = async (file: File) => {
    setReadingWorkflow(true)
    setWorkflowFile(undefined)
    setWorkflowError(undefined)
    try {
      const content = await file.text()
      if (!loadDocument(JSON.parse(content) as unknown).document) throw new Error('unreadable workflow')
      setWorkflowFile({ name: file.name.replace(/\.json$/iu, ''), content })
    } catch {
      setWorkflowError(message('projects.new.workflowFailed'))
    } finally {
      setReadingWorkflow(false)
    }
  }
  const create = async () => {
    const trimmed = name().trim()
    const startWith = startingContents()
    if (trimmed === '' || creating() || readingWorkflow() || choosingFolder() || !filesFolder().trim() || !startWith) return
    const installationRoot = newInstallation() ?? chosenInstallation()?.root
    setNewInstallation(installationRoot)
    setCreating(true)
    try {
      const attempt = creationAttempt() ?? { id: `p-${uuidv4()}`, creation: { filesFolder: filesFolder(), startWith } }
      setCreationAttempt(attempt)
      if (startWith.kind === 'project') setCopySource(startWith.project)
      const registered = await props.source.registerProject(attempt.id, trimmed, attempt.creation)
      const project = registered.name === trimmed ? registered : await props.source.renameProject(registered, trimmed)
      if (installationRoot) writeChoice(pageKey(project.id, 'runsOn'), installationRoot)
      await setProjects((list) => byProjectTime([...(list ?? []).filter((entry) => entry.id !== project.id), project]))
      setChosen(project.id)
      setName('')
      setNarrowDetail(true)
      setCreateError(undefined)
      setCreationAttempt(undefined)
      setFilesChoice(undefined)
      setStartChoice('empty')
      setCopySource(undefined)
      setWorkflowFile(undefined)
      setWorkflowError(undefined)
      props.shell.showProjects()
    } catch {
      setCreateError(message('projects.new.failed'))
    } finally {
      setCreating(false)
    }
  }
  const backToList = () => {
    setNarrowDetail(false)
    props.shell.showProjects()
  }
  const cancelCreation = () => {
    setCreationAttempt(undefined)
    setCreateError(undefined)
    backToList()
  }
  const newProjectForm = () => (
    <>
      <ProductProjectHeader title={message('projects.new.title')} />
      <Show when={createError()}>{(error) => <ProductErrorBanner onDismiss={() => setCreateError(undefined)}>{error()}</ProductErrorBanner>}</Show>
      <form
        class="dinkster-project-form"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <label for="new-project-name">{message('projects.new.name')}</label>
        <ProductTextInput
          id="new-project-name"
          value={name()}
          autofocus
          disabled={creating()}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <div class="dinkster-project-form-folder">
          <span>{message('projects.facts.filesFolder')}</span>
          <span class="dinkster-project-form-path">
            <span data-testid="new-project-files" data-tooltip-label={filesFolder() || undefined}>{filesFolder() || message('projects.new.folderUnknown')}</span>
            <ProductTextButton label={message('projects.facts.change')} disabled={creationLocked()} onClick={() => { void chooseFilesFolder() }} />
          </span>
        </div>
        <label for="new-project-runs-on">{message('projects.facts.runsOn')}</label>
        <ProductSelect id="new-project-runs-on" value={chosenInstallation()?.root ?? ''}
          disabled={creating() || installations() === null || creationInstallations().length === 0}
          onChange={(event) => setNewInstallation(event.currentTarget.value)}>
          <Show when={creationInstallations().length > 0} fallback={<option value="">{message(installations() === null ? 'projects.facts.unknownInstallation' : 'projects.facts.noInstallation')}</option>}>
            <For each={creationInstallations()}>{(row) => <option value={row.root}>{row.name} - {message('projects.facts.thisComputer')}</option>}</For>
          </Show>
        </ProductSelect>
        <span>{message('projects.new.startWith')}</span>
        <div class="dinkster-stack">
          <ProductSegmented label={message('projects.new.startWith')} value={startChoice()} onChange={setStartChoice}
            options={[
              { value: 'empty', label: message('projects.new.empty') },
              { value: 'workflow', label: message('projects.new.workflowFile') },
              { value: 'project', label: message('projects.new.copyProject') },
            ].map((option) => ({ ...option, ...(creationLocked() ? { disabled: message('projects.new.choicesLocked') } : {}) }))} />
          <Show when={startChoice() === 'workflow'}>
            <ProductField label={message('projects.new.workflowFile')} error={workflowError() ?? ''}>{(attributes) => <div class="dinkster-project-form-path">
              <span>{workflowFile()?.name ?? message('projects.new.noWorkflow')}</span>
              <ProductButton {...attributes} disabled={creationLocked()} onClick={() => workflowInput.click()}>{message('projects.new.chooseWorkflow')}</ProductButton>
              <ProductFileInput ref={workflowInput} accept=".json,application/json" disabled={creationLocked()} onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) void readWorkflow(file)
              }} />
            </div>}</ProductField>
          </Show>
          <Show when={startChoice() === 'project'}>
            <ProductField label={message('projects.new.copyProject')}>{(attributes) => <ProductSelect {...attributes} value={startingProject() ?? ''} disabled={creationLocked() || projects() === null || !creationProjects().length} onChange={(event) => setCopySource(event.currentTarget.value)}>
              <For each={creationProjects()}>{(row) => <option value={row.id}>{row.name}</option>}</For>
            </ProductSelect>}</ProductField>
          </Show>
        </div>
        <div class="dinkster-actions">
          <ProductButton disabled={creating()} onClick={cancelCreation}>{message('projects.action.cancel')}</ProductButton>
          <ProductButton type="submit" intent="add" fill="solid" disabled={name().trim() === '' || !filesFolder().trim() || !startingContents() || creating() || readingWorkflow() || choosingFolder()}>
            {message('projects.new.create')}
          </ProductButton>
        </div>
      </form>
      <Show when={folderDraft() !== undefined}>
        <ProductDialog title={message('projects.new.changeFolder')} onDismiss={() => setFolderDraft(undefined)}
          action={<ProductButton type="submit" form={folderForm} disabled={!folderDraft()!.trim()}>{message('projects.new.useFolder')}</ProductButton>}>
          <form id={folderForm} class="dinkster-stack" onSubmit={(event) => { event.preventDefault(); if (folderDraft()!.trim()) { setFilesChoice(folderDraft()!.trim()); setFolderDraft(undefined) } }}>
            <ProductField label={message('projects.facts.filesFolder')}>{(attributes) => <ProductTextInput {...attributes} value={folderDraft()} onInput={(event) => setFolderDraft(event.currentTarget.value)} required />}</ProductField>
          </form>
        </ProductDialog>
      </Show>
    </>
  )

  const setupInstructions = () => (
    <SetupForm surface="projects" onStatusChange={props.onSetupStatusChange} onInstallation={() => void rereadPage()} />
  )
  const setup = () => (
      <div class="projects-page-first-run" data-testid="projects-first-run">
        {setupInstructions()}
      </div>
  )
  const displayed = createMemo(() => live()?.some((project) => project.id === projectDetail.value()?.project.id) ? projectDetail.value()?.project : selected())

  return (
    <div class="projects-page-content" data-testid="projects-content">
    <Show when={!setupOnly()} fallback={setup()}>
      <ProductProjectsView
        narrowPanel={newProject() || narrowDetail() ? 'detail' : 'list'}
        back={{ label: message('projects.title'), onSelect: backToList, disabled: creating() }}
        list={
          <>
          <ProductProjectListHeader
            id={projectHeading}
            title={message('projects.title')}
            newLabel={message('projects.action.new')}
            onNew={() => props.shell.showProjects({ newProject: true })}
          />
          <ProductPageAnswer page={page}>
          <ProductProjectRows
            labelledBy={projectHeading}
            projects={entries}
            selected={newProject() ? undefined : selectedId()}
            onSelect={(id) => {
              setChosen(id)
              setNarrowDetail(true)
              if (newProject()) props.shell.showProjects()
            }}
            loadingLabel={message('projects.loading')}
            deleted={{
              title: message('projects.deleted.title', { count: gone()?.length ?? 0 }),
              restoreLabel: message('projects.deleted.restore'),
              rows: (gone() ?? []).map((project) => ({
                id: project.id,
                name: project.name,
                detail: Date.now() - deletedAt(project) < 60_000
                  ? message('projects.deleted.justNow')
                  : message('projects.deleted.when', { when: when(deletedAt(project)) }),
              })),
              onRestore: (id) => {
                const project = gone()?.find((entry) => entry.id === id)
                if (project) void restore(project)
              },
            }}
          />
          </ProductPageAnswer>
          </>
        }
      >
        <Show when={!newProject()} fallback={newProjectForm()}>
          <Show
            when={displayed()?.id}
            keyed
            fallback={
              <>
              <ProductPageLoad page={page} read={readPage} loadingLabel={message('projects.loading')} arrival="fade">
              <Show when={!selected()}>
                  <ProductEmptyState message={message(projects() === null ? 'projects.unreadable' : 'projects.empty')} />
              </Show>
              </ProductPageLoad>
              </>
            }
          >
            {(_id) => detail(() => displayed()!)}
          </Show>
        </Show>
      </ProductProjectsView>
    </Show>
    </div>
  )
}

/** A deleted project's record changes no more, so its last change is when it was deleted. */
const deletedAt = (project: LibraryProject) => Date.parse(project.modified ?? project.created)

const widgets = createWidgetRegistry()
registerCoreWidgets(widgetRegistrationDoors(widgets))
const noDefinitions: SchemaResolver = () => undefined

const ENGINE_WORDS: Record<EngineState, string> = {
  stopped: 'shell.engine.notRunning',
  starting: 'shell.engine.starting',
  ready: 'shell.engine.notRunning',
  failed: 'shell.engine.failed',
}

/** The connection dot: grey with no engine, the editor's green when one is ready, warning otherwise. */
const engineDot = (state: EngineState | undefined) =>
  state === 'ready' ? 'connected' : state === 'starting' || state === 'failed' ? state : 'no-engine'

function writeChoice(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Storage that refuses writes keeps the default installation.
  }
}

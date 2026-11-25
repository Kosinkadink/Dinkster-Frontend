/**
 * The projects page under the always-on process: every project in the shared
 * library on the left, the selected one on the right with where it runs, its
 * workflows and its latest outputs. It reads the process with no engine
 * running. Opening a project goes through the shell, which writes the opening
 * line and the failure the page draws.
 */
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch, type Resource } from 'solid-js'
import { AudioLines, BookOpen, Database, Ellipsis, Eye, EyeOff, LayoutGrid, Search, Server, Workflow } from 'lucide-solid'
import { activeLocale, asConnectionId, loadDocument, type SchemaResolver, type WorkflowDocument } from '@dinkster/core'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import {
  buildDinksterRegistry,
  DinksterConnection,
  type LibraryProject,
  type LibraryRecord,
  type LocalAssetCatalogEntry,
} from '@dinkster/client'
import {
  ProductBrandMark,
  ProductButton,
  ProductCodeBlock,
  ProductConfirmation,
  ProductDialog,
  ProductEmptyState,
  ProductErrorBanner,
  ProductField,
  ProductIcon,
  ProductLoading,
  ProductMenu,
  ProductProjectFacts,
  ProductProjectHeader,
  ProductProjectList,
  ProductProjectSection,
  ProductProjectsView,
  ProductTextButton,
  ProductTextInput,
  ProductTile,
  ProductTileGrid,
  ProductWindowAction,
  ProductWindowToolbar,
  type ProductProjectEntry,
} from '@dinkster/ui'
import { useAppMessage } from '../locale.js'
import { AccountControl, createAccountSession } from '../AccountControl.js'
import { ActivityBarButton, IconBar, ShellTooltip } from '../ShellChrome.js'
import { attachDomTooltips, TooltipController, type DomTooltipTarget } from '../tooltips.js'
import { useSignal } from '../solid-adapter.js'
import { DEFAULT_PROJECT_ID } from '../projects.js'
import '@dinkster/ui/styles.css'
import './projects-page.css'
import { byProjectTime, formatBytes, formatWhen, projectTime } from './project-facts.js'
import { WorkflowPicture } from './workflow-picture.js'

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
  registerProject(id: string, name: string): Promise<LibraryProject>
  renameProject(project: LibraryProject, name: string): Promise<LibraryProject>
  deleteProject(project: LibraryProject): Promise<LibraryProject>
  restoreProject(project: LibraryProject): Promise<LibraryProject>
  listWorkflows(project: string): Promise<readonly LibraryRecord[]>
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
    | { readonly projectId: string; readonly line: string; readonly reason?: string; readonly failed?: string }
    | undefined
  readonly selectedProjectId: () => string | undefined
  openProject(projectId: string, installation?: PageInstallation): void
  showProjects(options?: { readonly newProject?: boolean }): void
  cancelOpening(): void
}

const OUTPUT_LIMIT = 6

/** Keep settled content during rereads, and never flash a brief loading sign. */
function createArrival<T>(resource: Resource<T>) {
  const [value, setValue] = createSignal<T>()
  const [loading, setLoading] = createSignal(false)
  let hasValue = false
  let loadingAt: number | undefined
  createEffect(() => {
    const latest = resource.latest
    const pending = resource.loading
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!pending && latest !== undefined) {
      const reveal = () => {
        hasValue = true
        setValue(() => latest)
        setLoading(false)
      }
      const remaining = loadingAt === undefined ? 0 : Math.max(0, 300 - (Date.now() - loadingAt))
      if (remaining) timer = setTimeout(reveal, remaining)
      else reveal()
    } else if (pending && !hasValue) {
      timer = setTimeout(() => {
        loadingAt = Date.now()
        setLoading(true)
      }, 200)
    }
    onCleanup(() => clearTimeout(timer))
  })
  return { value, loading }
}

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
    registerProject: (id, name) => connection.registerProject(id, name),
    renameProject: (project, name) => connection.renameProject(project.id, name, project.revision),
    deleteProject: (project) => connection.deleteProject(project.id, project.revision),
    restoreProject: (project) => connection.restoreProject(project.id, project.revision),
    async listWorkflows(project) {
      const page = await connection.listLibrary({ scope: 'local', label: 'workflow', project, limit: 200 })
      return page.records
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
        { state?: EngineState; open?: { root: string; engine: string }; openFolder?: boolean },
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
  const [engine, setEngine] = createSignal<{ state?: EngineState; open?: PageInstallation }>({})
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
      items={[{ label: message('projects.new.title'), onSelect: () => props.shell.showProjects({ newProject: true }) }]}
    />
  )
  return (
    <div class="shell" data-testid="projects-page" ref={frame}>
      <h1 class="visually-hidden">{message('shell.applicationTitle')}</h1>
      <ProductWindowToolbar
        title={message('shell.applicationControls')}
        platform="linux"
        brand={logo()}
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
              <ProjectsView shell={props.shell} source={source} onCount={setCount} onEngine={setEngine} />
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
          </span>
          <Show when={engine().state}><span class="status-item" data-testid="projects-engine-status">
            {engine().state === 'ready' && engine().open
              ? message('projects.status.ready', { installation: engine().open!.name })
              : message(ENGINE_WORDS[engine().state ?? 'stopped'])}
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
  readonly onEngine?: (engine: { state?: EngineState; open?: PageInstallation }) => void
}) {
  const message = useAppMessage()
  const locale = useSignal(activeLocale)
  // A read that fails resolves to null, so one missing route leaves the rest of the page working.
  const [page, { mutate: setPage, refetch: rereadPage }] = createResource(async () => {
    const [projects, installations] = await Promise.all([
      props.source.listProjects().then(byProjectTime, () => null),
      props.source.installations().catch(() => null),
    ])
    return { projects, installations }
  })
  const arrival = createArrival(page)
  const projects = () => arrival.value()?.projects
  const installations = () => arrival.value()?.installations
  const setProjects = (update: (list: LibraryProject[] | null) => LibraryProject[] | null | undefined) =>
    setPage((current) => current && { ...current, projects: update(current.projects) ?? null })
  const painted = () => arrival.value() !== undefined
  // Set up runs in a terminal, so the page reads the list again when the user comes back to it.
  const firstRun = () => installations()?.all.length === 0
  onMount(() => {
    const reread = () => {
      void rereadPage()
    }
    globalThis.addEventListener('focus', reread)
    onCleanup(() => globalThis.removeEventListener('focus', reread))
  })
  // The list holds deleted projects too; they show only under "Deleted projects".
  const live = () => projects()?.filter((project) => !project.deleted)
  const setupOnly = () => firstRun() && projects()?.length === 0
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
    if (painted() && found) props.onEngine?.({ ...(found.engine ? { state: found.engine } : {}), ...(found.open ? { open: found.open } : {}) })
  })
  const [chosen, setChosen] = createSignal<string>()
  const [bannerShown, setBannerShown] = createSignal(true)
  const [folderFailed, setFolderFailed] = createSignal<string>()
  const [runsOnChoice, setRunsOnChoice] = createSignal(0)
  const [hiddenChange, setHiddenChange] = createSignal(0)
  const [restoreFailed, setRestoreFailed] = createSignal<string>()

  const selectedId = (): string | undefined =>
    chosen() ?? props.shell.selectedProjectId() ?? live()?.[0]?.id
  const selected = createMemo(() => live()?.find((project) => project.id === selectedId()))
  const [projectDetail] = createResource(selected, async (project) => {
    const [workflows, outputs, usage, definitions] = await Promise.all([
      props.source.listWorkflows(project.id).catch(() => null),
      props.source.listOutputs(project.id, OUTPUT_LIMIT).catch(() => null),
      props.source.usage(project.id).catch(() => undefined),
      props.source.definitions(project.id).catch(() => undefined),
    ])
    const documents = new Map(await Promise.all((workflows ?? []).map(async (workflow) =>
      [workflow.digest, await props.source.workflowDocument(workflow.digest).catch(() => undefined)] as const,
    )))
    return { project, workflows, outputs, usage, definitions, documents }
  })
  const detailArrival = createArrival(projectDetail)

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

  const entries = (): ProductProjectEntry[] | undefined => {
    const list = live()
    if (!list) return undefined
    const now = opening()
    return list.map((project) => {
      const time = projectTime(project)
      const entry: ProductProjectEntry = {
        id: project.id,
        name: project.name,
        detail: message(time.kind === 'ran' ? 'projects.time.ran' : 'projects.time.created', { when: when(time.at) }),
      }
      if (now?.projectId === project.id) {
        entry.state = now.failed !== undefined ? 'failed' : 'opening'
        entry.detail = now.failed ?? now.line
        entry.reason = now.reason
      }
      return entry
    })
  }

  const [dialog, setDialog] = createSignal<'rename' | 'delete'>()
  const [dialogError, setDialogError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [newName, setNewName] = createSignal('')
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
      setProjects((list) => list?.map((entry) => (entry.id === renamed.id ? renamed : entry)))
    })
  const replace = (changed: LibraryProject) =>
    setProjects((list) => list && byProjectTime(list.map((entry) => (entry.id === changed.id ? changed : entry))))
  // After Delete the next project down is selected, or the one above when it was the last.
  const remove = (project: LibraryProject) =>
    act(async () => {
      const list = live() ?? []
      const index = list.findIndex((entry) => entry.id === project.id)
      replace(await props.source.deleteProject(project))
      setChosen((list[index + 1] ?? list[index - 1])?.id)
    })
  const restore = async (project: LibraryProject) => {
    setRestoreFailed(undefined)
    try {
      replace(await props.source.restoreProject(project))
      setChosen(project.id)
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

  const detail = (data: NonNullable<ReturnType<typeof projectDetail>>) => {
    const { project } = data
    const workflows = () => data.workflows
    const outputs = () => data.outputs
    const usage = () => data.usage
    const definitions = () => data.definitions
    const time = projectTime(project)
    const here = () => opening()?.projectId === project.id ? opening() : undefined
    const installation = () => runsOn(project.id)
    const unavailable = () => message(installations() === null ? 'projects.facts.unknownInstallation' : 'projects.open.noInstallation')
    return (
      <div class="projects-page-arrival projects-page-detail" data-testid="projects-detail">
        <ProductProjectHeader
          title={project.name}
          subtitle={message(time.kind === 'ran' ? 'projects.time.lastRun' : 'projects.time.created', {
            when: when(time.at),
          })}
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
                          setNewName(project.name)
                          setDialog('rename')
                        },
                      },
                      // The default project cannot be deleted, so it has no Delete.
                      ...(project.id === DEFAULT_PROJECT_ID
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
                      if (installation()) open(project)
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
          <ProductErrorBanner quiet onDismiss={() => setBannerShown(false)}>
            {message('projects.failed.banner', { failed: here()!.failed!, project: project.name })}
          </ProductErrorBanner>
        </Show>
        <Show when={restoreFailed()}>
          {(name) => (
            <ProductErrorBanner quiet onDismiss={() => setRestoreFailed(undefined)}>
              {message('projects.restore.failed', { project: name() })}
            </ProductErrorBanner>
          )}
        </Show>
        <Show when={folderFailed() === project.id}>
          <ProductErrorBanner quiet onDismiss={() => setFolderFailed(undefined)}>
            {message('projects.facts.folderFailed')}
          </ProductErrorBanner>
        </Show>
        <Show when={firstRun()}>{setupInstructions()}</Show>
        <ProductProjectFacts
          label={message('projects.facts.label')}
          columns={[
            [
              // The folder is the project's output folder, so the fact says Outputs; with no folder there is no fact.
              ...(project.folder
                ? [
                    {
                      label: message('projects.facts.outputsFolder'),
                      value: project.folder,
                      action: (
                        <Show when={installations()?.openFolder}>
                          <ProductTextButton
                            label={message('projects.facts.showInFolder')}
                            onClick={() => {
                              setFolderFailed(undefined)
                              props.source.openFolder(project.id).catch(() => setFolderFailed(project.id))
                            }}
                          />
                        </Show>
                      ),
                    },
                  ]
                : []),
              {
                label: message('projects.facts.runsOn'),
                value: installation()?.name ?? message(installations() === null ? 'projects.facts.unknownInstallation' : 'projects.facts.noInstallation'),
                detail: installation() ? message('projects.facts.thisComputer') : undefined,
                action: (
                  <Show when={(installations()?.all.length ?? 0) > 1}>
                    <ProductMenu
                      label={message('projects.facts.change')}
                      items={(installations()?.all ?? []).map((row) => ({
                        label: row.name,
                        onSelect: () => {
                          writeChoice(pageKey(project.id, 'runsOn'), row.root)
                          setRunsOnChoice((n) => n + 1)
                        },
                      }))}
                    />
                  </Show>
                ),
              },
            ],
            usage()
              ? [
                  {
                    label: message('projects.facts.size'),
                    value: formatBytes(usage()!.bytes, locale().tag),
                    detail: message('projects.facts.outputs', { count: usage()!.outputs }),
                  },
                ]
              : [],
          ]}
        />
        <ProductProjectSection
          title={message('projects.workflows.title')}
          aside={<span class="dinkster-metadata">{workflows()?.length ?? ''}</span>}
        >
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
                    const document = () => data.documents.get(workflow.digest)
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
                        onClick={() => open(project)}
                      />
                    )
                  }}
                </For>
              </ProductTileGrid>
            </Show>
        </ProductProjectSection>
        <ProductProjectSection
          title={message('projects.outputs.title')}
          aside={
            <Show when={(outputs()?.length ?? 0) > 0}>
              <Show
                when={outputsHidden(project.id)}
                fallback={
                  <ProductTextButton
                    label={message('projects.outputs.hide')}
                    icon={EyeOff}
                    onClick={() => toggleOutputs(project.id)}
                  />
                }
              >
                <span class="dinkster-actions">
                  <span class="dinkster-metadata">{message('projects.outputs.hidden')}</span>
                  <ProductTextButton
                    label={message('projects.outputs.show')}
                    icon={Eye}
                    onClick={() => toggleOutputs(project.id)}
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
            <Show when={!outputsHidden(project.id)}>
              <ProductTileGrid size="narrow">
                <For each={outputs()}>
                  {(output) => (
                    <ProductTile
                      label={output.asset.name}
                      disabled={!installation()}
                      tooltip={installation() ? undefined : unavailable()}
                      empty={
                        <>
                          <ProductIcon icon={AudioLines} />
                          <span>{output.asset.name}</span>
                          <span>{output.asset.mediaType.split('/')[0]}</span>
                        </>
                      }
                      onClick={() => open(project)}
                    />
                  )}
                </For>
              </ProductTileGrid>
            </Show>
          </Show>
        </ProductProjectSection>
        <Show when={dialog() === 'rename'}>
          <ProductDialog title={message('projects.rename.title')} onDismiss={closeDialog} pending={busy()}>
            <form
              class="dinkster-stack"
              onSubmit={(event) => {
                event.preventDefault()
                if (newName().trim() !== '') void rename(project)
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
              <div class="dinkster-actions">
                <ProductButton type="submit" fill="solid" disabled={newName().trim() === '' || busy()}>
                  {message('projects.rename.save')}
                </ProductButton>
                <ProductButton onClick={closeDialog}>{message('projects.action.cancel')}</ProductButton>
              </div>
            </form>
          </ProductDialog>
        </Show>
        <Show when={dialog() === 'delete'}>
          <ProductDialog
            title={message('projects.delete.title', { project: project.name })}
            onDismiss={closeDialog}
            pending={busy()}
          >
            <ProductConfirmation
              consequence={dialogError() ?? message('projects.delete.consequence')}
              actionLabel={message('projects.delete.action')}
              intent="remove"
              pending={busy()}
              onConfirm={() => void remove(project)}
              onCancel={closeDialog}
            />
          </ProductDialog>
        </Show>
      </div>
    )
  }

  const [name, setName] = createSignal('')
  const [creating, setCreating] = createSignal(false)
  const create = async () => {
    const trimmed = name().trim()
    if (trimmed === '' || creating()) return
    setCreating(true)
    try {
      const project = await props.source.registerProject(`p-${crypto.randomUUID()}`, trimmed)
      setProjects((list) => byProjectTime([...(list ?? []), project]))
      setChosen(project.id)
      setName('')
      props.shell.showProjects()
    } finally {
      setCreating(false)
    }
  }
  const newProjectForm = () => (
    <>
      <ProductProjectHeader title={message('projects.new.title')} />
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
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <div class="dinkster-actions">
          <ProductButton onClick={() => props.shell.showProjects()}>{message('projects.action.cancel')}</ProductButton>
          <ProductButton type="submit" intent="add" fill="solid" disabled={name().trim() === '' || creating()}>
            {message('projects.new.create')}
          </ProductButton>
        </div>
      </form>
    </>
  )

  const setupInstructions = () => (
    <div class="dinkster-stack projects-page-setup">
      <ProductCodeBlock label={message('projects.setup.how')} value={SETUP_COMMAND} />
      <p class="dinkster-description">{message('projects.setup.platforms')}</p>
      <p class="dinkster-description">{message('projects.setup.cpuFallback')}</p>
      <p class="dinkster-description">{message('projects.setup.after')}</p>
    </div>
  )
  const setup = () => (
    <ProductProjectsView>
      <div class="dinkster-projects-setup" data-testid="projects-first-run">
        <div class="dinkster-stack projects-page-setup">
          <h1 class="dinkster-title">{message('projects.setup.title')}</h1>
          {setupInstructions()}
        </div>
      </div>
    </ProductProjectsView>
  )

  return (
    <Show when={painted()} fallback={
      <Show when={arrival.loading()}>
        <div class="projects-page-loading projects-page-arrival" data-testid="projects-loading">
          <ProductLoading label={message('projects.loading')} />
        </div>
      </Show>
    }>
    <div class="projects-page-arrival projects-page-content" data-testid="projects-content">
    <Show when={!setupOnly()} fallback={setup()}>
      <ProductProjectsView
        list={
          <ProductProjectList
            title={message('projects.title')}
            newLabel={message('projects.action.new')}
            onNew={() => props.shell.showProjects({ newProject: true })}
            projects={entries() ?? []}
            selected={newProject() ? undefined : selectedId()}
            onSelect={(id) => {
              setChosen(id)
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
        }
      >
        <Show when={!newProject()} fallback={newProjectForm()}>
          <Show
            when={selected() && detailArrival.value()}
            keyed
            fallback={
              <>
              <Show when={!selected()}>
                  <ProductEmptyState message={message(projects() === null ? 'projects.unreadable' : 'projects.empty')} />
              </Show>
              <Show when={selected() && detailArrival.loading()}>
                <div class="projects-page-arrival"><ProductLoading label={message('projects.loading')} /></div>
              </Show>
              </>
            }
          >
            {(data) => detail(data)}
          </Show>
        </Show>
      </ProductProjectsView>
    </Show>
    </div>
    </Show>
  )
}

/** A deleted project's record changes no more, so its last change is when it was deleted. */
const deletedAt = (project: LibraryProject) => Date.parse(project.modified ?? project.created)

/** The process does not report its platform, so show Linux with the other systems named below. */
const SETUP_COMMAND = 'dinkster setup --variant linux-nvidia --channel nightly'

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

/**
 * The projects page under the always-on process: every project in the shared
 * library on the left, the selected one on the right with where it runs, its
 * workflows and its latest outputs. It reads the process with no engine
 * running. Opening a project goes through the shell, which writes the opening
 * line and the failure the page draws.
 */
import { createMemo, createResource, createSignal, For, Index, Show } from 'solid-js'
import { AudioLines, Eye, EyeOff, Workflow } from 'lucide-solid'
import { activeLocale, asConnectionId } from '@dinkster/core'
import {
  DinksterConnection,
  type LibraryProject,
  type LibraryRecord,
  type LocalAssetCatalogEntry,
} from '@dinkster/client'
import {
  ProductButton,
  ProductEmptyState,
  ProductErrorBanner,
  ProductIcon,
  ProductMenu,
  ProductProjectFacts,
  ProductProjectHeader,
  ProductProjectList,
  ProductProjectSection,
  ProductProjectsView,
  ProductSkeleton,
  ProductTextButton,
  ProductTextInput,
  ProductTile,
  ProductTileGrid,
  type ProductProjectEntry,
} from '@dinkster/ui'
import { useAppMessage } from '../locale.js'
import { useSignal } from '../solid-adapter.js'
import { DEFAULT_PROJECT_ID } from '../projects.js'
import { byProjectTime, formatBytes, formatWhen, projectTime } from './project-facts.js'

/** An installation a project can run on. */
export interface PageInstallation {
  readonly root: string
  readonly engine: string
  readonly name: string
}

/** What the page reads; the process in the app, a stand-in in tests. */
export interface ProjectsSource {
  listProjects(): Promise<readonly LibraryProject[]>
  registerProject(id: string, name: string): Promise<LibraryProject>
  listWorkflows(project: string): Promise<readonly LibraryRecord[]>
  listOutputs(project: string, limit: number): Promise<readonly LocalAssetCatalogEntry[]>
  /** Stored bytes and output count; undefined while the process cannot tell. */
  usage(project: string): Promise<{ readonly outputs: number; readonly bytes: number } | undefined>
  /** Every installation, and the one that is open, if any. */
  installations(): Promise<{ readonly all: readonly PageInstallation[]; readonly open?: PageInstallation }>
}

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

/** The page's reads from the always-on process serving this page. */
export function processSource(): ProjectsSource {
  const connection = new DinksterConnection({ id: asConnectionId('projects-page'), baseUrl: '', clientId: 'projects-page' })
  return {
    async listProjects() {
      const projects: LibraryProject[] = []
      let cursor: string | undefined
      do {
        const page = await connection.listProjects(cursor)
        projects.push(...page.items)
        cursor = page.cursor ?? undefined
      } while (cursor !== undefined)
      return projects.filter((project) => !project.deleted)
    },
    registerProject: (id, name) => connection.registerProject(id, name),
    async listWorkflows(project) {
      const page = await connection.listLibrary({ scope: 'local', label: 'workflow', project, limit: 200 })
      return page.records
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
        fetch('/supervisor/status', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : {})),
        fetch('/supervisor/installations', { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : { installations: [] }))
          .catch(() => ({ installations: [] })),
      ]) as [{ open?: { root: string; engine: string } }, { installations?: readonly { root: string }[] }]
      const named = (root: string, engine = 'main'): PageInstallation => ({ root, engine, name: folderName(root) })
      const all = (rows.installations ?? []).map((row) => named(row.root))
      const open = status.open ? named(status.open.root, status.open.engine) : undefined
      if (open && !all.some((row) => row.root === open.root)) all.unshift(open)
      return { all, ...(open ? { open } : {}) }
    },
  }
}

export function ProjectsPage(props: { readonly shell: ProjectsPageShell }) {
  return <ProjectsView shell={props.shell} source={processSource()} />
}

export function ProjectsView(props: { readonly shell: ProjectsPageShell; readonly source: ProjectsSource }) {
  const message = useAppMessage()
  const locale = useSignal(activeLocale)
  const [projects, { mutate: setProjects }] = createResource(() => props.source.listProjects().then(byProjectTime))
  const [installations] = createResource(() => props.source.installations())
  const [chosen, setChosen] = createSignal<string>()
  const [bannerShown, setBannerShown] = createSignal(true)
  const [runsOnChoice, setRunsOnChoice] = createSignal(0)
  const [hiddenChange, setHiddenChange] = createSignal(0)

  const selectedId = (): string | undefined =>
    chosen() ?? props.shell.selectedProjectId() ?? projects()?.[0]?.id
  const selected = createMemo(() => projects()?.find((project) => project.id === selectedId()))
  const [workflows] = createResource(selectedId, (id) => props.source.listWorkflows(id))
  const [outputs] = createResource(selectedId, (id) => props.source.listOutputs(id, OUTPUT_LIMIT))
  const [usage] = createResource(selectedId, (id) => props.source.usage(id).catch(() => undefined))

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
    const list = projects()
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

  const open = (project: LibraryProject) => {
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

  const detail = (project: LibraryProject) => {
    const time = projectTime(project)
    const here = () => opening()?.projectId === project.id ? opening() : undefined
    const installation = () => runsOn(project.id)
    return (
      <>
        <ProductProjectHeader
          title={project.name}
          subtitle={message(time.kind === 'ran' ? 'projects.time.lastRun' : 'projects.time.created', {
            when: when(time.at),
          })}
          actions={
            <Show
              when={here() && here()!.failed === undefined}
              fallback={
                <ProductButton fill="solid" onClick={() => open(project)}>
                  {here()?.failed !== undefined ? message('projects.action.tryAgain') : message('projects.action.open')}
                </ProductButton>
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
        <ProductProjectFacts
          label={message('projects.facts.label')}
          columns={[
            [
              {
                label: message('projects.facts.runsOn'),
                value: installation()?.name ?? message('projects.facts.noInstallation'),
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
            [
              {
                label: message('projects.facts.size'),
                value: usage() ? formatBytes(usage()!.bytes, locale().tag) : '',
                detail: usage() ? message('projects.facts.outputs', { count: usage()!.outputs }) : undefined,
              },
            ],
          ]}
        />
        <ProductProjectSection
          title={message('projects.workflows.title')}
          aside={<span class="dinkster-metadata">{workflows()?.length ?? ''}</span>}
        >
          <Show
            when={!workflows.loading}
            fallback={
              <ProductTileGrid size="wide">
                <Index each={[0, 1, 2, 3]}>{() => <ProductSkeleton shape="tile" />}</Index>
              </ProductTileGrid>
            }
          >
            <Show
              when={(workflows()?.length ?? 0) > 0}
              fallback={<ProductEmptyState message={message('projects.workflows.empty')} />}
            >
              <ProductTileGrid size="wide">
                <For each={workflows()}>
                  {(workflow) => (
                    <ProductTile
                      label={workflow.name}
                      caption={workflow.name}
                      detail={when(workflow.modified)}
                      empty={<ProductIcon icon={Workflow} />}
                      onClick={() => open(project)}
                    />
                  )}
                </For>
              </ProductTileGrid>
            </Show>
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
            when={(outputs()?.length ?? 0) > 0 || outputs.loading}
            fallback={<ProductEmptyState message={message('projects.outputs.empty')} />}
          >
            <Show when={!outputsHidden(project.id)}>
              <ProductTileGrid size="narrow">
                <For each={outputs()}>
                  {(output) => (
                    <ProductTile
                      label={output.asset.name}
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
      </>
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

  return (
    <ProductProjectsView
      list={
        <ProductProjectList
          title={message('projects.title')}
          newLabel={message('projects.action.new')}
          onNew={() => props.shell.showProjects({ newProject: true })}
          projects={entries()}
          selected={newProject() ? undefined : selectedId()}
          onSelect={(id) => {
            setChosen(id)
            if (newProject()) props.shell.showProjects()
          }}
          loadingLabel={message('projects.loading')}
        />
      }
    >
      <Show when={!newProject()} fallback={newProjectForm()}>
        <Show
          when={selected()}
          keyed
          fallback={
            <Show
              when={projects.loading}
              fallback={<ProductEmptyState message={message('projects.empty')} />}
            >
              <div class="dinkster-stack" role="status" aria-label={message('projects.loading')}>
                <ProductSkeleton shape="title" />
                <ProductSkeleton shape="line" />
              </div>
            </Show>
          }
        >
          {(project) => detail(project)}
        </Show>
      </Show>
    </ProductProjectsView>
  )
}

function writeChoice(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Storage that refuses writes keeps the default installation.
  }
}

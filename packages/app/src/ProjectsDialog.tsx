import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import type { DinksterConnection, LibraryProject } from '@dinkster/client'
import { ProductErrorBanner, ProductToast } from '@dinkster/ui'
import { ProductActionFooter } from './ProductForm.js'
import { ProductButton, ProductTextInput } from './ProductControls.js'
import { ProductEmptyState, ProductListRow } from './ProductSurfaces.js'
import { activeProjectId, migrateBrowserProjects } from './projects.js'
import { useAppMessage } from './locale.js'

/** The engine owns project records; switching reloads the window's device scope. */
export function ProjectsDialog(props: {
  readonly connection: Pick<DinksterConnection, 'listProjects' | 'registerProject' | 'renameProject'>
  readonly onSwitch: (projectId: string) => void
  readonly onOpenWindow?: (projectId: string) => void
  /** Opened to create a project: the name field takes focus once it can be typed in. */
  readonly focusNewProject?: boolean
}) {
  const message = useAppMessage()
  const currentConnection = createMemo(() => props.connection)
  const [projects, setProjects] = createSignal<readonly LibraryProject[]>([])
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [notification, setNotification] = createSignal<{ message: string }>()
  const [draft, setDraft] = createSignal('')
  const [renamingId, setRenamingId] = createSignal<string>()
  const [renameDraft, setRenameDraft] = createSignal('')
  let lifetime: AbortController | undefined
  let newProjectName!: HTMLInputElement

  const readProjects = async (connection: typeof props.connection, signal: AbortSignal): Promise<void> => {
    const items: LibraryProject[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await connection.listProjects(cursor, signal)
      if (signal.aborted || props.connection !== connection) return
      items.push(...page.items.filter((project) => !project.deleted))
      cursor = page.cursor ?? undefined
      if (cursor !== undefined && cursors.has(cursor)) throw new Error('Project list did not advance')
      if (cursor !== undefined) cursors.add(cursor)
    } while (cursor !== undefined)
    setProjects(items)
  }

  createEffect(() => {
    const connection = currentConnection()
    const controller = new AbortController()
    lifetime = controller
    onCleanup(() => controller.abort())
    setProjects([])
    setLoading(true)
    setBusy(false)
    setError(undefined)
    setNotification(undefined)
    setDraft('')
    setRenameDraft('')
    setRenamingId(undefined)
    void (async () => {
      try {
        await migrateBrowserProjects(connection, globalThis.localStorage, controller.signal)
        await readProjects(connection, controller.signal)
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
  })

  createEffect(() => {
    if (props.focusNewProject && !loading()) newProjectName.focus()
  })

  const mutate = async (action: (connection: typeof props.connection, signal: AbortSignal) => Promise<void>): Promise<void> => {
    const controller = lifetime
    if (loading() || busy() || controller === undefined || controller.signal.aborted) return
    const connection = props.connection
    setBusy(true)
    setError(undefined)
    try {
      await action(connection, controller.signal)
      if (controller.signal.aborted || props.connection !== connection) return
      await readProjects(connection, controller.signal)
    } catch (cause) {
      if (controller.signal.aborted || props.connection !== connection) return
      // Reload revisions after a conflict so the next rename can use fresh data.
      try { await readProjects(connection, controller.signal) } catch { /* Keep the original failure. */ }
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const create = (): void => {
    const name = draft().trim()
    if (name.length === 0) return
    void mutate(async (connection, signal) => {
      await connection.registerProject(`p-${crypto.randomUUID()}`, name, signal)
      if (signal.aborted || props.connection !== connection) return
      setDraft('')
      setNotification({ message: 'Project created' })
    })
  }
  const commitRename = (): void => {
    const project = projects().find((entry) => entry.id === renamingId())
    const name = renameDraft().trim()
    if (project === undefined || name.length === 0) return
    if (project.name === name) { setRenamingId(undefined); return }
    void mutate(async (connection, signal) => {
      await connection.renameProject(project.id, name, project.revision, signal)
      if (signal.aborted || props.connection !== connection) return
      setRenamingId(undefined)
      setNotification({ message: 'Project renamed' })
    })
  }

  return (
    <div class="projects-dialog" data-testid="projects-dialog">
      <Show when={error()}>{(message) => <ProductErrorBanner onDismiss={() => setError(undefined)}>{message()}</ProductErrorBanner>}</Show>
      <ProductToast notification={notification()} onDismiss={() => setNotification(undefined)} />
      <p class="projects-dialog-intro">
        {message('projectsDialog.description')}
      </p>
      <Show when={loading()}><ProductEmptyState tone="loading" title={message('projectsDialog.loading')} /></Show>
      <ul class="projects-dialog-list">
        <For each={projects()}>{(project) => (
          <li data-project-id={project.id}>
            <ProductListRow primary={<Show
              when={renamingId() === project.id}
              fallback={<span>{project.name}{' '}<Show when={project.id === activeProjectId()}><span class="projects-dialog-current">Current</span></Show></span>}
            >
              <ProductTextInput
                type="text"
                aria-label={`Rename ${project.name}`}
                value={renameDraft()}
                disabled={busy()}
                onInput={(event) => setRenameDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitRename()
                  if (event.key === 'Escape') { event.stopPropagation(); setRenamingId(undefined) }
                }}
                onBlur={commitRename}
                ref={(el) => queueMicrotask(() => el.focus())}
              />
            </Show>}>
              <ProductActionFooter>
                <ProductButton size="compact" type="button" disabled={busy()} onClick={() => { setRenameDraft(project.name); setRenamingId(project.id) }}>Rename</ProductButton>
                <Show when={props.onOpenWindow}><ProductButton size="compact" type="button" disabled={busy()} onClick={() => props.onOpenWindow!(project.id)}>New window</ProductButton></Show>
                <ProductButton size="compact" type="button" disabled={busy() || project.id === activeProjectId()} onClick={() => props.onSwitch(project.id)}>Switch</ProductButton>
              </ProductActionFooter>
            </ProductListRow>
          </li>
        )}</For>
      </ul>
      <ProductActionFooter>
        <ProductTextInput ref={newProjectName} type="text" placeholder="New project name" aria-label="New project name" value={draft()} disabled={loading() || busy()} onInput={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') create() }} />
        <ProductButton type="button" variant="primary" data-testid="projects-create" loading={busy()} disabled={loading() || error() !== undefined || draft().trim().length === 0} onClick={create}>Create project</ProductButton>
      </ProductActionFooter>
    </div>
  )
}

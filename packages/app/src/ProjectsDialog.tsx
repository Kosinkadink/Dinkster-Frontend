import { createSignal, For, Show } from 'solid-js'
import { ProductActionFooter } from './ProductForm.js'
import { activeProjectId, createProject, listProjects, renameProject } from './projects.js'

/**
 * Create, rename, and switch projects. Switching navigates the window into
 * the target project's scope, so the host performs it (desktop IPC or a URL
 * change); this dialog only owns the registry.
 */
export function ProjectsDialog(props: {
  readonly onSwitch: (projectId: string) => void
  /** Open the project in an additional window; absent when the host cannot (desktop). */
  readonly onOpenWindow?: (projectId: string) => void
}) {
  const [tick, setTick] = createSignal(0)
  const projects = () => {
    tick()
    return listProjects()
  }
  const refresh = (): void => { setTick((n) => n + 1) }
  const [draft, setDraft] = createSignal('')
  const [renamingId, setRenamingId] = createSignal<string>()
  const [renameDraft, setRenameDraft] = createSignal('')

  const create = (): void => {
    if (draft().trim().length === 0) return
    createProject(draft())
    setDraft('')
    refresh()
  }
  const commitRename = (): void => {
    const id = renamingId()
    if (id !== undefined && renameDraft().trim().length > 0) {
      renameProject(id, renameDraft())
    }
    setRenamingId(undefined)
    refresh()
  }

  return (
    <div class="projects-dialog" data-testid="projects-dialog">
      <p class="projects-dialog-intro">
        A project keeps its own tabs, backend connections, and layout. Windows on the same project stay in sync.
      </p>
      <ul class="projects-dialog-list">
        <For each={projects()}>{(project) => (
          <li class="projects-dialog-row" data-project-id={project.id}>
            <Show
              when={renamingId() === project.id}
              fallback={
                <span class="projects-dialog-name">
                  {project.name}
                  <Show when={project.id === activeProjectId()}>
                    <span class="projects-dialog-current">Current</span>
                  </Show>
                </span>
              }
            >
              <input
                type="text"
                aria-label={`Rename ${project.name}`}
                value={renameDraft()}
                onInput={(event) => setRenameDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitRename()
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    setRenamingId(undefined)
                  }
                }}
                onBlur={commitRename}
                ref={(el) => queueMicrotask(() => el.focus())}
              />
            </Show>
            <span class="projects-dialog-actions">
              <button
                type="button"
                onClick={() => {
                  setRenameDraft(project.name)
                  setRenamingId(project.id)
                }}
              >Rename</button>
              <Show when={props.onOpenWindow}>
                <button type="button" onClick={() => props.onOpenWindow!(project.id)}>New window</button>
              </Show>
              <button
                type="button"
                disabled={project.id === activeProjectId()}
                onClick={() => props.onSwitch(project.id)}
              >Switch</button>
            </span>
          </li>
        )}</For>
      </ul>
      <ProductActionFooter>
        <input
          type="text"
          placeholder="New project name"
          aria-label="New project name"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') create()
          }}
        />
        <button type="button" class="primary" data-testid="projects-create" disabled={draft().trim().length === 0} onClick={create}>
          Create project
        </button>
      </ProductActionFooter>
    </div>
  )
}

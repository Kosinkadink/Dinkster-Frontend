import { For, Show, createResource, createSignal, onCleanup } from 'solid-js'
import { render } from 'solid-js/web'
import {
  ProductButton,
  ProductDialog,
  ProductField,
  ProductSelect,
  ProductEmptyState,
  ProductErrorBanner,
  ProductToast,
  ProductList,
  ProductListRow,
  ProductLoading,
  ProductNotice,
  ProductPage,
  ProductSection,
  ProductShell,
} from '@dinkster/ui'
import '@dinkster/ui/styles.css'

interface LibraryEntry {
  readonly id: string
  readonly name: string
  readonly description?: string
}

interface LibraryPage {
  readonly items: readonly LibraryEntry[]
  readonly cursor: string | null
}

interface LibraryHistory {
  readonly installation: LibraryEntry
  readonly environment: { readonly id: string; readonly snapshot: string }
  readonly entries: readonly {
    readonly id: number
    readonly timestamp: string
    readonly reason: string
    readonly generation: number
    readonly exact: boolean
    readonly snapshot: {
      readonly engine: { readonly version: string; readonly release: string }
      readonly base: { readonly id: string; readonly variant: string }
    }
  }[]
  readonly notices: readonly string[]
}

type RestoreScope = 'every-project' | 'only-project'

interface RestoreReview {
  readonly token: string
  readonly scope: RestoreScope
  readonly installation: LibraryEntry
  readonly project: LibraryEntry
  readonly entry: number
  readonly projects: readonly LibraryEntry[]
  readonly alternatives: readonly {
    readonly snapshot: LibraryHistory['entries'][number]['snapshot']
    readonly changes: readonly {
      readonly field: string
      readonly before: readonly string[]
      readonly after: readonly string[]
    }[]
  }[]
  readonly notices: readonly string[]
  readonly expiresInSeconds: number
}

interface DesktopLibraryBridge {
  reviewRestore?(
    installation: string,
    project: string,
    entry: number,
    scope: RestoreScope,
  ): Promise<RestoreReview>
  applyRestore?(token: string, alternative: number): Promise<void>
  history?(installation: string, project: string): Promise<LibraryHistory>
  open?(installation: string, project: string): Promise<void>
  installations(): Promise<readonly LibraryEntry[]>
  projects(installation: string, cursor: string | null): Promise<LibraryPage>
  workflows(
    installation: string,
    project: string,
    cursor: string | null,
  ): Promise<LibraryPage>
  assets(
    installation: string,
    project: string,
    cursor: string | null,
  ): Promise<LibraryPage>
}

declare global {
  interface Window {
    readonly dinksterLibrary?: DesktopLibraryBridge
  }
}

const unavailable =
  'By the way, these projects and files cannot be shown with the installed tools.'

function Library() {
  const bridge = window.dinksterLibrary
  const [installation, setInstallation] = createSignal<LibraryEntry>()
  const [project, setProject] = createSignal<LibraryEntry>()
  const [notice, setNotice] = createSignal(false)
  const [opening, setOpening] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [notification, setNotification] = createSignal<{ message: string }>()
  let active = true
  onCleanup(() => {
    active = false
  })
  const openProject = async (): Promise<void> => {
    const selectedInstallation = installation()
    const selectedProject = project()
    if (opening() || !selectedInstallation || !selectedProject || !bridge?.open)
      return
    setOpening(true)
    setNotification(undefined)
    try {
      await bridge.open(selectedInstallation.id, selectedProject.id)
      if (active) {
        setError(undefined)
        setNotification({ message: 'Project opened.' })
      }
    } catch (cause) {
      if (active)
        setError(
          cause instanceof Error
            ? cause.message
            : 'The project could not be opened. Try again.',
        )
    } finally {
      if (active) setOpening(false)
    }
  }
  const [installations] = createResource(async () => {
    try {
      if (!bridge) throw new Error('Desktop library bridge is unavailable')
      return await bridge.installations()
    } catch {
      setNotice(true)
      return []
    }
  })

  return (
    <ProductShell
      title="Dinkster Desktop"
      navigation={[]}
      currentHref=""
      onNavigate={() => {}}
    >
      <ProductPage
        title={project()?.name ?? installation()?.name ?? 'Projects'}
      >
        <Show when={error()}>
          {(detail) => (
            <ProductErrorBanner onDismiss={() => setError(undefined)}>
              {detail()}
            </ProductErrorBanner>
          )}
        </Show>
        <ProductToast
          notification={notification()}
          onDismiss={() => setNotification(undefined)}
        />
        <Show when={notice()}>
          <ProductNotice>{unavailable}</ProductNotice>
        </Show>
        <Show
          when={installation()}
          fallback={
            <Show
              when={!installations.loading}
              fallback={<ProductLoading label="Loading installations" />}
            >
              <Show when={!notice()}>
                <Show
                  when={installations()?.length}
                  fallback={
                    <ProductEmptyState message="No local installations yet." />
                  }
                >
                  <ProductList label="Local installations">
                    <For each={installations()}>
                      {(entry) => (
                        <ProductListRow
                          title={entry.name}
                          action={
                            <ProductButton
                              onClick={() => {
                                setNotice(false)
                                setInstallation(entry)
                              }}
                            >
                              View projects
                            </ProductButton>
                          }
                        />
                      )}
                    </For>
                  </ProductList>
                </Show>
              </Show>
            </Show>
          }
          keyed
        >
          {(selectedInstallation) => (
            <>
              <div class="dinkster-actions">
                <ProductButton
                  disabled={opening()}
                  onClick={() => {
                    setProject(undefined)
                    setInstallation(undefined)
                    setNotice(false)
                    setError(undefined)
                  }}
                >
                  Installations
                </ProductButton>
                <Show when={project()}>
                  <ProductButton
                    disabled={opening()}
                    onClick={() => {
                      setProject(undefined)
                      setNotice(false)
                      setError(undefined)
                    }}
                  >
                    Projects
                  </ProductButton>
                  <Show when={typeof bridge?.open === 'function'}>
                    <ProductButton
                      intent="neutral"
                      fill="solid"
                      pending={opening()}
                      onClick={() => {
                        void openProject()
                      }}
                    >
                      Open project
                    </ProductButton>
                  </Show>
                </Show>
              </div>
              <Show
                when={project()}
                fallback={
                  <Entries
                    title="Projects"
                    empty="No projects yet."
                    load={(cursor) =>
                      bridge!.projects(selectedInstallation.id, cursor)
                    }
                    onError={() => setNotice(true)}
                    onSelect={(entry) => {
                      setNotice(false)
                      setProject(entry)
                    }}
                  />
                }
                keyed
              >
                {(selectedProject) => (
                  <>
                    <Show when={typeof bridge?.history === 'function'}>
                      <SoftwareHistory
                        load={() =>
                          bridge!.history!(
                            selectedInstallation.id,
                            selectedProject.id,
                          )
                        }
                        review={
                          typeof bridge?.reviewRestore === 'function' &&
                          typeof bridge?.applyRestore === 'function'
                            ? (entry, scope) =>
                                bridge.reviewRestore!(
                                  selectedInstallation.id,
                                  selectedProject.id,
                                  entry,
                                  scope,
                                )
                            : undefined
                        }
                        apply={(token, alternative) =>
                          bridge!.applyRestore!(token, alternative)
                        }
                        onSuccess={() =>
                          setNotification({
                            message: 'Software restored and project opened.',
                          })
                        }
                        onError={() =>
                          setError(
                            'Software history could not be read. Select the project again to retry.',
                          )
                        }
                      />
                    </Show>
                    <Entries
                      title="Saved workflows"
                      empty="No saved workflows in this project."
                      load={(cursor) =>
                        bridge!.workflows(
                          selectedInstallation.id,
                          selectedProject.id,
                          cursor,
                        )
                      }
                      onError={() => setNotice(true)}
                    />
                    <Entries
                      title="Files"
                      empty="No recorded files in this project."
                      load={(cursor) =>
                        bridge!.assets(
                          selectedInstallation.id,
                          selectedProject.id,
                          cursor,
                        )
                      }
                      onError={() => setNotice(true)}
                    />
                  </>
                )}
              </Show>
            </>
          )}
        </Show>
      </ProductPage>
    </ProductShell>
  )
}

function SoftwareHistory(props: {
  load: () => Promise<LibraryHistory>
  review:
    | ((entry: number, scope: RestoreScope) => Promise<RestoreReview>)
    | undefined
  apply: (token: string, alternative: number) => Promise<void>
  onSuccess: () => void
  onError: () => void
}) {
  const [restoring, setRestoring] =
    createSignal<LibraryHistory['entries'][number]>()
  let active = true
  onCleanup(() => {
    active = false
  })
  const [history, { refetch }] = createResource(async () => {
    try {
      const result = await props.load()
      return active ? result : undefined
    } catch {
      if (active) props.onError()
      return undefined
    }
  })
  return (
    <ProductSection
      title="Environment software history"
      description="Recorded software snapshots, not finished workflow runs. Reading history does not start an engine or restore software."
    >
      <Show when={history.loading}>
        <ProductLoading label="Loading software history" />
      </Show>
      <Show when={history()}>
        {(value) => (
          <>
            <ProductNotice>
              {value().installation.name}: active snapshot{' '}
              {value().environment.snapshot}. A recorded snapshot is not a
              promise that it can open the current library.
            </ProductNotice>
            <For each={value().notices}>
              {(notice) => <ProductNotice>{notice}</ProductNotice>}
            </For>
            <Show
              when={value().entries.length}
              fallback={
                <ProductEmptyState message="No recorded software snapshots." />
              }
            >
              <ProductList label="Environment software history">
                <For each={value().entries}>
                  {(entry) => (
                    <ProductListRow
                      title={`Snapshot ${entry.generation} - ${new Date(entry.timestamp).toLocaleString()}`}
                      description={`History entry ${entry.id} - ${entry.reason}. Engine ${entry.snapshot.engine.version} (${entry.snapshot.engine.release}). Base ${entry.snapshot.base.id}, variant ${entry.snapshot.base.variant}. ${entry.exact ? 'Recorded without software substitutions.' : 'Recorded with software substitutions.'}`}
                      action={
                        <Show when={props.review}>
                          <ProductButton onClick={() => setRestoring(entry)}>
                            Review restore
                          </ProductButton>
                        </Show>
                      }
                    />
                  )}
                </For>
              </ProductList>
            </Show>
          </>
        )}
      </Show>
      <Show when={restoring()} keyed>
        {(entry) => (
          <RestoreSoftware
            entry={entry}
            review={(scope) => props.review!(entry.id, scope)}
            apply={props.apply}
            refresh={() => void refetch()}
            onDismiss={() => setRestoring(undefined)}
            onSuccess={() => {
              setRestoring(undefined)
              props.onSuccess()
            }}
          />
        )}
      </Show>
    </ProductSection>
  )
}

function RestoreSoftware(props: {
  entry: LibraryHistory['entries'][number]
  review: (scope: RestoreScope) => Promise<RestoreReview>
  apply: (token: string, alternative: number) => Promise<void>
  refresh: () => void
  onDismiss: () => void
  onSuccess: () => void
}) {
  const [scope, setScope] = createSignal<RestoreScope | ''>('')
  const [review, setReview] = createSignal<RestoreReview>()
  const [alternative, setAlternative] = createSignal(0)
  const [reviewing, setReviewing] = createSignal(false)
  const [applying, setApplying] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let expires: number | undefined
  let active = true
  onCleanup(() => {
    active = false
    window.clearTimeout(expires)
  })
  const requestReview = async () => {
    const selectedScope = scope()
    if (!selectedScope || reviewing() || applying()) return
    window.clearTimeout(expires)
    setReview(undefined)
    setError(undefined)
    setReviewing(true)
    try {
      const result = await props.review(selectedScope)
      if (active) {
        setAlternative(0)
        setReview(result)
        expires = window.setTimeout(() => {
          setReview(undefined)
          setError(
            'The restore review expired. Request a new review before applying.',
          )
        }, result.expiresInSeconds * 1000)
      }
    } catch {
      if (active)
        setError(
          'The restore could not be reviewed. Request a new review to try again.',
        )
    } finally {
      if (active) setReviewing(false)
    }
  }
  const apply = async () => {
    const approved = review()
    const selected = alternative()
    if (applying() || !approved?.alternatives[selected]) return
    window.clearTimeout(expires)
    setApplying(true)
    setError(undefined)
    try {
      await props.apply(approved.token, selected)
      if (active) {
        props.refresh()
        props.onSuccess()
      }
    } catch {
      if (active) {
        setReview(undefined)
        setError(
          'Restore could not be completed. Software or the project selection may already have changed. Request a new review before trying again.',
        )
      }
    } finally {
      if (active) {
        setApplying(false)
        props.refresh()
      }
    }
  }
  return (
    <ProductDialog
      title={`Restore snapshot ${props.entry.generation}`}
      pending={applying()}
      onDismiss={props.onDismiss}
    >
      <ProductNotice>
        Restoring changes environment software, not saved workflow runs. Review
        the affected projects and software before applying. Only this project
        creates a separate environment; other projects keep their software.
      </ProductNotice>
      <ProductField label="Who should use this software?">
        {(attributes) => (
          <ProductSelect
            {...attributes}
            value={scope()}
            disabled={reviewing() || applying()}
            onChange={(event) => {
              setScope(event.currentTarget.value as RestoreScope | '')
              window.clearTimeout(expires)
              setReview(undefined)
              setError(undefined)
            }}
          >
            <option value="">Choose a scope</option>
            <option value="every-project">Every project on it</option>
            <option value="only-project">Only this project</option>
          </ProductSelect>
        )}
      </ProductField>
      <ProductButton
        disabled={!scope() || applying()}
        pending={reviewing()}
        onClick={() => void requestReview()}
      >
        Review changes
      </ProductButton>
      <Show when={error()}>
        {(message) => (
          <ProductErrorBanner onDismiss={() => setError(undefined)}>
            {message()}
          </ProductErrorBanner>
        )}
      </Show>
      <Show when={review()}>
        {(value) => (
          <>
            <ProductNotice>
              {value().installation.name}: {value().project.name}. History entry{' '}
              {value().entry}. A review is valid for up to{' '}
              {value().expiresInSeconds} seconds. Changed software or projects
              require a new review.
            </ProductNotice>
            <For each={value().notices}>
              {(notice) => <ProductNotice>{notice}</ProductNotice>}
            </For>
            <ProductSection title="Affected projects">
              <ProductList label="Affected projects">
                <For each={value().projects}>
                  {(project) => <ProductListRow title={project.name} />}
                </For>
              </ProductList>
            </ProductSection>
            <Show
              when={value().alternatives.length}
              fallback={
                <ProductEmptyState message="No compatible software alternatives are available. Nothing can be applied." />
              }
            >
              <ProductField label="Software alternative">
                {(attributes) => (
                  <ProductSelect
                    {...attributes}
                    value={alternative()}
                    disabled={applying()}
                    onChange={(event) =>
                      setAlternative(Number(event.currentTarget.value))
                    }
                  >
                    <For each={value().alternatives}>
                      {(choice, index) => (
                        <option value={index()}>
                          Alternative {index() + 1}: engine{' '}
                          {choice.snapshot.engine.version}
                        </option>
                      )}
                    </For>
                  </ProductSelect>
                )}
              </ProductField>
              <Show when={value().alternatives[alternative()]}>
                {(choice) => (
                  <ProductSection title="Selected software">
                    <ProductList label="Selected software">
                      <ProductListRow
                        title={`Engine ${choice().snapshot.engine.version}`}
                        description={`Release ${choice().snapshot.engine.release}. Base ${choice().snapshot.base.id}, variant ${choice().snapshot.base.variant}.`}
                      />
                    </ProductList>
                    <ProductList label="Software substitutions">
                      <For each={choice().changes}>
                        {(change) => (
                          <ProductListRow
                            title={change.field}
                            description={`Recorded: ${change.before.join('; ') || 'None'}. Restore with: ${change.after.join('; ') || 'None'}.`}
                          />
                        )}
                      </For>
                      <Show when={!choice().changes.length}>
                        <ProductListRow title="No software substitutions" />
                      </Show>
                    </ProductList>
                  </ProductSection>
                )}
              </Show>
              <ProductButton
                intent="neutral"
                fill="solid"
                pending={applying()}
                onClick={() => void apply()}
              >
                Apply restore
              </ProductButton>
            </Show>
          </>
        )}
      </Show>
    </ProductDialog>
  )
}

function Entries(props: {
  title: string
  empty: string
  load: (cursor: string | null) => Promise<LibraryPage>
  onError: () => void
  onSelect?: (entry: LibraryEntry) => void
}) {
  const [entries, setEntries] = createSignal<readonly LibraryEntry[]>([])
  const [cursor, setCursor] = createSignal<string | null>(null)
  const [failed, setFailed] = createSignal(false)
  let active = true
  onCleanup(() => {
    active = false
  })
  const [page, { refetch }] = createResource(async () => {
    try {
      const result = await props.load(cursor())
      if (!active) return undefined
      setEntries((previous) => [...previous, ...result.items])
      setCursor(result.cursor)
      setFailed(false)
      return result
    } catch {
      if (!active) return undefined
      setFailed(true)
      props.onError()
      return undefined
    }
  })
  return (
    <ProductSection title={props.title}>
      <Show when={entries().length}>
        <ProductList label={props.title}>
          <For each={entries()}>
            {(entry) => (
              <ProductListRow
                title={entry.name}
                description={entry.description ?? ''}
                action={
                  props.onSelect ? (
                    <ProductButton onClick={() => props.onSelect?.(entry)}>
                      View assets
                    </ProductButton>
                  ) : undefined
                }
              />
            )}
          </For>
        </ProductList>
      </Show>
      <Show when={!page.loading && !failed() && entries().length === 0}>
        <ProductEmptyState message={props.empty} />
      </Show>
      <Show when={page.loading}>
        <ProductLoading label={`Loading ${props.title.toLowerCase()}`} />
      </Show>
      <Show when={cursor() && !failed()}>
        <div class="dinkster-actions">
          <ProductButton
            pending={page.loading}
            onClick={() => {
              void refetch()
            }}
          >
            Show more {props.title.toLowerCase()}
          </ProductButton>
        </div>
      </Show>
    </ProductSection>
  )
}

render(() => <Library />, document.getElementById('desktop-library-root')!)

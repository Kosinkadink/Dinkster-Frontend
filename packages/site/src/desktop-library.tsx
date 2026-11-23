import { For, Show, createResource, createSignal, onCleanup } from 'solid-js'
import { render } from 'solid-js/web'
import {
  ProductButton,
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

interface DesktopLibraryBridge {
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
  onError: () => void
}) {
  let active = true
  onCleanup(() => {
    active = false
  })
  const [history] = createResource(async () => {
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
                    />
                  )}
                </For>
              </ProductList>
            </Show>
          </>
        )}
      </Show>
    </ProductSection>
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

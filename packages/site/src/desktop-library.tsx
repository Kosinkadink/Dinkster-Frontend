import { For, Show, createResource, createSignal, onCleanup } from 'solid-js'
import { render } from 'solid-js/web'
import {
  ProductButton,
  ProductEmptyState,
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

interface DesktopLibraryBridge {
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
                  onClick={() => {
                    setProject(undefined)
                    setInstallation(undefined)
                    setNotice(false)
                  }}
                >
                  Installations
                </ProductButton>
                <Show when={project()}>
                  <ProductButton
                    onClick={() => {
                      setProject(undefined)
                      setNotice(false)
                    }}
                  >
                    Projects
                  </ProductButton>
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

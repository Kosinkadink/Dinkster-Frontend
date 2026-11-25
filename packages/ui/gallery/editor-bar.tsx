import { For, Show, createEffect, createSignal } from 'solid-js'
import {
  BookOpen,
  Blocks,
  Images,
  Library,
  LogOut,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Users,
} from 'lucide-solid'
import components from '@dinkster/branding/components' with { type: 'json' }
import {
  ProductAccountMenu,
  ProductBrandMark,
  ProductCheckbox,
  ProductField,
  ProductIconButton,
  ProductLink,
  ProductMenu,
  ProductPage,
  ProductProjectMenu,
  ProductRunActivity,
  ProductSelect,
  ProductSignInControl,
  ProductTextInput,
  ProductWindowAction,
  ProductWindowToolbar,
  type ProductMenuItem,
  type ProductProject,
} from '../src/index.js'

const projectNames = [
  'Teapot product shots',
  'Valley matte paintings',
  'Bookshop diorama',
  'Audio experiments',
  'Storyboard frames',
  'Character turnarounds',
  'Lighting studies',
  'Texture library',
  'Logo animation',
  'Archive restoration',
  'Comic panels',
  'Weekend sketches',
]

const platforms = {
  darwin: { label: 'macOS', minimum: components.layout.toolbarMinimumWidthMac },
  // The gallery cannot draw Windows' caption buttons, so the narrowest Windows
  // bar keeps the same content width as Linux instead of the 520 px window.
  win32: {
    label: 'Windows',
    minimum: components.layout.toolbarMinimumWidthLinux,
  },
  linux: {
    label: 'Linux',
    minimum: components.layout.toolbarMinimumWidthLinux,
  },
  browser: {
    label: 'Browser',
    minimum: components.layout.toolbarMinimumWidthLinux,
  },
} as const

/**
 * The editor's top bar and left icon bar as the app draws them: the project
 * beside the Dinkster menu, and the account above Settings in the left bar.
 */
export function EditorBarGallery() {
  const [platform, setPlatform] =
    createSignal<keyof typeof platforms>('browser')
  const [width, setWidth] = createSignal('full')
  const [list, setList] = createSignal('few')
  const [projectName, setProjectName] = createSignal('Film grain tests')
  const [account, setAccount] = createSignal('signed-in')
  const [leftBar, setLeftBar] = createSignal(true)
  const [running, setRunning] = createSignal(false)
  const [service, setService] = createSignal('production')
  const [activity, setActivity] = createSignal('No action yet')
  const projects = (): readonly ProductProject[] | undefined =>
    list() === 'loading' || list() === 'failed'
      ? undefined
      : projectNames
          .slice(0, list() === 'many' ? projectNames.length : 3)
          .map((name, index) => ({ id: `p-${index}`, name }))
  const accountItems = (): (ProductMenuItem | 'separator')[] =>
    leftBar()
      ? []
      : account() === 'signed-in'
        ? [
            { label: 'Alex Rivers', disabled: true, onSelect: () => {} },
            {
              label: 'Sign out',
              icon: LogOut,
              intent: 'remove',
              onSelect: () => setAccount('signed-out'),
            },
            'separator',
          ]
        : [
            {
              label: 'Sign in',
              onSelect: () => {
                setAccount('signed-in')
                setActivity('Signed in')
              },
            },
            'separator',
          ]
  let frame!: HTMLDivElement
  createEffect(() => {
    frame.style.width =
      width() === 'narrowest' ? `${platforms[platform()].minimum}px` : ''
  })
  return (
    <main class="dinkster-stack">
      <div
        ref={frame}
        class="dinkster-editor-preview dinkster-root"
        data-theme="dark"
        role="region"
        aria-label="Editor"
      >
        <ProductWindowToolbar
          title="Application controls"
          service={
            service() === 'qa'
              ? 'QA services'
              : service() === 'custom'
                ? 'Custom services'
                : undefined
          }
          serviceKind={
            service() === 'qa' || service() === 'custom'
              ? (service() as 'qa' | 'custom')
              : undefined
          }
          qa={service() === 'qa'}
          development={service() !== 'production'}
          platform={(() => {
            const value = platform()
            return value === 'browser' ? 'linux' : value
          })()}
          brand={
            <>
              <ProductMenu
                label="Dinkster"
                triggerName="Dinkster menu"
                icon={() => <ProductBrandMark />}
                iconOnly
                items={[
                  ...accountItems(),
                  {
                    label: 'New workflow',
                    onSelect: () => setActivity('New workflow'),
                  },
                  {
                    label: 'Open workflow',
                    onSelect: () => setActivity('Open workflow'),
                  },
                  {
                    label: 'Settings',
                    onSelect: () => setActivity('Settings opened'),
                  },
                ]}
              />
              <ProductProjectMenu
                name={projectName()}
                projects={projects()}
                failed={list() === 'failed'}
                onSwitch={(id) => setActivity(`Switched to ${id}`)}
                onOpenWindow={(id) => setActivity(`Opened ${id} in a window`)}
                onAllProjects={() => setActivity('All projects opened')}
                onNewProject={() => setActivity('New project opened')}
              />
            </>
          }
          search={
            <ProductWindowAction
              label="Search"
              icon={Search}
              shortcut="Ctrl+K"
              onClick={() => setActivity('Search opened')}
            />
          }
          actions={(narrow) => (
            <>
              <Show when={running()}>
                <ProductRunActivity
                  running={1}
                  waiting={2}
                  label="1 running, 2 queued"
                />
                <ProductWindowAction
                  label="Cancel run"
                  icon={Square}
                  intent="remove"
                  onClick={() => setActivity('Run cancelled')}
                />
              </Show>
              <ProductIconButton
                label="Collaboration"
                icon={Users}
                onClick={() => setActivity('Collaboration opened')}
              />
              <ProductMenu
                label="Customize layout"
                icon={SlidersHorizontal}
                items={[
                  {
                    label: 'Left bar',
                    checked: leftBar(),
                    onSelect: () => setLeftBar(!leftBar()),
                  },
                ]}
              />
              <Show when={!narrow()}>
                <For each={[PanelLeft, PanelBottom, PanelRight]}>
                  {(icon, index) => (
                    <ProductIconButton
                      label={
                        ['Left panel', 'Bottom panel', 'Right panel'][index()]!
                      }
                      icon={icon}
                      onClick={() => setActivity('Panel toggled')}
                    />
                  )}
                </For>
              </Show>
            </>
          )}
        />
        <div class="dinkster-editor-preview-body">
          <Show when={leftBar()}>
            <nav
              class="dinkster-editor-preview-rail"
              aria-label="Primary navigation"
            >
              <For
                each={
                  [
                    ['Library', Library],
                    ['Outputs', Images],
                    ['Nodes', Blocks],
                    ['Templates', BookOpen],
                  ] as const
                }
              >
                {([label, icon]) => (
                  <ProductIconButton
                    label={label}
                    icon={icon}
                    onClick={() => setActivity(`${label} opened`)}
                  />
                )}
              </For>
              <span class="dinkster-editor-preview-rail-end">
                <Show
                  when={account() === 'signed-in'}
                  fallback={
                    <ProductSignInControl
                      rail
                      pending={account() === 'signing-in'}
                      onSignIn={() => {
                        setAccount('signing-in')
                        setActivity('Sign in opened')
                      }}
                      onCancel={() => setAccount('signed-out')}
                      onOpenSignInPage={() =>
                        setActivity('Sign-in page opened')
                      }
                    />
                  }
                >
                  <ProductAccountMenu
                    rail
                    name="Alex Rivers"
                    email="alex@example.test"
                    onSignOut={() => {
                      setAccount('signed-out')
                      setActivity('Signed out')
                    }}
                  />
                </Show>
                <ProductIconButton
                  label="Settings"
                  icon={Settings}
                  onClick={() => setActivity('Settings opened')}
                />
              </span>
            </nav>
          </Show>
          <div class="dinkster-editor-preview-canvas" />
        </div>
      </div>
      <ProductPage
        title="Editor bar"
        description="The editor's top bar with the project beside the Dinkster menu, and the account in the left bar above Settings."
      >
        <ProductLink href="#window-toolbar">Window toolbar</ProductLink>
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
                {([value, { label }]) => <option value={value}>{label}</option>}
              </For>
            </ProductSelect>
          )}
        </ProductField>
        <ProductField label="Window width">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={width()}
              onChange={(event) => setWidth(event.currentTarget.value)}
            >
              <option value="full">Full width</option>
              <option value="narrowest">Narrowest window</option>
            </ProductSelect>
          )}
        </ProductField>
        <ProductField label="Other projects">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={list()}
              onChange={(event) => setList(event.currentTarget.value)}
            >
              <option value="few">A few projects</option>
              <option value="many">More than 8 projects</option>
              <option value="loading">Loading</option>
              <option value="failed">Could not be loaded</option>
            </ProductSelect>
          )}
        </ProductField>
        <ProductField label="Project name">
          {(attributes) => (
            <ProductTextInput
              {...attributes}
              value={projectName()}
              onInput={(event) => setProjectName(event.currentTarget.value)}
            />
          )}
        </ProductField>
        <ProductField label="Account">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={account()}
              onChange={(event) => setAccount(event.currentTarget.value)}
            >
              <option value="signed-out">Signed out</option>
              <option value="signing-in">Signing in</option>
              <option value="signed-in">Signed in</option>
            </ProductSelect>
          )}
        </ProductField>
        <ProductField label="Services">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={service()}
              onChange={(event) => setService(event.currentTarget.value)}
            >
              <option value="production">Production</option>
              <option value="qa">QA, development build</option>
              <option value="custom">Custom, development build</option>
            </ProductSelect>
          )}
        </ProductField>
        <ProductCheckbox
          label="Left bar"
          checked={leftBar()}
          onChange={(event) => setLeftBar(event.currentTarget.checked)}
        />
        <ProductCheckbox
          label="Run in progress"
          checked={running()}
          onChange={(event) => setRunning(event.currentTarget.checked)}
        />
        <p role="status">{activity()}</p>
      </ProductPage>
    </main>
  )
}

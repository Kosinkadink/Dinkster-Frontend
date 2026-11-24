import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { render } from 'solid-js/web'
import components from '@dinkster/branding/components' with { type: 'json' }
import {
  Bell,
  ChevronDown,
  CircleAlert,
  Ellipsis,
  LayoutList,
  FolderOpen,
  PanelLeft,
  PanelBottom,
  PanelRight,
  MousePointer,
  Search,
  Square,
  Plus,
  Settings,
  Trash2,
  User,
  Users,
} from 'lucide-solid'
import {
  ProductAbout,
  ProductWindowChrome,
  ProductWindowToolbar,
  ProductWindowAction,
  ProductAccountMenu,
  ProductSignInControl,
  ProductBrandMark,
  ProductCodeBlock,
  ProductCopyValue,
  ProductDisclosure,
  ProductFacts,
  ProductQrCode,
  ProductResourceUsage,
  ProductButton,
  ProductCheckbox,
  ProductConfirmation,
  ProductDialog,
  ProductEmptyState,
  ProductErrorBanner,
  ProductField,
  ProductForm,
  ProductIcon,
  ProductRunIcon,
  ProductRunActivity,
  ProductIconButton,
  ProductLink,
  ProductList,
  ProductListRow,
  ProductLoading,
  ProductMenu,
  ProductNotice,
  ProductPage,
  ProductRadio,
  ProductSection,
  ProductSelect,
  ProductShell,
  ProductSpinner,
  ProductStringsProvider,
  ProductTable,
  ProductTextArea,
  ProductTextInput,
  ProductToast,
  reportProductEvent,
  type ProductRole,
  type ProductAttention,
} from '../src/index.js'
import '../dist/dinkster.css'
import {
  CanvasGallery,
  canvasNavigationGroups,
  canvasPage,
  canvasPageHref,
  selectCanvasPage,
} from './canvas.js'
import { SiteGallery } from './site.js'

const navigation = [
  { label: 'Buttons and fields', href: '#controls', icon: MousePointer },
  { label: 'Forms', href: '#forms', icon: User },
  { label: 'Lists and tables', href: '#lists', icon: LayoutList },
  { label: 'Menus and messages', href: '#messages', icon: Bell },
  { label: 'Confirmations', href: '#confirmations', icon: CircleAlert },
  { label: 'Account data', href: '#account-data', icon: User },
  {
    label: 'Canvas',
    href: '#canvas',
    icon: LayoutList,
    groups: canvasNavigationGroups,
  },
  { label: 'Desktop information', href: '#desktop-about', icon: User },
]

function Section(props: {
  title: string
  components: string
  children: JSX.Element
}) {
  return (
    <ProductSection title={props.title}>
      <span class="dinkster-metadata dinkster-mono">{props.components}</span>
      {props.children}
    </ProductSection>
  )
}

function Gallery() {
  const [route, setRoute] = createSignal(window.location.hash || '#controls')
  const [toast, setToast] = createSignal<{ readonly message: string }>()
  const [error, setError] = createSignal(true)
  const [dialog, setDialog] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [fail, setFail] = createSignal(false)
  const [invalid, setInvalid] = createSignal(false)
  const [refuseName, setRefuseName] = createSignal(false)
  const [nameTaken, setNameTaken] = createSignal(false)
  const [activity, setActivity] = createSignal('No action yet')
  const [loading, setLoading] = createSignal(false)
  let navigationTimer: number | undefined
  onCleanup(() => window.clearTimeout(navigationTimer))
  const navigate = (href: string) => {
    if (href.startsWith('?page=')) {
      selectCanvasPage(href)
      if (route() === '#canvas') return
      href = '#canvas'
    }
    window.clearTimeout(navigationTimer)
    window.location.hash = href
    setRoute(href)
    setLoading(true)
    navigationTimer = window.setTimeout(() => setLoading(false), 600)
  }
  const complete = (message: string) => {
    setActivity(message)
    setToast({ message })
  }
  onMount(() => {
    reportProductEvent({ type: 'page-viewed', route: 'gallery' })
    const update = () => setRoute(window.location.hash || '#controls')
    window.addEventListener('hashchange', update)
    onCleanup(() => window.removeEventListener('hashchange', update))
  })
  return (
    <ProductShell
      title="Component gallery"
      navigation={route() === '#signed-out' ? [] : navigation}
      currentHref={
        route() === '#canvas' ? canvasPageHref(canvasPage()) : route()
      }
      onNavigate={navigate}
      contentDensity={route() === '#canvas' ? undefined : 'site'}
      account={
        <Show when={route() !== '#signed-out'}>
          <ProductAccountMenu
            name="Alex Morgan"
            email="alex@example.test"
            onSignOut={() => complete('Signed out')}
          />
        </Show>
      }
    >
      <ProductPage
        title={
          route() === '#signed-out'
            ? 'Signed-out shell'
            : (navigation.find((item) => item.href === route())?.label ??
              (route() === '#resource-usage' ? 'Resource usage' : 'Buttons and fields'))
        }
        description={
          route() === '#canvas'
            ? 'Fixed examples drawn by the canvas renderer the editor uses, without a backend.'
            : 'The live shared components. Use a pointer or keyboard to inspect hover, focus and pressed states.'
        }
        table={route() === '#lists' || route() === '#canvas'}
      >
        <Show
          when={!loading()}
          fallback={<ProductLoading label="Loading selected page" />}
        >
          <Switch
            fallback={<ProductEmptyState message="Choose a gallery page." />}
          >
            <Match when={route() === '#resource-usage'}>
              <Section title="Card memory" components="ProductResourceUsage">
                <For each={[false, true]}>
                  {(compact) => (
                    <ProductResourceUsage
                      label={compact ? 'Compact card memory' : 'Card memory'}
                      total={24}
                      segments={[
                        { label: 'Models', value: 9, tone: 'models' },
                        { label: 'Held, unused', value: 1, tone: 'held' },
                        { label: 'Other memory', value: 2, tone: 'other' },
                      ]}
                      samples={[
                        { timestamp: 10_000, used: 2 },
                        { timestamp: 35_000, used: 8 },
                        { timestamp: 70_000, used: 14 },
                        { timestamp: 120_000, used: 12 },
                      ]}
                      now={120_000}
                      limit={22}
                      format={(value) => `${value.toFixed(1)} GB`}
                      historyLabel="Last 2 minutes"
                      limitLabel="Limit"
                      compact={compact}
                    />
                  )}
                </For>
              </Section>
              <Section
                title="Partial telemetry"
                components="ProductResourceUsage"
              >
                <ProductResourceUsage
                  label="Card reporting usage only"
                  total={16}
                  segments={[{ label: 'Used', value: 5, tone: 'other' }]}
                  samples={[]}
                  now={120_000}
                  format={(value) => `${value.toFixed(1)} GB`}
                  historyLabel="Last 2 minutes"
                  limitLabel="Limit"
                />
              </Section>
            </Match>
            <Match when={route() === '#desktop-about'}>
              <Section
                title="Native window chrome"
                components="ProductWindowChrome"
              >
                <ProductLink href="#window-toolbar">
                  Inspect responsive window toolbar
                </ProductLink>
                <For each={['win32', 'linux', 'darwin'] as const}>
                  {(platform) => {
                    const [error, setError] = createSignal(true)
                    const [notification, setNotification] = createSignal<
                      { message: string } | undefined
                    >({ message: 'Project changes saved.' })
                    return (
                      <div class="dinkster-stack">
                        <span class="dinkster-metadata">
                          {platform === 'darwin'
                            ? 'macOS'
                            : platform === 'win32'
                              ? 'Windows'
                              : 'Linux'}
                        </span>
                        <div class="dinkster-desktop-preview">
                          <ProductWindowChrome
                            title="Dinkster Desktop"
                            platform={platform}
                            qa
                            development
                          />
                          <div class="dinkster-page">
                            <Show when={error()}>
                              <ProductErrorBanner
                                onDismiss={() => setError(false)}
                              >
                                Project changes could not be saved.
                              </ProductErrorBanner>
                            </Show>
                          </div>
                          <ProductToast
                            notification={notification()}
                            onDismiss={() => setNotification(undefined)}
                          />
                        </div>
                      </div>
                    )
                  }}
                </For>
              </Section>
              <Section title="Dark appearance" components="ProductAbout">
                <div class="dinkster-about-preview" data-theme="dark">
                  <ProductAbout
                    title="Dinkster Desktop"
                    version="0.2.8"
                    theme="dark"
                  />
                </div>
              </Section>
              <Section
                title="Light appearance and QA identity"
                components="ProductAbout"
              >
                <div class="dinkster-about-preview" data-theme="light">
                  <ProductAbout
                    title="Dinkster Desktop [QA]"
                    version="0.2.8"
                    theme="light"
                  />
                </div>
              </Section>
            </Match>
            <Match when={route() === '#canvas'}>
              <CanvasGallery />
            </Match>
            <Match when={route() === '#controls'}>
              <Section
                title="Button roles and fills"
                components="ProductButton"
              >
                <p class="dinkster-description">
                  Variant samples only. A real screen has at most one solid main
                  action; removals open a confirmation first.
                </p>
                <For each={['add', 'remove', 'neutral'] as ProductRole[]}>
                  {(intent) => {
                    const label = intent[0]!.toUpperCase() + intent.slice(1)
                    return (
                      <div class="dinkster-actions">
                        <ProductButton
                          intent={intent}
                          onClick={() => complete(`${label} outline chosen`)}
                        >
                          {label} outline
                        </ProductButton>
                        <ProductButton
                          intent={intent}
                          fill="solid"
                          onClick={() => complete(`${label} solid chosen`)}
                        >
                          {label} solid
                        </ProductButton>
                        <ProductButton intent={intent} disabled>
                          {label} disabled
                        </ProductButton>
                        <ProductButton intent={intent} pending>
                          {label} pending
                        </ProductButton>
                        <ProductButton intent={intent} fill="solid" disabled>
                          {label} solid disabled
                        </ProductButton>
                        <ProductButton intent={intent} fill="solid" pending>
                          {label} solid pending
                        </ProductButton>
                      </div>
                    )
                  }}
                </For>
              </Section>
              <Section
                title="Icon buttons, spinner, icon and link"
                components="ProductIconButton, ProductSpinner, ProductIcon, ProductLink"
              >
                <div class="dinkster-actions">
                  <ProductIconButton
                    label="Add item"
                    icon={Plus}
                    intent="add"
                    onClick={() => complete('Add item chosen')}
                  />
                  <ProductIconButton
                    label="Remove item"
                    icon={Trash2}
                    intent="remove"
                    onClick={() => setDialog(true)}
                  />
                  <ProductIconButton
                    label="Unavailable settings"
                    icon={Settings}
                    disabled
                    onClick={() => {}}
                  />
                  <ProductSpinner label="Pending work" />
                  <ProductIcon icon={Settings} />
                </div>
                <p class="dinkster-description">
                  A sentence can carry a{' '}
                  <ProductLink href="#lists">link to another page</ProductLink>.
                </p>
              </Section>
              <Section title="Run activity" components="ProductRunActivity">
                <div class="dinkster-actions">
                  <ProductRunActivity
                    running={1}
                    waiting={0}
                    label="1 running"
                  />
                  <ProductRunActivity
                    running={3}
                    waiting={0}
                    label="3 running"
                  />
                  <ProductRunActivity
                    running={0}
                    waiting={2}
                    label="2 queued"
                  />
                  <ProductRunActivity
                    running={1}
                    waiting={2}
                    label="1 running, 2 queued"
                  />
                  <ProductRunActivity
                    running={3}
                    waiting={1}
                    label="3 running, 1 queued"
                  />
                </div>
              </Section>
              <Section title="Run icons" components="ProductRunIcon">
                <div class="dinkster-actions">
                  <span>
                    Idle <ProductRunIcon icon={Settings} />
                  </span>
                  <span>
                    Queued <ProductRunIcon icon={Settings} queued />
                  </span>
                  <span>
                    Running <ProductRunIcon icon={Settings} running />
                  </span>
                  <span>
                    Finished{' '}
                    <ProductRunIcon icon={Settings} result="finished" />
                  </span>
                  <span>
                    Failed <ProductRunIcon icon={Settings} result="failed" />
                  </span>
                </div>
              </Section>
              <Section
                title="Text fields"
                components="ProductField with ProductTextInput, ProductTextArea or ProductSelect"
              >
                <ProductField
                  label="Display name"
                  description="Shown on your account."
                >
                  {(attributes) => (
                    <ProductTextInput
                      {...attributes}
                      placeholder="Enter a name"
                    />
                  )}
                </ProductField>
                <ProductField
                  label="Email address"
                  description="A filled field."
                >
                  {(attributes) => (
                    <ProductTextInput
                      {...attributes}
                      type="email"
                      value="alex@example.test"
                    />
                  )}
                </ProductField>
                <ProductField label="Unavailable field">
                  {(attributes) => (
                    <ProductTextInput
                      {...attributes}
                      disabled
                      value="Read-only account"
                    />
                  )}
                </ProductField>
                <ProductField
                  label="Read-only field"
                  description="Selectable, not editable."
                >
                  {(attributes) => (
                    <ProductTextInput
                      {...attributes}
                      readOnly
                      value="dk_live_example"
                    />
                  )}
                </ProductField>
                <ProductField
                  label="Project ID"
                  error="Enter a project ID you own."
                >
                  {(attributes) => (
                    <ProductTextInput {...attributes} value="unknown-project" />
                  )}
                </ProductField>
                <ProductField
                  label="Notes"
                  description="Multiline text uses the same field anatomy."
                >
                  {(attributes) => <ProductTextArea {...attributes} rows={3} />}
                </ProductField>
                <ProductField label="Unavailable notes">
                  {(attributes) => (
                    <ProductTextArea
                      {...attributes}
                      disabled
                      value="Read-only notes"
                    />
                  )}
                </ProductField>
                <ProductField
                  label="Invalid notes"
                  error="Enter a description."
                >
                  {(attributes) => <ProductTextArea {...attributes} value="" />}
                </ProductField>
                <ProductField
                  label="Invalid access"
                  error="Choose an access level."
                >
                  {(attributes) => (
                    <ProductSelect {...attributes}>
                      <option value="">Choose access</option>
                      <option>Read only</option>
                    </ProductSelect>
                  )}
                </ProductField>
                <ProductField label="Access">
                  {(attributes) => (
                    <ProductSelect {...attributes}>
                      <option>Read only</option>
                      <option>Mint only</option>
                    </ProductSelect>
                  )}
                </ProductField>
                <ProductField label="Unavailable choice">
                  {(attributes) => (
                    <ProductSelect {...attributes} disabled>
                      <option>Read only</option>
                    </ProductSelect>
                  )}
                </ProductField>
              </Section>
              <Section
                title="Choices"
                components="ProductCheckbox, ProductRadio"
              >
                <ProductCheckbox label="Unchecked option" />
                <ProductCheckbox label="Checked option" checked />
                <ProductCheckbox label="Disabled option" disabled />
                <ProductCheckbox
                  label="Disabled checked option"
                  checked
                  disabled
                />
                <ProductRadio label="First choice" name="choices" checked />
                <ProductRadio label="Second choice" name="choices" />
                <ProductRadio
                  label="Unavailable radio"
                  name="disabled-choice"
                  disabled
                />
                <ProductRadio
                  label="Selected unavailable radio"
                  name="selected-disabled"
                  disabled
                  checked
                />
              </Section>
            </Match>
            <Match when={route() === '#forms'}>
              <span class="dinkster-metadata dinkster-mono">ProductForm</span>
              <ProductNotice>
                Save is available only after a change. Undo or a successful save
                returns to the unchanged state.
              </ProductNotice>
              <ProductCheckbox
                label="Reject the next save"
                checked={fail()}
                onChange={(event) => setFail(event.currentTarget.checked)}
              />
              <ProductCheckbox
                label="Refuse the next name as taken"
                checked={refuseName()}
                onChange={(event) => setRefuseName(event.currentTarget.checked)}
              />
              <ProductCheckbox
                label="Show field error"
                checked={invalid()}
                onChange={(event) => setInvalid(event.currentTarget.checked)}
              />
              <ProductForm
                initialValues={{
                  name: 'Alex Morgan',
                  description: 'Personal account',
                  showEmail: false,
                }}
                onSave={async () => {
                  await new Promise((resolve) =>
                    window.setTimeout(resolve, 600),
                  )
                  if (fail()) throw new Error('Gallery refusal')
                  if (refuseName()) {
                    setNameTaken(true)
                    return false
                  }
                  setNameTaken(false)
                  complete('Changes saved')
                  reportProductEvent({
                    type: 'action-completed',
                    route: 'gallery',
                    action: 'save',
                  })
                }}
              >
                {(form) => (
                  <>
                    <ProductField
                      label="Display name"
                      description="Your public name."
                      error={
                        nameTaken()
                          ? 'That name is taken.'
                          : invalid()
                            ? 'Enter a display name.'
                            : ''
                      }
                    >
                      {(attributes) => (
                        <ProductTextInput
                          {...attributes}
                          value={form.values().name}
                          onInput={(event) => {
                            setNameTaken(false)
                            form.setValue('name', event.currentTarget.value)
                          }}
                          disabled={form.pending()}
                          required
                        />
                      )}
                    </ProductField>
                    <ProductField label="Description">
                      {(attributes) => (
                        <ProductTextArea
                          {...attributes}
                          value={form.values().description}
                          onInput={(event) =>
                            form.setValue(
                              'description',
                              event.currentTarget.value,
                            )
                          }
                          disabled={form.pending()}
                        />
                      )}
                    </ProductField>
                    <ProductCheckbox
                      label="Show my email on my profile"
                      checked={form.values().showEmail}
                      onChange={(event) =>
                        form.setValue('showEmail', event.currentTarget.checked)
                      }
                      disabled={form.pending()}
                    />
                    <p class="dinkster-metadata" role="status">
                      {form.pending()
                        ? 'Saving changes'
                        : form.dirty()
                          ? 'Unsaved changes'
                          : 'No unsaved changes'}
                    </p>
                  </>
                )}
              </ProductForm>
            </Match>
            <Match when={route() === '#lists'}>
              <Section title="Storage folders" components="ProductDisclosure, ProductMenu">
                <div class="storage-folders">
                  <div class="storage-group-heading"><h3>Models</h3><ProductButton intent="add" onClick={() => complete('Add models folder chosen')}>Add</ProductButton></div>
                  <article class="storage-folder">
                    <div class="storage-folder-heading">
                      <div class="storage-folder-copy"><strong>Studio models folder with a long descriptive name</strong><code>/home/name/Dinkster/Models</code></div>
                      <ProductMenu label="Folder actions" icon={Ellipsis} iconOnly items={[{ label: 'Edit', onSelect: () => complete('Edit folder chosen') }]} />
                    </div>
                    <ProductDisclosure title="Model kinds"><ProductFacts label="Model kinds" items={[{ label: 'Checkpoints', value: '12 files' }, { label: 'LoRAs', value: '48 files' }]} /></ProductDisclosure>
                    <span class="storage-folder-mark">Downloads land here</span>
                  </article>
                  <article class="storage-folder">
                    <div class="storage-folder-heading"><div class="storage-folder-copy"><strong>Renders</strong><code>/home/name/Portraits/renders</code></div></div>
                    <div class="storage-folder-summary"><span>Images</span><span>24 files</span><ProductButton onClick={() => complete('Assets chosen')}>Open in Assets</ProductButton></div>
                    <span class="storage-folder-mark">New saves go here</span>
                  </article>
                </div>
              </Section>
              <Section
                title="Bordered list"
                components="ProductList, ProductListRow"
              >
                <ProductList label="Sign-in methods">
                  <ProductListRow
                    title="Password"
                    description="Last updated today"
                    action={
                      <ProductButton
                        onClick={() => complete('Change password chosen')}
                      >
                        Change
                      </ProductButton>
                    }
                  />
                  <ProductListRow
                    title="Security key"
                    description="Not configured"
                    action={
                      <ProductButton
                        intent="add"
                        onClick={() => complete('Add security key chosen')}
                      >
                        Add key
                      </ProductButton>
                    }
                  />
                  <ProductListRow
                    title="alex.with.a.long.address.for.layout@example.test"
                    description="A long row wraps its content without wrapping its action label."
                    action={
                      <ProductButton
                        intent="remove"
                        onClick={() => setDialog(true)}
                      >
                        Remove
                      </ProductButton>
                    }
                  />
                </ProductList>
              </Section>
              <Section title="Table" components="ProductTable">
                <ProductTable
                  label="Published packages"
                  columns={[
                    {
                      label: 'Package',
                      cell: (row: { name: string; version: string }) =>
                        row.name,
                    },
                    { label: 'Version', cell: (row) => row.version },
                    {
                      label: 'Action',
                      cell: () => (
                        <ProductButton
                          onClick={() => complete('Package opened')}
                        >
                          View
                        </ProductButton>
                      ),
                    },
                  ]}
                  rows={[
                    { name: 'Image tools', version: '1.2.0' },
                    {
                      name: 'Audio tools with a longer package name',
                      version: '2.0.1',
                    },
                  ]}
                />
              </Section>
              <Section
                title="Empty and loading"
                components="ProductEmptyState, ProductLoading"
              >
                <ProductEmptyState
                  message="No API keys yet."
                  action={
                    <ProductButton
                      intent="add"
                      onClick={() => complete('Create key chosen')}
                    >
                      Create key
                    </ProductButton>
                  }
                />
                <ProductLoading label="Loading packages" />
                <ProductEmptyState message="No matching packages." />
                <ProductTable
                  label="Empty package table"
                  columns={[{ label: 'Package', cell: (row: string) => row }]}
                  rows={[]}
                />
              </Section>
            </Match>
            <Match when={route() === '#messages'}>
              <Section
                title="Menus"
                components="ProductMenu, ProductAccountMenu"
              >
                <div class="dinkster-actions">
                  <ProductMenu
                    label="Package actions"
                    items={[
                      {
                        label: 'View package',
                        onSelect: () => complete('Package viewed'),
                      },
                      {
                        label: 'Add version',
                        intent: 'add',
                        icon: Plus,
                        onSelect: () => complete('Add version chosen'),
                      },
                      {
                        label: 'Unavailable action',
                        disabled: true,
                        onSelect: () => {},
                      },
                      {
                        label: 'Remove package',
                        intent: 'remove',
                        icon: Trash2,
                        onSelect: () => setDialog(true),
                      },
                    ]}
                  />
                  <ProductMenu
                    label="Unavailable actions"
                    items={[
                      {
                        label: 'Unavailable item',
                        disabled: true,
                        onSelect: () => {},
                      },
                    ]}
                  />
                  <ProductAccountMenu
                    name="Alex Morgan"
                    email="alex@example.test"
                    onSignOut={() => complete('Signed out')}
                  />
                </div>
              </Section>
              <Section
                title="Messages"
                components="ProductNotice, ProductErrorBanner, ProductToast, ProductField"
              >
                <ProductNotice>
                  This is a standing page notice. It has no dismiss action.
                </ProductNotice>
                <ProductNotice tone="warning">
                  QA environment. This is a warning-tone standing notice.
                </ProductNotice>
                <Show
                  when={error()}
                  fallback={
                    <ProductButton onClick={() => setError(true)}>
                      Show error banner
                    </ProductButton>
                  }
                >
                  <ProductErrorBanner onDismiss={() => setError(false)}>
                    The request could not be completed. Try again.
                  </ProductErrorBanner>
                </Show>
                <ProductButton
                  onClick={() => setToast({ message: 'Changes saved' })}
                >
                  Show success toast
                </ProductButton>
                <ProductField
                  label="Invalid value"
                  error="Check this value before continuing."
                >
                  {(attributes) => (
                    <ProductTextInput {...attributes} value="Invalid" />
                  )}
                </ProductField>
              </Section>
            </Match>
            <Match when={route() === '#signed-out'}>
              <ProductSection title="Page without account navigation">
                <p class="dinkster-description">
                  The shared shell keeps its full-width top bar without an empty
                  sidebar or a navigation toggle when no pages are supplied.
                </p>
                <ProductLink href="#account-data">
                  Return to the gallery
                </ProductLink>
              </ProductSection>
            </Match>
            <Match when={route() === '#account-data'}>
              <Section title="Account facts" components="ProductFacts">
                <ProductFacts
                  label="Account details"
                  items={[
                    { label: 'Username', value: 'alex' },
                    {
                      label: 'Email',
                      value: 'alex.with.a.long.address.for.layout@example.test',
                    },
                    {
                      label: 'Verification',
                      value: (
                        <ProductLink href="#messages">Verify email</ProductLink>
                      ),
                    },
                  ]}
                />
              </Section>
              <Section
                title="Show-once value"
                components="ProductCopyValue with ProductCodeBlock"
              >
                <ProductNotice>
                  This is a public sample, not a usable credential. A real page
                  clears a show-once value when you leave it.
                </ProductNotice>
                <ProductCopyValue
                  label="Example API key"
                  value="dk_sample_not_a_credential_abcdefghijklmnopqrstuvwxyz0123456789_abcdefghijklmnopqrstuvwxyz0123456789"
                  onCopied={() => complete('Copied.')}
                />
              </Section>
              <Section title="Recovery codes" components="ProductCodeBlock">
                <ProductCodeBlock
                  label="Example recovery codes"
                  value={'sample-1234\nsample-5678\nsample-9012'}
                />
              </Section>
              <Section title="Authenticator setup" components="ProductQrCode">
                <ProductQrCode
                  src="./qr-example.svg"
                  alt="Example QR code linking to dinkster.org, not an enrollment secret"
                />
              </Section>
              <Section title="Inactive history" components="ProductDisclosure">
                <ProductDisclosure title="Revoked tokens (1)">
                  <ProductList label="Revoked tokens">
                    <ProductListRow
                      title="Old publishing token"
                      description="Revoked today"
                    />
                  </ProductList>
                </ProductDisclosure>
                <ProductDisclosure title="Expired tokens (1)" open>
                  <ProductList label="Expired tokens">
                    <ProductListRow
                      title="Release token"
                      description="Expired yesterday"
                    />
                  </ProductList>
                </ProductDisclosure>
              </Section>
              <Section
                title="Signed-out shell"
                components="ProductShell with empty navigation"
              >
                <ProductLink href="#signed-out">
                  View shell without account navigation
                </ProductLink>
              </Section>
            </Match>
            <Match when={route() === '#confirmations'}>
              <Section
                title="Site confirmation"
                components="ProductConfirmation"
              >
                <ProductConfirmation
                  title="Remove API key?"
                  consequence="Applications using this key will lose access immediately."
                  actionLabel="Remove key"
                  intent="remove"
                  pending={pending()}
                  onConfirm={async () => {
                    setPending(true)
                    await new Promise((resolve) =>
                      window.setTimeout(resolve, 600),
                    )
                    setPending(false)
                    complete('Key removed')
                  }}
                  onCancel={() => complete('Removal cancelled')}
                />
              </Section>
              <Section
                title="App dialog"
                components="ProductDialog with ProductConfirmation"
              >
                <ProductButton intent="remove" onClick={() => setDialog(true)}>
                  Review removal
                </ProductButton>
              </Section>
              <Section
                title="Replaced built-in text"
                components="ProductStringsProvider"
              >
                <ProductStringsProvider strings={{ cancel: 'Keep the key' }}>
                  <ProductConfirmation
                    consequence="A product replaces the text the components supply, such as for another language."
                    actionLabel="Remove this key"
                    intent="remove"
                    onConfirm={() => setDialog(true)}
                    onCancel={() => complete('Key kept')}
                  />
                </ProductStringsProvider>
              </Section>
            </Match>
          </Switch>
        </Show>
        <Show when={route() !== '#canvas'}>
          <p class="dinkster-metadata" role="status">
            {activity()}
          </p>
        </Show>
      </ProductPage>
      <ProductToast
        notification={toast()}
        onDismiss={() => setToast(undefined)}
      />
      <Show when={dialog()}>
        <ProductDialog
          title="Remove item?"
          pending={pending()}
          onDismiss={() => setDialog(false)}
        >
          <ProductConfirmation
            consequence="This item will no longer be available."
            actionLabel="Remove item"
            intent="remove"
            pending={pending()}
            onConfirm={async () => {
              setPending(true)
              await new Promise((resolve) => window.setTimeout(resolve, 600))
              setPending(false)
              setDialog(false)
              complete('Item removed')
            }}
            onCancel={() => setDialog(false)}
          />
        </ProductDialog>
      </Show>
    </ProductShell>
  )
}

// The same width at which the stylesheet switches to the narrow layout.
const narrowQuery = matchMedia(
  `(max-width: ${components.layout.sidebarBreakpoint}px)`,
)

function WindowToolbarGallery() {
  const [state, setState] = createSignal('idle')
  const [shortcut, setShortcut] = createSignal('Ctrl+K')
  const [runActivity, setRunActivity] = createSignal('idle')
  const runCounts = () => ({
    running:
      runActivity() === 'multiple' ? 3 : runActivity() === 'running' ? 1 : 0,
    waiting: runActivity() === 'idle' ? 0 : 2,
  })
  const runSummary = () =>
    `${runCounts().running} running, ${runCounts().waiting} queued`
  const [brand, setBrand] = createSignal('menu')
  const [projectName, setProjectName] = createSignal('Sample project')
  const [account, setAccount] = createSignal('none')
  const [rightAttention, setRightAttention] = createSignal('none')
  const rightPanelAttention = (): ProductAttention | undefined =>
    rightAttention() === 'info'
      ? { count: 1, tone: 'info', label: '1 message' }
      : rightAttention() === 'warning'
        ? { count: 2, tone: 'warning', label: '2 warnings' }
        : rightAttention() === 'problem'
          ? { count: 3, tone: 'problem', label: '3 problems' }
          : undefined
  const [visible, setVisible] = createSignal<Record<string, boolean>>({
    'Left panel': true,
    'Bottom panel': false,
    'Right panel': true,
    'Left bar': true,
    'Status bar': true,
  })
  const panels = [
    ['Left panel', PanelLeft],
    ['Bottom panel', PanelBottom],
    ['Right panel', PanelRight],
  ] as const
  const toggle = (label: string) => {
    setVisible((value) => ({ ...value, [label]: !value[label] }))
    setActivity(`${label} ${visible()[label] ? 'shown' : 'hidden'}`)
  }
  const [activity, setActivity] = createSignal('No action yet')
  return (
    <main class="dinkster-stack">
      <ProductPage
        title="Window toolbar"
        description="Shared native geometry and responsive actions; these previews do not exercise OS controls."
      >
        <ProductLink href="#desktop-about">
          Back to Desktop information
        </ProductLink>
        <ProductField label="Execution state">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={state()}
              onChange={(event) => setState(event.currentTarget.value)}
            >
              <For each={['idle', 'running', 'pending']}>
                {(value) => <option value={value}>{value}</option>}
              </For>
            </ProductSelect>
          )}
        </ProductField>
        <ProductField label="All-workflow activity">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={runActivity()}
              onChange={(event) => setRunActivity(event.currentTarget.value)}
            >
              <option value="idle">Idle</option>
              <option value="waiting">Queued only</option>
              <option value="running">One running, two queued</option>
              <option value="multiple">Three running, two queued</option>
            </ProductSelect>
          )}
        </ProductField>
        <ProductField label="Brand presentation">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={brand()}
              onChange={(event) => setBrand(event.currentTarget.value)}
            >
              <option value="menu">Plain menu</option>
              <option value="wordmark">D symbol action</option>
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
        <ProductField label="Account state">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={account()}
              onChange={(event) => setAccount(event.currentTarget.value)}
            >
              <option value="none">No account control</option>
              <option value="signed-out">Signed out</option>
              <option value="signing-in">Signing in</option>
              <option value="signing-in-no-url">
                Signing in without local URL
              </option>
              <option value="sign-in-unavailable">
                Sign in from engine machine
              </option>
              <option value="signed-in">Signed in</option>
              <option value="signed-in-email">Email only</option>
              <option value="signed-in-empty">No profile</option>
            </ProductSelect>
          )}
        </ProductField>
        <ProductField label="Right panel attention">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={rightAttention()}
              onChange={(event) => setRightAttention(event.currentTarget.value)}
            >
              <option value="none">None</option>
              <option value="info">One message</option>
              <option value="warning">Two warnings</option>
              <option value="problem">Three problems</option>
            </ProductSelect>
          )}
        </ProductField>
        <ProductField label="Search shortcut">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={shortcut()}
              onChange={(event) => setShortcut(event.currentTarget.value)}
            >
              <option value="Ctrl+K">Ctrl+K</option>
              <option value="Alt+K">Alt+K</option>
              <option value="">No shortcut</option>
            </ProductSelect>
          )}
        </ProductField>
        <p role="status">{activity()}</p>
      </ProductPage>
      <For each={['dark', 'light'] as const}>
        {(theme) => (
          <For each={['production', 'qa', 'custom'] as const}>
            {(service) => (
              <For each={['win32', 'darwin', 'linux'] as const}>
                {(platform) => (
                  <section
                    class="dinkster-stack dinkster-root"
                    data-theme={theme}
                    aria-label={`${service} ${theme} ${platform}`}
                  >
                    <h2 class="dinkster-heading">
                      {service} / {theme} / {platform}
                    </h2>
                    <ProductWindowToolbar
                      title="Application controls"
                      platform={platform}
                      service={
                        service === 'production'
                          ? undefined
                          : service === 'qa'
                            ? 'QA services'
                            : 'Custom services'
                      }
                      serviceKind={
                        service === 'production' ? undefined : service
                      }
                      qa={service === 'qa'}
                      development={service !== 'production'}
                      account={
                        <Show when={account() !== 'none'}>
                          <Show
                            when={account().startsWith('signed-in')}
                            fallback={
                              <ProductSignInControl
                                pending={account().startsWith('signing-in')}
                                unavailableReason={
                                  account() === 'sign-in-unavailable'
                                    ? 'Sign in from the computer that runs Dinkster.'
                                    : ''
                                }
                                onSignIn={() => {
                                  setActivity('Sign in opened')
                                  setAccount('signing-in')
                                }}
                                onCancel={() => {
                                  setAccount('signed-out')
                                  setActivity('Sign-in cancelled')
                                }}
                                onOpenSignInPage={
                                  account() === 'signing-in'
                                    ? () => setActivity('Sign-in page opened')
                                    : undefined
                                }
                              />
                            }
                          >
                            <ProductAccountMenu
                              name={
                                account() === 'signed-in' ? 'Alex Rivers' : null
                              }
                              email={
                                account() === 'signed-in-empty'
                                  ? null
                                  : 'alex@example.test'
                              }
                              onSignOut={() => setActivity('Signed out')}
                            />
                          </Show>
                        </Show>
                      }
                      brand={
                        <Show
                          when={brand() === 'wordmark'}
                          fallback={
                            <ProductMenu
                              label="Dinkster"
                              triggerName="Dinkster menu"
                              icon={() => <ProductBrandMark />}
                              items={[
                                {
                                  label: 'Projects',
                                  onSelect: () =>
                                    setActivity('Projects opened'),
                                },
                              ]}
                            />
                          }
                        >
                          <ProductWindowAction
                            label="Dinkster menu"
                            labelContent={
                              <>
                                <ProductBrandMark />
                                <ProductIcon icon={ChevronDown} />
                              </>
                            }
                            icon={() => <ProductBrandMark />}
                            pending={state() === 'pending'}
                            onClick={() => setActivity('Dinkster opened')}
                          />
                        </Show>
                      }
                      search={
                        <ProductWindowAction
                          label="Search"
                          icon={Search}
                          shortcut={shortcut()}
                          onClick={() => setActivity('Search opened')}
                        />
                      }
                      actions={(narrow) => (
                        <>
                          <Show when={runCounts().running > 0}>
                            <ProductRunActivity
                              {...runCounts()}
                              label={runSummary()}
                            />
                          </Show>
                          <ProductMenu
                            label="Customize layout"
                            icon={Settings}
                            attention={
                              narrow() ? rightPanelAttention() : undefined
                            }
                            items={[
                              ...[
                                ...(narrow()
                                  ? panels.map(([label]) => label)
                                  : []),
                                'Left bar',
                                'Status bar',
                              ].map((label) => ({
                                label,
                                checked: visible()[label]!,
                                attention:
                                  label === 'Right panel'
                                    ? rightPanelAttention()
                                    : undefined,
                                onSelect: () => toggle(label),
                              })),
                              {
                                label: 'Reset layout',
                                onSelect: () => {
                                  setVisible({
                                    'Left panel': true,
                                    'Bottom panel': false,
                                    'Right panel': true,
                                    'Left bar': true,
                                    'Status bar': true,
                                  })
                                  setActivity('Layout reset')
                                },
                              },
                            ]}
                          />
                          <Show when={!narrow()}>
                            <For each={panels}>
                              {([label, icon]) => (
                                <ProductIconButton
                                  label={label}
                                  icon={icon}
                                  aria-pressed={visible()[label]}
                                  onClick={() => toggle(label)}
                                />
                              )}
                            </For>
                          </Show>
                          <Show when={state() !== 'idle'}>
                            <ProductWindowAction
                              label="Cancel run"
                              icon={Square}
                              intent="remove"
                              pending={state() === 'pending'}
                              onClick={() => setActivity('Run cancelled')}
                            />
                          </Show>
                          <ProductWindowAction
                            label={projectName()}
                            labelContent={
                              <span class="dinkster-window-project-label">
                                <ProductIcon icon={FolderOpen} />
                                <span class="dinkster-window-project-name">
                                  {projectName()}
                                </span>
                              </span>
                            }
                            icon={FolderOpen}
                            onClick={() => setActivity('Projects opened')}
                          />
                          <ProductIconButton
                            label="Collaboration"
                            icon={Users}
                            onClick={() => setActivity('Collaboration opened')}
                          />
                        </>
                      )}
                    />
                  </section>
                )}
              </For>
            )}
          </For>
        )}
      </For>
    </main>
  )
}

function GalleryRoot() {
  const [route, setRoute] = createSignal(window.location.hash)
  const [narrow, setNarrow] = createSignal(narrowQuery.matches)
  // The site pages use the site form throughout. The gallery uses the Canvas
  // page's frame, except that below the breakpoint its other pages keep the
  // site form's narrow frame; their content always uses the site form.
  createEffect(() => {
    document.documentElement.dataset.density = route().startsWith('#site-')
      ? 'site'
      : route() !== '#canvas' && route() !== '#window-toolbar' && narrow()
        ? 'site'
        : 'app'
  })
  onMount(() => {
    const change = () => setNarrow(narrowQuery.matches)
    narrowQuery.addEventListener('change', change)
    onCleanup(() => narrowQuery.removeEventListener('change', change))
  })
  onMount(() => {
    const update = () => setRoute(window.location.hash)
    window.addEventListener('hashchange', update)
    onCleanup(() => window.removeEventListener('hashchange', update))
  })
  return (
    <Show
      when={route().startsWith('#site-')}
      fallback={
        <Show when={route() === '#window-toolbar'} fallback={<Gallery />}>
          <WindowToolbarGallery />
        </Show>
      }
    >
      <SiteGallery
        route={route()}
        onNavigate={(href) => {
          window.location.hash = href
          setRoute(href)
        }}
      />
    </Show>
  )
}

render(() => <GalleryRoot />, document.getElementById('root')!)

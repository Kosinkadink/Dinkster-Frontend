import {
  For,
  Match,
  Show,
  Switch,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { render } from 'solid-js/web'
import {
  Bell,
  CircleAlert,
  LayoutList,
  MousePointer,
  Plus,
  Settings,
  Trash2,
  User,
} from 'lucide-solid'
import {
  ProductAccountMenu,
  ProductButton,
  ProductCheckbox,
  ProductConfirmation,
  ProductDialog,
  ProductEmptyState,
  ProductErrorBanner,
  ProductField,
  ProductForm,
  ProductIcon,
  ProductIconButton,
  ProductList,
  ProductListRow,
  ProductLoading,
  ProductMenu,
  ProductNotice,
  ProductPage,
  ProductRadio,
  ProductSelect,
  ProductShell,
  ProductSpinner,
  ProductTable,
  ProductTextArea,
  ProductTextInput,
  ProductToast,
  reportProductEvent,
  type ProductRole,
} from '../src/index.js'
import '../dist/dinkster.css'

const navigation = [
  { label: 'Buttons and fields', href: '#controls', icon: MousePointer },
  { label: 'Forms', href: '#forms', icon: User },
  { label: 'Lists and tables', href: '#lists', icon: LayoutList },
  { label: 'Menus and messages', href: '#messages', icon: Bell },
  { label: 'Confirmations', href: '#confirmations', icon: CircleAlert },
]

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section class="dinkster-stack" aria-label={props.title}>
      <h2 class="dinkster-heading">{props.title}</h2>
      {props.children}
    </section>
  )
}

function Gallery() {
  const [route, setRoute] = createSignal(window.location.hash || '#controls')
  const [toast, setToast] = createSignal<{ message: string }>()
  const [error, setError] = createSignal(true)
  const [dialog, setDialog] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [fail, setFail] = createSignal(false)
  const [invalid, setInvalid] = createSignal(false)
  const [activity, setActivity] = createSignal('No action yet')
  const [loading, setLoading] = createSignal(false)
  let navigationTimer: number | undefined
  onCleanup(() => window.clearTimeout(navigationTimer))
  const navigate = (href: string) => {
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
      navigation={navigation}
      currentHref={route()}
      onNavigate={navigate}
      account={
        <ProductAccountMenu
          name="Alex Morgan"
          email="alex@example.test"
          onSignOut={() => complete('Signed out')}
        />
      }
    >
      <ProductPage
        title={
          navigation.find((item) => item.href === route())?.label ??
          'Buttons and fields'
        }
        description="The live shared components. Use a pointer or keyboard to inspect hover, focus and pressed states."
        table={route() === '#lists'}
      >
        <Show
          when={!loading()}
          fallback={<ProductLoading label="Loading selected page" />}
        >
          <Switch
            fallback={<ProductEmptyState message="Choose a gallery page." />}
          >
            <Match when={route() === '#controls'}>
              <Section title="Button roles and fills">
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
                        <ProductButton intent={intent} loading>
                          {label} pending
                        </ProductButton>
                        <ProductButton intent={intent} fill="solid" disabled>
                          {label} solid disabled
                        </ProductButton>
                        <ProductButton intent={intent} fill="solid" loading>
                          {label} solid pending
                        </ProductButton>
                      </div>
                    )
                  }}
                </For>
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
              </Section>
              <Section title="Text fields">
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
              <Section title="Choices">
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
                label="Show field error"
                checked={invalid()}
                onChange={(event) => setInvalid(event.currentTarget.checked)}
              />
              <ProductForm
                initialValues={{
                  name: 'Alex Morgan',
                  description: 'Personal account',
                }}
                onSave={async () => {
                  await new Promise((resolve) =>
                    window.setTimeout(resolve, 600),
                  )
                  if (fail()) throw new Error('Gallery refusal')
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
                      error={invalid() ? 'Enter a display name.' : ''}
                    >
                      {(attributes) => (
                        <ProductTextInput
                          {...attributes}
                          value={form.values().name}
                          onInput={(event) =>
                            form.setValue('name', event.currentTarget.value)
                          }
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
              <Section title="Bordered list">
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
              <Section title="Table">
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
              <Section title="Empty and loading">
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
              <Section title="Menus">
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
              <Section title="Messages">
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
            <Match when={route() === '#confirmations'}>
              <Section title="Site confirmation">
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
              <Section title="App dialog">
                <ProductButton intent="remove" onClick={() => setDialog(true)}>
                  Review removal
                </ProductButton>
              </Section>
            </Match>
          </Switch>
        </Show>
        <p class="dinkster-metadata" role="status">
          {activity()}
        </p>
      </ProductPage>
      <Show when={toast()} keyed>
        {(notification) => (
          <ProductToast onDismiss={() => setToast(undefined)}>
            {notification.message}
          </ProductToast>
        )}
      </Show>
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

render(() => <Gallery />, document.getElementById('root')!)

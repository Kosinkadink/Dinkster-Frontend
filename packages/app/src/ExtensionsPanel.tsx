import type { CategoryStatus, PackStatus, ReadonlySignal } from '@dinkster/core'
import { createMemo, Index, Show } from 'solid-js'
import { useAppMessage } from './locale.js'
import { ProductCheckbox } from './ProductControls.js'
import { ProductNotice } from './ProductForm.js'
import { useSignal } from './solid-adapter.js'

interface ExtensionManagementHost {
  readonly changed: ReadonlySignal<number>
  packs(): readonly PackStatus[]
  setPackEnabled(packId: string, enabled: boolean): void
  setCategoryEnabled(packId: string, category: CategoryStatus['category'], enabled: boolean): void
  setContributionEnabled(contributionId: string, enabled: boolean): void
}

type Message = ReturnType<typeof useAppMessage>
type ExtensionState = keyof typeof STATE_MESSAGES

const STATE_MESSAGES = {
  'Activation failed': 'extensions.state.activationFailed',
  'Active': 'extensions.state.active',
  'Active and registered': 'extensions.state.activeRegistered',
  'Blocked by policy': 'extensions.state.blockedByPolicy',
  'Declared, not registered': 'extensions.state.declaredNotRegistered',
  'Disabled by user': 'extensions.state.disabledByUser',
  'Enabled, inactive': 'extensions.state.enabledInactive',
  'Enabled, inactive: category disabled': 'extensions.state.enabledInactiveCategoryDisabled',
  'Enabled, inactive: pack disabled': 'extensions.state.enabledInactivePackDisabled',
  'Registered and active': 'extensions.state.registeredActive',
  'Registered, inactive': 'extensions.state.registeredInactive',
  'Registration failed': 'extensions.state.registrationFailed',
} as const

const stateLabel = (message: Message, state: ExtensionState): string => message(STATE_MESSAGES[state])

const controlReason = (message: Message, policyReason: string | undefined, registered: boolean): string | undefined =>
  policyReason ?? (registered ? undefined : message('extensions.control.unregistered'))

function packState(pack: PackStatus): ExtensionState {
  if (!pack.registered) return 'Activation failed'
  if (pack.policyBlocked) return 'Blocked by policy'
  if (!pack.enabled) return 'Disabled by user'
  return pack.active ? 'Registered and active' : 'Registered, inactive'
}

function categoryState(pack: PackStatus, category: CategoryStatus): ExtensionState {
  if (category.policyBlocked) return 'Blocked by policy'
  if (!category.enabled) return 'Disabled by user'
  if (!pack.enabled) return 'Enabled, inactive: pack disabled'
  return category.contributions.some((contribution) => contribution.active)
    ? 'Active'
    : 'Enabled, inactive'
}

function contributionState(pack: PackStatus, category: CategoryStatus, index: number): ExtensionState {
  const contribution = category.contributions[index]!
  if (contribution.policyBlocked) return 'Blocked by policy'
  if (!contribution.enabled) return 'Disabled by user'
  if (contribution.state === 'unregistered') return 'Declared, not registered'
  if (contribution.state === 'failed') return 'Registration failed'
  if (!pack.enabled) return 'Enabled, inactive: pack disabled'
  if (!category.enabled) return 'Enabled, inactive: category disabled'
  return contribution.state === 'active'
    ? 'Active and registered'
    : 'Enabled, inactive'
}

export function ExtensionsPanel(props: { readonly host: ExtensionManagementHost }) {
  const message = useAppMessage()
  const changed = useSignal(props.host.changed)
  const packs = createMemo(() => {
    changed()
    return props.host.packs()
  })
  return (
    <div class="rail-panel-body extensions-panel" data-testid="extensions-panel">
      <header class="extensions-panel-intro">
        <h2>{message('extensions.title')}</h2>
        <p>{message('extensions.description')}</p>
      </header>
      <Show when={packs().length > 0} fallback={
        <ProductNotice tone="info" testId="extensions-empty">{message('extensions.empty')}</ProductNotice>
      }>
        <div class="extension-pack-list">
          <Index each={packs()}>{(pack, packIndex) => {
            const packReasonId = `extension-pack-${packIndex}-reason`
            const packReason = () => {
              return controlReason(message, pack().policyReason, pack().registered)
            }
            return (
              <section
                class="extension-pack"
                data-testid="extension-pack"
                data-pack={pack().manifest.id}
                data-state={packState(pack())}
                aria-label={message('extensions.aria.pack', { id: pack().manifest.id })}
              >
                <div class="extension-pack-header">
                  <ProductCheckbox
                    testId="extension-pack-toggle"
                    ariaLabel={message('extensions.action.enablePack', { id: pack().manifest.id })}
                    ariaDescribedBy={packReason() ? packReasonId : undefined}
                    checked={pack().enabled}
                    disabled={packReason() !== undefined}
                    onChange={(checked) => props.host.setPackEnabled(pack().manifest.id, checked)}
                  />
                  <div class="extension-identity">
                    <h3>{pack().manifest.displayName ?? pack().manifest.id}</h3>
                    <code title={pack().manifest.id}>{pack().manifest.id}</code>
                  </div>
                  <strong class="extension-state" data-state={packState(pack())}>{stateLabel(message, packState(pack()))}</strong>
                </div>
                <Show when={packReason()}>{(reason) => <p id={packReasonId} class="extension-control-reason">{reason()}</p>}</Show>
                <Show when={pack().categories.length > 0} fallback={
                  <ProductNotice tone="info">{message('extensions.emptyContributions')}</ProductNotice>
                }>
                  <div class="extension-category-list">
                    <Index each={pack().categories}>{(category, categoryIndex) => {
                      const reason = () => controlReason(message, category().policyReason, pack().registered)
                      const reasonId = `extension-pack-${packIndex}-category-${categoryIndex}-reason`
                      return (
                        <section
                          class="extension-category-group"
                          data-testid="extension-category"
                          data-category={category().category}
                          aria-label={message('extensions.aria.category', { category: category().category })}
                        >
                          <div class="extension-category-header">
                            <ProductCheckbox
                              testId="extension-category-toggle"
                              ariaLabel={message('extensions.action.enableCategory', { id: pack().manifest.id, category: category().category })}
                              ariaDescribedBy={reason() ? reasonId : undefined}
                              checked={category().enabled}
                              disabled={reason() !== undefined}
                              onChange={(checked) => props.host.setCategoryEnabled(pack().manifest.id, category().category, checked)}
                            />
                            <h4>{category().category}</h4>
                            <strong class="extension-state" data-state={categoryState(pack(), category())}>{stateLabel(message, categoryState(pack(), category()))}</strong>
                          </div>
                          <Show when={reason()}>{(text) => <p id={reasonId} class="extension-control-reason">{text()}</p>}</Show>
                          <ul class="extension-contribution-list">
                            <Index each={category().contributions}>{(contribution, contributionIndex) => {
                              const contributionReason = () => controlReason(message, contribution().policyReason, pack().registered)
                              const contributionReasonId = `extension-pack-${packIndex}-category-${categoryIndex}-contribution-${contributionIndex}-reason`
                              const state = () => {
                                return contributionState(pack(), category(), contributionIndex)
                              }
                              return (
                                <li
                                  class="extension-contribution"
                                  data-testid="extension-contribution"
                                  data-contribution={contribution().decl.id}
                                  data-active={contribution().active}
                                  data-state={state()}
                                >
                                  <ProductCheckbox
                                    testId="extension-contribution-toggle"
                                    ariaLabel={message('extensions.action.enableContribution', { id: contribution().decl.id })}
                                    ariaDescribedBy={contributionReason() ? contributionReasonId : undefined}
                                    checked={contribution().enabled}
                                    disabled={contributionReason() !== undefined}
                                    onChange={(checked) => props.host.setContributionEnabled(contribution().decl.id, checked)}
                                  />
                                  <div class="extension-identity">
                                    <strong title={contribution().decl.label ?? contribution().decl.id}>{contribution().decl.label ?? contribution().decl.id}</strong>
                                    <code title={contribution().decl.id}>{contribution().decl.id}</code>
                                  </div>
                                  <span class="extension-state" data-state={state()}>{stateLabel(message, state())}</span>
                                  <Show when={contributionReason()}>{(text) => <p id={contributionReasonId} class="extension-control-reason">{text()}</p>}</Show>
                                </li>
                              )
                            }}</Index>
                          </ul>
                        </section>
                      )
                    }}</Index>
                  </div>
                </Show>
                <Show when={pack().diagnostics.length > 0}>
                  <section class="extension-diagnostics" aria-label={message('extensions.aria.diagnostics', { id: pack().manifest.id })}>
                    <h4>{message('extensions.diagnostics')}</h4>
                    <ul>
                      <Index each={pack().diagnostics}>{(diagnostic) => (
                        <li data-severity={diagnostic().severity}>
                          <strong>{diagnostic().severity}: {diagnostic().code}</strong>
                          <span>{diagnostic().message}</span>
                        </li>
                      )}</Index>
                    </ul>
                  </section>
                </Show>
              </section>
            )
          }}</Index>
        </div>
      </Show>
    </div>
  )
}

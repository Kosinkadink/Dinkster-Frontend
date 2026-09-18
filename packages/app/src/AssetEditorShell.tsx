import {
  ASSET_EDITOR_CAPABILITY_KINDS,
  ASSET_EDITOR_FIELD_KINDS,
  type AssetEditorActionV1,
  type AssetEditorFieldV1,
  type AssetEditorPresentationV1,
} from '@dinkster/core'
import { CircleAlert, CircleCheck, CircleDashed, FileQuestion, Image, LoaderCircle, LockKeyhole, Pencil } from 'lucide-solid'
import { For, Show } from 'solid-js'
import { Icon } from './Icon.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from './ProductForm.js'
import { ProductTabs, type ProductTab } from './ProductTabs.js'
import type { CommandRegistry } from './settings.js'

function ShellAction(props: {
  readonly action: AssetEditorActionV1
  readonly commands: CommandRegistry
  readonly idPrefix: string
  readonly compact?: boolean
}) {
  const command = () => props.commands.get(props.action.command)
  const descriptorAllowsInvocation = () => props.action.state === 'enabled'
  const disabled = () => !descriptorAllowsInvocation() || command() === undefined || command()!.enabled?.() === false
  const reason = () => props.action.disabledReason ?? (command() === undefined ? 'Command unavailable.' : undefined)
  const reasonId = `${props.idPrefix}-${encodeURIComponent(props.action.key)}-reason`
  const detailId = `${props.idPrefix}-${encodeURIComponent(props.action.key)}-detail`
  const describedBy = () => [
    disabled() && reason() !== undefined ? reasonId : undefined,
    props.action.detail === undefined ? undefined : detailId,
  ].filter(Boolean).join(' ') || undefined
  const run = (): void => {
    const current = command()
    if (disabled() || current === undefined) return
    current.run()
  }
  return (
    <span
      class="asset-editor-shell-action"
      data-action-state={props.action.state}
      data-compact={props.compact === true ? 'true' : undefined}
      data-testid="asset-editor-shell-action"
    >
      <button
        type="button"
        disabled={disabled()}
        aria-busy={props.action.state === 'pending' ? 'true' : undefined}
        aria-describedby={describedBy()}
        onClick={run}
      >
        <Show when={props.action.state === 'pending'}><Icon icon={LoaderCircle} /></Show>
        {props.action.label}
      </button>
      <Show when={disabled() && reason() !== undefined}>
        <span id={reasonId} class="asset-editor-shell-action-detail">{reason()}</span>
      </Show>
      <Show when={props.action.detail !== undefined}>
        <span
          id={detailId}
          class="asset-editor-shell-action-detail"
          role={props.action.state === 'failed' ? 'alert' : props.action.state === 'pending' ? 'status' : undefined}
          aria-live={props.action.state === 'pending' ? 'polite' : undefined}
        >
          {props.action.detail}
        </span>
      </Show>
    </span>
  )
}

function FieldPresentation(props: {
  readonly field: AssetEditorFieldV1
  readonly commands: CommandRegistry
  readonly idPrefix: string
}) {
  const supportedKind = () => (ASSET_EDITOR_FIELD_KINDS as readonly string[]).includes(props.field.kind)
  const supportedCapability = () => (ASSET_EDITOR_CAPABILITY_KINDS as readonly string[]).includes(props.field.capability.kind)
  const supported = () => supportedKind() && supportedCapability()
  const editable = () => supported() && props.field.capability.kind === 'editable'
  const controlId = `${props.idPrefix}-${encodeURIComponent(props.field.key)}-value`
  const ids = productFieldIds(controlId)
  const describedBy = () => [
    props.field.description === undefined ? undefined : ids.description,
    props.field.validation === undefined ? undefined : ids.message,
  ].filter(Boolean).join(' ') || undefined
  const messageTone = () => props.field.validation?.tone === 'warning'
    ? 'warning' as const
    : props.field.validation?.tone === 'info' || props.field.validation?.tone === 'status'
      ? 'status' as const
      : 'error' as const
  return (
    <Show
      when={supported()}
      fallback={
        <div class="asset-editor-shell-unsupported" data-testid="asset-editor-shell-unsupported" role="group" aria-label={props.field.label}>
          <ProductNotice tone="warning">
            {supportedKind()
              ? `Unsupported field capability: ${props.field.capability.kind}`
              : `Unsupported field presentation: ${props.field.kind}`}
          </ProductNotice>
        </div>
      }
    >
      <ProductField
        controlId={controlId}
        label={props.field.label}
        description={props.field.description}
        metadata={<span class="asset-editor-shell-field-meta">
          <Show when={props.field.origin}>{(origin) => (
            <>
              <span class={`asset-editor-shell-origin host-ui-tone-${origin().tone ?? 'neutral'}`}>
                {origin().label}
              </span>
              <Show when={origin().detail}>
                <span class="asset-editor-shell-origin-detail">{origin().detail}</span>
              </Show>
            </>
          )}</Show>
          <span class="asset-editor-shell-capability" data-capability={props.field.capability.kind}>
            <Icon icon={editable() ? Pencil : LockKeyhole} />
            {props.field.capability.label ?? (editable() ? 'Editable' : 'Read only')}
          </span>
          <Show when={props.field.capability.reason}><span>{props.field.capability.reason}</span></Show>
        </span>}
        invalid={props.field.validation?.tone === 'error'}
        message={props.field.validation?.text}
        messageTone={messageTone()}
        actions={editable() && props.field.action !== undefined
          ? <ShellAction action={props.field.action} commands={props.commands} idPrefix={props.idPrefix} compact />
          : undefined}
      >
        <input
          id={controlId}
          value={props.field.value}
          readOnly
          aria-readonly="true"
          aria-labelledby={ids.label}
          aria-describedby={describedBy()}
          aria-invalid={props.field.validation?.tone === 'error' ? 'true' : undefined}
        />
      </ProductField>
    </Show>
  )
}

function InspectorPanel(props: {
  readonly presentation: AssetEditorPresentationV1
  readonly commands: CommandRegistry
  readonly idPrefix: string
}) {
  return (
    <div class="asset-editor-shell-fields" data-testid="asset-editor-shell-fields">
      <Show when={props.presentation.fields.length > 0} fallback={<ProductNotice tone="info">No fields were supplied.</ProductNotice>}>
        <For each={props.presentation.fields}>{(field) => (
          <FieldPresentation field={field} commands={props.commands} idPrefix={props.idPrefix} />
        )}</For>
      </Show>
    </div>
  )
}

function EditorPanel(props: {
  readonly presentation: AssetEditorPresentationV1
  readonly commands: CommandRegistry
  readonly idPrefix: string
}) {
  return (
    <div class="asset-editor-shell-tools" data-testid="asset-editor-shell-tools">
      <Show when={(props.presentation.tools?.length ?? 0) > 0} fallback={<ProductNotice tone="info">No editor tools were supplied.</ProductNotice>}>
        <For each={props.presentation.tools}>{(tool) => (
          <section class="asset-editor-shell-tool" data-tool-state={tool.state} aria-labelledby={`${props.idPrefix}-${tool.key}-heading`}>
            <header>
              <h3 id={`${props.idPrefix}-${tool.key}-heading`}>{tool.label}</h3>
              <span class="asset-editor-shell-state">{tool.state}</span>
            </header>
            <Show when={tool.detail}><p>{tool.detail}</p></Show>
            <Show when={(tool.actions?.length ?? 0) > 0}>
              <div class="asset-editor-shell-tool-actions">
                <For each={tool.actions}>{(action) => (
                  <ShellAction action={action} commands={props.commands} idPrefix={props.idPrefix} compact />
                )}</For>
              </div>
            </Show>
          </section>
        )}</For>
      </Show>
    </div>
  )
}

export function AssetEditorShell(props: {
  readonly presentation: AssetEditorPresentationV1
  readonly commands: CommandRegistry
  readonly idPrefix: string
  readonly hostUiKey: string
}) {
  const viewportLabelId = `${props.idPrefix}-viewport-label`
  const viewportStateId = `${props.idPrefix}-viewport-state`
  const viewportDetailId = `${props.idPrefix}-viewport-detail`
  const viewportDescribedBy = () => [
    viewportStateId,
    props.presentation.viewport.detail === undefined ? undefined : viewportDetailId,
  ].filter(Boolean).join(' ')
  const viewportIcon = () => props.presentation.viewport.state === 'loading'
    ? LoaderCircle
    : props.presentation.viewport.state === 'ready'
      ? Image
      : props.presentation.viewport.state === 'error'
        ? CircleAlert
        : FileQuestion
  const factIcon = (state: 'absent' | 'pending' | 'ready' | 'error') => state === 'pending'
    ? LoaderCircle
    : state === 'ready'
      ? CircleCheck
      : state === 'error'
        ? CircleAlert
        : CircleDashed
  const tabs: readonly ProductTab[] = [
    {
      id: 'inspector',
      label: 'Inspector',
      panel: <InspectorPanel presentation={props.presentation} commands={props.commands} idPrefix={props.idPrefix} />,
    },
    {
      id: 'editor',
      label: 'Editor',
      panel: <EditorPanel presentation={props.presentation} commands={props.commands} idPrefix={props.idPrefix} />,
    },
  ]
  return (
    <section
      class="asset-editor-shell"
      data-testid="asset-editor-shell"
      data-host-ui-key={props.hostUiKey}
      aria-labelledby={`${props.idPrefix}-heading`}
    >
      <header class="asset-editor-shell-heading">
        <div>
          <span class="asset-editor-shell-eyebrow">Asset editor</span>
          <h2 id={`${props.idPrefix}-heading`}>{props.presentation.heading}</h2>
        </div>
        <Show when={props.presentation.description}><p>{props.presentation.description}</p></Show>
      </header>

      <Show when={(props.presentation.messages?.length ?? 0) > 0}>
        <div class="asset-editor-shell-messages">
          <For each={props.presentation.messages}>{(message) => (
            <ProductNotice tone={message.tone}>{message.text}</ProductNotice>
          )}</For>
        </div>
      </Show>

      <div class="asset-editor-shell-main">
        <div class="asset-editor-shell-preview-column">
          <section
            class="asset-editor-shell-viewport"
            data-viewport-state={props.presentation.viewport.state}
            aria-labelledby={viewportLabelId}
            aria-describedby={viewportDescribedBy()}
            aria-busy={props.presentation.viewport.state === 'loading' ? 'true' : undefined}
          >
            <span class="asset-editor-shell-viewport-icon"><Icon icon={viewportIcon()} /></span>
            <strong id={viewportLabelId}>{props.presentation.viewport.label}</strong>
            <span
              id={viewportStateId}
              class="asset-editor-shell-viewport-accessible-state"
              role={props.presentation.viewport.state === 'error' ? 'alert' : 'status'}
              aria-live={props.presentation.viewport.state === 'error' ? 'assertive' : 'polite'}
            >
              Viewport state: {props.presentation.viewport.state}.
            </span>
            <Show when={props.presentation.viewport.detail}>
              <span id={viewportDetailId}>{props.presentation.viewport.detail}</span>
            </Show>
          </section>

          <Show when={(props.presentation.factGroups?.length ?? 0) > 0}>
            <div class="asset-editor-shell-fact-groups" data-testid="asset-editor-shell-facts">
              <For each={props.presentation.factGroups}>{(group) => (
                <section class="asset-editor-shell-fact-group" aria-labelledby={`${props.idPrefix}-${group.key}-heading`}>
                  <h3 id={`${props.idPrefix}-${group.key}-heading`}>{group.label}</h3>
                  <dl>
                    <For each={group.facts}>{(fact) => (
                      <div class="asset-editor-shell-fact" data-fact-state={fact.state}>
                        <dt><Icon icon={factIcon(fact.state)} />{fact.label}</dt>
                        <dd>
                          <Show when={fact.value !== undefined}><strong>{fact.value}</strong></Show>
                          <span>{fact.detail ?? fact.state}</span>
                        </dd>
                      </div>
                    )}</For>
                  </dl>
                </section>
              )}</For>
            </div>
          </Show>
        </div>

        <ProductTabs
          class="asset-editor-shell-tabs"
          tabs={tabs}
          ariaLabel="Asset editor regions"
          defaultSelectedId="inspector"
        />
      </div>

      <Show when={(props.presentation.actions?.length ?? 0) > 0}>
        <ProductActionFooter class="asset-editor-shell-footer">
          <For each={props.presentation.actions}>{(action) => (
            <ShellAction action={action} commands={props.commands} idPrefix={props.idPrefix} />
          )}</For>
        </ProductActionFooter>
      </Show>
    </section>
  )
}

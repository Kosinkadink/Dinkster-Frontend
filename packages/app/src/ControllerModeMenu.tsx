import { For, Show } from 'solid-js'
import { Check } from 'lucide-solid'
import { CanvasSeedModeIcon } from '@dinkster/ui'
import type { ControllerMode, Diagnostic } from '@dinkster/core'
import { ProductButton } from './ProductControls.js'
import { Icon } from './Icon.js'
import { ProductNotice } from './ProductForm.js'

/** Shared canvas/card after-run menu; the caller owns placement and dispatch. */
export function ControllerModeMenu(props: {
  readonly ref?: (element: HTMLDivElement) => void
  readonly mode: ControllerMode
  readonly trigger: 'after_generate' | 'after_refresh'
  readonly pending?: boolean
  readonly refusal?: Diagnostic | undefined
  readonly onMode: (mode: ControllerMode) => void
}) {
  return <div ref={props.ref} class="dinkster-menu seed-controller-menu" data-testid="seed-controller-menu"
    role="menu" aria-busy={props.pending}>
    <div class="dinkster-menu-note">{props.trigger === 'after_refresh' ? 'After refresh' : 'After each run'}</div>
    <For each={[
      { mode: 'fixed' as const, label: 'Fixed' },
      { mode: 'increment' as const, label: props.trigger === 'after_refresh' ? 'Next' : 'Increment' },
      { mode: 'decrement' as const, label: props.trigger === 'after_refresh' ? 'Previous' : 'Decrement' },
      { mode: 'randomize' as const, label: 'Randomize' },
    ]}>{(option) => <ProductButton variant="ghost" type="button" role="menuitemradio"
      aria-checked={props.mode === option.mode} class="dinkster-menu-item seed-controller-option"
      data-testid={`seed-controller-${option.mode}`} disabled={props.pending} onClick={() => props.onMode(option.mode)}>
      <CanvasSeedModeIcon mode={option.mode} trigger={props.trigger} />
      <span class="dinkster-menu-item-label">{option.label}</span>
      <Show when={props.mode === option.mode}><span class="seed-controller-check"><Icon icon={Check} /></span></Show>
    </ProductButton>}</For>
    <Show when={props.refusal} keyed>{(refusal) => <ProductNotice tone="error" testId="controller-refusal">
      <strong>{refusal.code}</strong>: {refusal.message}
    </ProductNotice>}</Show>
  </div>
}

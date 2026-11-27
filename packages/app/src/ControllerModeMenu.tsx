import { For, Show } from 'solid-js'
import { Check, Dice5, Lock, Minus, Plus } from 'lucide-solid'
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
  return <div ref={props.ref} class="floating-surface seed-controller-menu" data-testid="seed-controller-menu"
    role="menu" aria-busy={props.pending}>
    <div class="seed-controller-title">After {props.trigger === 'after_refresh' ? 'refresh' : 'generate'}</div>
    <For each={[
      { mode: 'fixed' as const, label: 'Fixed', description: props.trigger === 'after_refresh' ? 'Keep this value after refresh.' : 'Keep this value after a successful run.', icon: Lock },
      { mode: 'increment' as const, label: 'Increment', description: props.trigger === 'after_refresh' ? 'Choose the next option after refresh.' : 'Add the widget step after a successful run.', icon: Plus },
      { mode: 'decrement' as const, label: 'Decrement', description: props.trigger === 'after_refresh' ? 'Choose the previous option after refresh.' : 'Subtract the widget step after a successful run.', icon: Minus },
      { mode: 'randomize' as const, label: props.trigger === 'after_refresh' ? 'Randomize after refresh' : 'Randomize after run',
        description: props.trigger === 'after_refresh'
          ? 'After each refresh, choose a random option; selecting this mode does not change the current value.'
          : 'After each successful run, choose a new seed within bounds; selecting this mode does not change the current value.', icon: Dice5 },
    ]}>{(option) => <ProductButton variant="ghost" size="compact" type="button" role="menuitemradio"
      aria-checked={props.mode === option.mode} class={`seed-controller-option${props.mode === option.mode ? ' selected' : ''}`}
      data-testid={`seed-controller-${option.mode}`} disabled={props.pending} onClick={() => props.onMode(option.mode)}>
      <Icon icon={option.icon} />
      <span><strong>{option.label}</strong><small>{option.description}</small></span>
      <Show when={props.mode === option.mode}><Icon icon={Check} /></Show>
    </ProductButton>}</For>
    <Show when={props.refusal} keyed>{(refusal) => <ProductNotice tone="error" testId="controller-refusal">
      <strong>{refusal.code}</strong>: {refusal.message}
    </ProductNotice>}</Show>
  </div>
}

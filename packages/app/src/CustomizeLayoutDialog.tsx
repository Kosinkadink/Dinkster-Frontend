import { For } from 'solid-js'
import { ProductCheckbox } from './ProductControls.js'
import { ProductActionFooter } from './ProductForm.js'

export interface LayoutVisibilityItem {
  readonly id: string
  readonly label: string
  readonly checked: () => boolean
  readonly toggle: () => void
}

/**
 * Visibility-only layout controls. The native ModalHost owns dialog focus,
 * Escape, backdrop dismissal, and focus restoration.
 */
export function CustomizeLayoutDialog(props: {
  readonly items: readonly LayoutVisibilityItem[]
  readonly onReset: () => void
}) {
  return (
    <div class="customize-layout" data-testid="customize-layout">
      <p class="customize-layout-intro">Choose which supported shell regions are visible.</p>
      <fieldset>
        <legend>Visibility</legend>
        <For each={props.items}>{(item) => (
          <label class="layout-visibility-row" data-layout-region={item.id}>
            <span>{item.label}</span>
            <ProductCheckbox
              ariaLabel={item.label}
              checked={item.checked()}
              onChange={item.toggle}
            />
          </label>
        )}</For>
      </fieldset>
      <ProductActionFooter>
        <button type="button" data-testid="layout-reset" onClick={props.onReset}>Reset visibility</button>
      </ProductActionFooter>
    </div>
  )
}

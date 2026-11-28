import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import {
  attachDomTooltips,
  ProductButton,
  ProductSection,
  ProductTooltip,
  TooltipController,
  type DomTooltipTarget,
} from '../src/index.js'

export function TooltipsGallery() {
  let root!: HTMLDivElement
  const controller = new TooltipController()
  const [tip, setTip] = createSignal(controller.visible)
  controller.register({
    id: 'gallery.dom',
    resolve(target, options) {
      const dom = target as Partial<DomTooltipTarget>
      return dom.kind === 'dom' && dom.label ? {
        lines: [dom.label],
        ...(dom.shortcut ? { shortcut: dom.shortcut } : {}),
        ...(options.detailed && dom.detail ? { detail: dom.detail } : {}),
      } : undefined
    },
  })
  onMount(() => {
    const detach = attachDomTooltips(root, controller)
    const unsubscribe = controller.subscribe(() => setTip(controller.visible))
    onCleanup(() => { detach(); unsubscribe(); controller.hide() })
  })
  return (
    <div ref={root}>
      <ProductSection title="Tooltips">
        <p class="dinkster-description">Hover or focus a control with Tab. Hold Alt for details; Escape dismisses the tooltip.</p>
        <div class="dinkster-actions">
          <ProductButton data-tooltip-label="Open the selected workflow" data-tooltip-shortcut="Ctrl+O">Workflow</ProductButton>
          <ProductButton data-tooltip-label="This description wraps to the available width without covering the control it describes. The same tooltip renderer serves DOM controls and painted canvas targets.">Long description</ProductButton>
          <ProductButton data-tooltip-label="Memory currently in use" data-tooltip-detail="Includes loaded models and the current execution.|Values refresh as execution changes.">Memory details</ProductButton>
        </div>
      </ProductSection>
      <Show when={tip()}>{(visible) => <ProductTooltip tip={visible()} label="Context help" />}</Show>
    </div>
  )
}

import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { ProductShortcut } from './shortcut.js'
import type { TooltipContent, VisibleTooltip } from './tooltip-controller.js'

export function ProductTooltip(props: { readonly tip: VisibleTooltip; readonly label: string }) {
  let element!: HTMLElement
  let content!: HTMLDivElement
  let readoutHeight: number | undefined
  const [fitted, setFitted] = createSignal<TooltipContent>()
  const displayed = () => fitted() ?? props.tip
  const position = (): void => {
    if (!element.isConnected) return
    const tip = props.tip
    const rect = tip.paintedRect?.() ?? tip.element?.getBoundingClientRect()
    const boundary = tip.boundary?.getBoundingClientRect()
    const leftEdge = Math.max(0, boundary?.left ?? 0)
    const topEdge = Math.max(0, boundary?.top ?? 0)
    const rightEdge = Math.min(window.innerWidth, boundary?.right ?? window.innerWidth)
    const bottomEdge = Math.min(window.innerHeight, boundary?.bottom ?? window.innerHeight)
    // A menu row's tooltip below it would cover the next row.
    const beside = rect !== undefined && (tip.paintedRect !== undefined || Boolean(tip.element?.closest('.left-sidebar, .context-menu')))
    const before = tip.paintedRect !== undefined && rect !== undefined && rect.left - leftEdge > rightEdge - rect.right
    element.style.maxWidth = `${Math.min(360, Math.max(1, beside ? before ? rect.left - leftEdge - 16 : rightEdge - rect.right - 16 : rightEdge - leftEdge - 16))}px`
    content.style.webkitLineClamp = ''
    const naturalHeight = element.getBoundingClientRect().height
    if (tip.fit !== undefined) readoutHeight ??= naturalHeight
    let available = bottomEdge - topEdge - 16
    let above = false
    if (rect !== undefined && !beside) {
      const belowSpace = window.innerHeight - rect.bottom - 16
      const aboveSpace = rect.top - 16
      above = tip.element?.dataset['tooltipPlace'] === 'above' || (readoutHeight ?? naturalHeight) > belowSpace && aboveSpace > belowSpace
      available = above ? aboveSpace : belowSpace
    }
    if (tip.fit !== undefined) {
      const lineHeight = Number.parseFloat(getComputedStyle(content).lineHeight)
      const chromeHeight = naturalHeight - content.getBoundingClientRect().height
      const title = content.querySelector<HTMLElement>('.app-tooltip-title')
      const margins = (title === null ? 0 : Number.parseFloat(getComputedStyle(title).marginBottom)) +
        Array.from(content.querySelectorAll<HTMLElement>('.app-tooltip-detail'))
          .reduce((sum, detail) => sum + Number.parseFloat(getComputedStyle(detail).marginTop), 0)
      const probe = document.createElement('div')
      probe.className = 'app-tooltip-measure'
      probe.style.width = `${content.getBoundingClientRect().width}px`
      content.append(probe)
      const next = tip.fit(Math.max(0, (available - chromeHeight - margins) / lineHeight), (text) => {
        if (title !== null && text === tip.title) return title.getBoundingClientRect().height / lineHeight
        probe.textContent = text
        return probe.getBoundingClientRect().height / lineHeight
      })
      probe.remove()
      const current = displayed().lines
      if (next.lines.length !== current.length || next.lines.some((line, index) => line !== current[index])) {
        setFitted(next)
        queueMicrotask(position)
        return
      }
    }
    if (naturalHeight > available) {
      const chromeHeight = naturalHeight - content.getBoundingClientRect().height
      const lineHeight = Number.parseFloat(getComputedStyle(content).lineHeight)
      let lines = Math.max(1, Math.floor((available - chromeHeight) / lineHeight))
      content.style.webkitLineClamp = String(lines)
      while (lines > 1 && element.getBoundingClientRect().height > available) {
        content.style.webkitLineClamp = String(--lines)
      }
    }
    const { width, height } = element.getBoundingClientRect()
    element.dataset['tooltipOverflow'] = String(height > available)
    let left = tip.x
    let top = tip.y
    if (rect !== undefined) {
      if (beside) {
        left = before ? rect.left - width - 8 : rect.right + 8
        top = rect.top + (rect.height - height) / 2
      } else {
        left = rect.left + (rect.width - width) / 2
        top = above ? rect.top - height - 8 : rect.bottom + 8
      }
    } else if (tip.above !== undefined && top + height > window.innerHeight - 8 && tip.above - height >= 8) {
      // A painted target's tooltip that does not fit below opens above it,
      // so it does not cover the row it reads.
      top = tip.above - height
    }
    element.style.left = `${Math.max(leftEdge + 8, Math.min(left, rightEdge - width - 8))}px`
    element.style.top = `${Math.max(topEdge + 8, Math.min(top, bottomEdge - height - 8))}px`
  }
  const resetFit = (): void => {
    readoutHeight = undefined
    setFitted(undefined)
    if (element.isConnected) {
      // A dialog may have entered the top layer since the previous target.
      element.hidePopover()
      element.showPopover()
    }
    queueMicrotask(position)
  }
  createEffect(on(() => props.tip, resetFit))
  const observer = new ResizeObserver(position)
  // The anchor moves when a neighbour changes size (the project button widening when the
  // project's name loads), which resizes the anchor's container but not the anchor.
  createEffect(() => {
    const container = props.tip.element?.parentElement
    if (container === null || container === undefined) return
    observer.observe(container)
    onCleanup(() => observer.unobserve(container))
  })
  onMount(() => {
    element.showPopover()
    observer.observe(element)
    window.addEventListener('resize', resetFit)
    window.addEventListener('scroll', position, true)
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener('resize', resetFit)
      window.removeEventListener('scroll', position, true)
    })
  })
  return (
    <aside ref={element} popover="manual" class="app-tooltip" aria-label={props.label} data-testid="app-tooltip">
      <div ref={content} role="tooltip">
        <Show when={displayed().title}><div class="app-tooltip-title">
          {displayed().title}<Show when={displayed().shortcut}>{(keys) => <>{' '}<ProductShortcut keys={keys()} /></>}</Show>
        </div></Show>
        <For each={displayed().lines}>{(line, index) => <div>
          {line}<Show when={index() === 0 && !displayed().title && displayed().shortcut}>{(keys) => <>{' '}<ProductShortcut keys={keys()} /></>}</Show>
          <Show when={displayed().lineDetails?.[index()]}>{(detail) => <div class="app-tooltip-note">{detail()}</div>}</Show>
        </div>}</For>
        <Show when={displayed().note}>{(note) => <div class="app-tooltip-note">{note()}</div>}</Show>
        <Show when={props.tip.detailed}><For each={displayed().detail}>{(line) => <div class="app-tooltip-detail">{line}</div>}</For></Show>
      </div>
    </aside>
  )
}

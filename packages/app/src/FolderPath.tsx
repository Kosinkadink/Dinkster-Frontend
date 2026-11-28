import { createEffect, createSignal, onCleanup, onMount } from 'solid-js'

export function FolderPath(props: { readonly value: string }) {
  const [visible, setVisible] = createSignal(props.value)
  let path!: HTMLElement
  const measure = () => {
    const available = path.clientWidth
    if (!available) { setVisible(props.value); return }
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return
    context.font = getComputedStyle(path).font
    const width = (value: string) => context.measureText(value).width
    if (width(props.value) <= available) { setVisible(props.value); return }
    const separator = Math.max(props.value.lastIndexOf('/'), props.value.lastIndexOf('\\'))
    const characters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(props.value)]
    const segments = characters.map((part) => part.segment)
    const split = separator < 0 ? Math.ceil(segments.length / 2)
      : characters.findIndex((part) => part.index === separator)
    const fitting = (parts: readonly string[], budget: number, tail: boolean) => {
      let low = 0
      let high = parts.length
      const text = (count: number) => (tail ? parts.slice(parts.length - count) : parts.slice(0, count)).join('')
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (width(text(middle)) <= budget) low = middle
        else high = middle - 1
      }
      return text(low)
    }
    const dots = width('...')
    if (available < dots) { setVisible(''); return }
    const suffix = fitting(segments.slice(split), Math.min(available * 0.75, available - dots), true)
    const prefix = fitting(segments.slice(0, split), available - dots - width(suffix), false)
    setVisible(`${prefix}...${suffix}`)
  }
  onMount(() => {
    const observer = new ResizeObserver(measure)
    observer.observe(path)
    void document.fonts?.ready.then(measure)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => { props.value; queueMicrotask(measure) })
  return <code ref={path} class="storage-folder-path" title={props.value} dir="ltr">{visible()}</code>
}

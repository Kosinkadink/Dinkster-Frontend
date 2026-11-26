import { For } from 'solid-js'

/** Display names only; shortcut registration and matching belong to the caller. */
export function productShortcutKeys(
  keys: string | readonly string[],
): readonly string[] {
  return (typeof keys === 'string' ? keys.split('+') : keys)
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => {
      if (key.toLowerCase() === 'meta' || key.toLowerCase() === 'cmd')
        return 'Cmd'
      return key.length === 1
        ? key.toUpperCase()
        : key[0]!.toUpperCase() + key.slice(1)
    })
}

export function ProductShortcut(props: { keys: string | readonly string[] }) {
  return (
    <span
      class="dinkster-shortcut"
      aria-label={productShortcutKeys(props.keys).join('+')}
    >
      <For each={productShortcutKeys(props.keys)}>
        {(key) => <kbd class="dinkster-key">{key}</kbd>}
      </For>
    </span>
  )
}

/** Backticks delimit key combinations without guessing localized word boundaries. */
export function ProductShortcutText(props: { text: string }) {
  const parts = () => props.text.split(/`([^`]+)`/gu)
  return (
    <For each={parts()}>
      {(part, index) =>
        index() % 2 === 1 ? <ProductShortcut keys={part} /> : part
      }
    </For>
  )
}

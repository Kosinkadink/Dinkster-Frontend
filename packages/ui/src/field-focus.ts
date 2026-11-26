import { onCleanup, onMount } from 'solid-js'

let users = 0

const pointer = () => {
  document.documentElement.dataset['fieldFocus'] = 'pointer'
}
const keyboard = (event: KeyboardEvent) => {
  const target = event.target
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (
    event.key === 'Tab' ||
    !(
      target instanceof Element &&
      target.matches('input, textarea, [contenteditable]')
    )
  )
    delete document.documentElement.dataset['fieldFocus']
}

// Text inputs match :focus-visible even when clicked. Keep their pointer
// focus quiet without changing the browser's focus rules for other controls.
export function useFieldFocus(): void {
  onMount(() => {
    if (users++ === 0) {
      document.addEventListener('pointerdown', pointer, true)
      document.addEventListener('keydown', keyboard, true)
    }
    onCleanup(() => {
      if (--users !== 0) return
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('keydown', keyboard, true)
      delete document.documentElement.dataset['fieldFocus']
    })
  })
}

import { createEffect, createSignal, onCleanup } from 'solid-js'

/** Keep settled content during rereads, and never flash a brief loading sign. */
export function createArrival<T>(resource: { readonly latest: T | undefined; readonly loading: boolean }) {
  const [value, setValue] = createSignal<T>()
  const [loading, setLoading] = createSignal(false)
  let hasValue = false
  let loadingAt: number | undefined
  createEffect(() => {
    const latest = resource.latest
    const pending = resource.loading
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!pending && latest !== undefined) {
      const reveal = () => {
        hasValue = true
        setValue(() => latest)
        setLoading(false)
      }
      const remaining = loadingAt === undefined ? 0 : Math.max(0, 300 - (Date.now() - loadingAt))
      if (remaining) timer = setTimeout(reveal, remaining)
      else reveal()
    } else if (pending && !hasValue) {
      timer = setTimeout(() => {
        loadingAt = Date.now()
        setLoading(true)
      }, 200)
    }
    onCleanup(() => clearTimeout(timer))
  })
  return { value, loading }
}

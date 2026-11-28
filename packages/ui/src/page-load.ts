import { batch, createSignal, onCleanup } from 'solid-js'

export const LOADING_DELAY_MS = 200

/** The read resolves only after all facts deciding the page have arrived. */
export function createPageLoad<T>() {
  const [result, setResult] = createSignal<{ value: T }>()
  const [error, setError] = createSignal<Error>()
  const [pending, setPending] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  let generation = 0
  let shownAt: number | undefined
  let cancel = () => {}
  onCleanup(() => {
    generation++
    cancel()
  })

  const load = async (read: () => Promise<T>): Promise<void> => {
    const current = ++generation
    cancel()
    let revealTimer: ReturnType<typeof setTimeout> | undefined
    let finishWait = () => {}
    const loadingTimer = setTimeout(() => {
      if (!result()) {
        shownAt ??= performance.now()
        setLoading(true)
      }
    }, LOADING_DELAY_MS)
    cancel = () => {
      clearTimeout(loadingTimer)
      clearTimeout(revealTimer)
      finishWait()
    }
    batch(() => {
      setPending(true)
      setError(undefined)
    })
    let next: { value: T } | undefined
    let failure: Error | undefined
    try {
      next = { value: await read() }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    if (current !== generation) return
    clearTimeout(loadingTimer)
    if (shownAt !== undefined) {
      const remaining = 300 - (performance.now() - shownAt)
      if (remaining > 0)
        await new Promise<void>((resolve) => {
          finishWait = resolve
          revealTimer = setTimeout(resolve, remaining)
        })
    }
    if (current !== generation) return
    shownAt = undefined
    batch(() => {
      if (next) setResult(next)
      setError(failure)
      setLoading(false)
      setPending(false)
    })
  }
  return { value: () => result()?.value, error, pending, loading, load }
}

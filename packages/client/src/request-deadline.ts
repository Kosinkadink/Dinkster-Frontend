/** Bound metadata reads even when a transport ignores cancellation. */
export async function requestWithDeadline<T>(read: (signal: AbortSignal) => Promise<T>,
  timeoutMessage = 'Backend request timed out after 30 seconds. Retry to reconnect.', signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => void) | undefined
  try {
    signal?.throwIfAborted()
    return await Promise.race([
      read(controller.signal),
      new Promise<never>((_, reject) => {
        cancel = () => { reject(signal!.reason); controller.abort(signal!.reason) }
        signal?.addEventListener('abort', cancel, { once: true })
        if (signal?.aborted) cancel()
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(timeoutMessage))
          controller.abort()
        }, 30_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (cancel) signal?.removeEventListener('abort', cancel)
  }
}

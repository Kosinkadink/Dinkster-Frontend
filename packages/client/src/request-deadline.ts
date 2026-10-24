/** Bound metadata reads even when a transport ignores cancellation. */
export async function requestWithDeadline<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Backend request timed out after 30 seconds. Retry to reconnect.'))
          controller.abort()
        }, 30_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

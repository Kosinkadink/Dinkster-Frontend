let pendingWrite = Promise.resolve()
let pendingText: string | undefined

// System clipboard writes can remain pending under host load. Keep the latest
// internal copy immediately pasteable without allowing older queued writes to
// clear it when they settle.
export function writeClipboardText(
  writeText: (text: string) => Promise<void>,
  text: string,
): Promise<void> {
  pendingText = text
  const write = (): Promise<void> => writeText(text)
  pendingWrite = pendingWrite
    .then(write, write)
    .catch(() => {})
  const pending = pendingWrite
  void pending.then(() => {
    if (pendingWrite === pending) pendingText = undefined
  })
  return pending
}

export function pendingClipboardText(): string | undefined {
  return pendingText
}

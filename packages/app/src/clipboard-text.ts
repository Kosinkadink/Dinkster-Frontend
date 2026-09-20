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
  pendingWrite = pendingWrite
    .then(() => writeText(text), () => writeText(text))
    .catch(() => {})
  const write = pendingWrite
  void write.then(() => {
    if (pendingWrite === write) pendingText = undefined
  })
  return write
}

export function pendingClipboardText(): string | undefined {
  return pendingText
}

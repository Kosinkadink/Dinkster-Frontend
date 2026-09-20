let pendingWrite = Promise.resolve()

export function writeClipboardText(
  writeText: (text: string) => Promise<void>,
  text: string,
): Promise<void> {
  pendingWrite = pendingWrite
    .then(() => writeText(text), () => writeText(text))
    .catch(() => {})
  return pendingWrite
}

export async function waitForClipboardTextWrite(): Promise<void> {
  await pendingWrite
}

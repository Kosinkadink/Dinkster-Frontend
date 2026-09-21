import { isAbsolute } from 'node:path'

export function isTrustedDesktopIpc(
  expectedSender: object | undefined,
  expectedMainFrame: object | undefined,
  expectedOrigin: string | undefined,
  sender: object,
  frame: { readonly url: string } | null,
): boolean {
  if (!expectedSender || !expectedMainFrame || !expectedOrigin || sender !== expectedSender || frame !== expectedMainFrame) return false
  try { return new URL(frame.url).origin === expectedOrigin } catch { return false }
}

export function isSafeRevealPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && isAbsolute(value)
}

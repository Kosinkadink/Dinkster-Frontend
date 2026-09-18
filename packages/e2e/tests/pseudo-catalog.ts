export type TestMessageCatalog = Readonly<Record<string, string>>

export function pseudoMessage(message: string): string {
  const padding = '~'.repeat(Math.max(4, Math.ceil([...message].length * 0.3)))
  return `[!! ${message} ${padding} !!]`
}

export function pseudoCatalog(catalog: TestMessageCatalog): Record<string, string> {
  return Object.fromEntries(
    Object.entries(catalog).map(([key, message]) => [key, pseudoMessage(message)]),
  )
}

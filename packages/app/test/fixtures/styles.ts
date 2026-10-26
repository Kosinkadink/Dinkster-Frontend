import { readFileSync } from 'node:fs'

const entry = new URL('../../src/styles.css', import.meta.url)
export const shellStyles = readFileSync(entry, 'utf8').replace(
  /@import '([^']+)';/g,
  (_match, path: string) => readFileSync(new URL(path, entry), 'utf8'),
)

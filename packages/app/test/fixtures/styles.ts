import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = resolve(process.cwd(), 'src')
export const shellStyles = readFileSync(resolve(source, 'styles.css'), 'utf8').replace(
  /@import '([^']+)';/g,
  (_match, path: string) => readFileSync(resolve(source, path), 'utf8'),
)

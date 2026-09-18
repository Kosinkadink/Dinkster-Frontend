import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}

const sourceRoot = resolve(option('--source', 'packages/app/src'))
const allowlistPath = resolve(option('--allowlist', 'scripts/ui-string-allowlist.json'))
const write = args.includes('--write')

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.tsx')) files.push(path)
  }
  return files
}

function normalized(value) {
  return value.replace(/\s+/gu, ' ').trim()
}

function literals(source) {
  const found = []
  const attributes = /\b(title|aria-label|placeholder|label|alt|data-tooltip-label|data-tooltip-detail)\s*=\s*(["'])(.*?)\2/gsu
  for (const match of source.matchAll(attributes)) {
    const value = normalized(match[3] ?? '')
    if (/[A-Za-z]/u.test(value)) found.push(`attribute:${match[1]}:${value}`)
  }
  const textNodes = />([^<>{}]+)</gsu
  for (const match of source.matchAll(textNodes)) {
    const value = normalized(match[1] ?? '')
    if (/[A-Za-z]/u.test(value)) found.push(`text:${value}`)
  }
  return found.sort()
}

const snapshot = {}
for (const file of (await sourceFiles(sourceRoot)).sort()) {
  const found = literals(await readFile(file, 'utf8'))
  if (found.length > 0) snapshot[relative(sourceRoot, file).replaceAll('\\', '/')] = found
}

if (write) {
  await mkdir(dirname(allowlistPath), { recursive: true })
  await writeFile(allowlistPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  process.exit(0)
}

let allowlist
try {
  allowlist = JSON.parse(await readFile(allowlistPath, 'utf8'))
} catch (error) {
  console.error(`Cannot read UI string allowlist: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

if (JSON.stringify(snapshot) !== JSON.stringify(allowlist)) {
  const paths = [...new Set([...Object.keys(snapshot), ...Object.keys(allowlist)])].sort()
  console.error('Hardcoded UI strings differ from scripts/ui-string-allowlist.json:')
  for (const path of paths) {
    const current = snapshot[path] ?? []
    const allowed = allowlist[path] ?? []
    if (JSON.stringify(current) !== JSON.stringify(allowed)) console.error(`  ${path}`)
  }
  console.error('Migrate changed literals to catalog keys or refresh the intentional baseline with pnpm check:ui-strings:write.')
  process.exit(1)
}

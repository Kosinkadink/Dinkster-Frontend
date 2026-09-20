import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}

const repositoryRoot = resolve(option('--source', '.'))
const allowlistPath = resolve(
  option('--allowlist', 'scripts/extension-literal-allowlist.json'),
)
const write = args.includes('--write')
const hasSource = args.includes('--source')
const defaultRoots = []
if (!hasSource) {
  for (const entry of await readdir(resolve(repositoryRoot, 'packages'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue
    const source = resolve(repositoryRoot, 'packages', entry.name, 'src')
    try {
      await access(source)
      defaultRoots.push(source)
    } catch {}
  }
}
const sourceRoots = hasSource ? [repositoryRoot] : defaultRoots
const nodeIdPattern = /^dinkster(?:\.[a-z0-9_-]+){2,}$/u
const nonNodeIds = new Map([
  ['packages/app/src/LibraryPanel.tsx', new Set(['dinkster.library.view.v1'])],
  [
    'packages/core/src/events/dinkster.ts',
    new Set([
      'dinkster.compositor.state',
      'dinkster.curve.histogram',
      'dinkster.glsl.state',
    ]),
  ],
])
const expectedKinds = ['nodeIdLiteral', 'widgetTypeComparison']
const equalityOperators = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
])

async function sourceFiles(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    const normalized = path.replaceAll('\\', '/')
    if (entry.isDirectory() && entry.name !== 'extensions')
      found.push(...(await sourceFiles(path)))
    else if (
      entry.isFile() &&
      /\.(?:ts|tsx)$/u.test(entry.name) &&
      !normalized.includes('/extensions/')
    )
      found.push(path)
  }
  return found
}

function literalValue(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined
}

function location(source, node) {
  const point = source.getLineAndCharacterOfPosition(node.getStart(source))
  return { line: point.line + 1, column: point.character + 1 }
}

function owningIssue(kind, path) {
  if (kind === 'widgetTypeComparison') return 122
  return path.endsWith('/core-commands.ts') ? 94 : 104
}

function scan(path, sourceText) {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  )
  const normalizedPath = relative(repositoryRoot, path).replaceAll('\\', '/')
  const sites = []
  const visit = (node) => {
    const value = literalValue(node)
    if (
      value !== undefined &&
      nodeIdPattern.test(value) &&
      !nonNodeIds.get(normalizedPath)?.has(value)
    ) {
      sites.push({
        kind: 'nodeIdLiteral',
        path: normalizedPath,
        ...location(source, node),
        symbol: value,
        issue: owningIssue('nodeIdLiteral', normalizedPath),
      })
    }
    if (
      ts.isBinaryExpression(node) &&
      equalityOperators.has(node.operatorToken.kind)
    ) {
      const left = literalValue(node.left)
      const right = literalValue(node.right)
      const value = left ?? right
      const expression = left === undefined ? node.left : node.right
      if (
        value !== undefined &&
        /\bwidgetType\b/u.test(expression.getText(source))
      ) {
        sites.push({
          kind: 'widgetTypeComparison',
          path: normalizedPath,
          ...location(source, node),
          symbol: `widgetType:${value}`,
          issue: owningIssue('widgetTypeComparison', normalizedPath),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
}

const sites = []
for (const root of sourceRoots) {
  for (const path of (await sourceFiles(root)).sort())
    sites.push(...scan(path, await readFile(path, 'utf8')))
}
sites.sort(
  (a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.path.localeCompare(b.path) ||
    a.line - b.line ||
    a.column - b.column ||
    a.symbol.localeCompare(b.symbol),
)
const counts = Object.fromEntries(
  expectedKinds.map((kind) => [
    kind,
    sites.filter((site) => site.kind === kind).length,
  ]),
)
const snapshot = { ceilings: counts, sites }

if (write) {
  await mkdir(dirname(allowlistPath), { recursive: true })
  await writeFile(allowlistPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  process.exit(0)
}

let allowlist
try {
  allowlist = JSON.parse(await readFile(allowlistPath, 'utf8'))
} catch (error) {
  console.error(
    `Cannot read extension literal allowlist: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
}

const ceilingKeys = Object.keys(allowlist.ceilings ?? {})
const ceilingProblems = expectedKinds.flatMap((kind) => {
  const ceiling = allowlist.ceilings?.[kind]
  const allowed = (allowlist.sites ?? []).filter(
    (site) => site.kind === kind,
  ).length
  const current = counts[kind]
  return Number.isInteger(ceiling) && ceiling === allowed && current <= ceiling
    ? []
    : [
        `${kind}: current=${current ?? 0}, allowlisted=${allowed}, ceiling=${String(ceiling)}`,
      ]
})
for (const kind of ceilingKeys) {
  if (!expectedKinds.includes(kind))
    ceilingProblems.push(`${kind}: unexpected ceiling`)
}
if (
  ceilingProblems.length > 0 ||
  JSON.stringify(sites) !== JSON.stringify(allowlist.sites)
) {
  console.error(
    'Extension literal sites differ from scripts/extension-literal-allowlist.json:',
  )
  for (const problem of ceilingProblems) console.error(`  ceiling ${problem}`)
  const current = new Set(sites.map((site) => JSON.stringify(site)))
  const allowed = new Set(
    (allowlist.sites ?? []).map((site) => JSON.stringify(site)),
  )
  for (const site of current)
    if (!allowed.has(site)) console.error(`  unlisted ${site}`)
  for (const site of allowed)
    if (!current.has(site)) console.error(`  stale ${site}`)
  console.error(
    'Replace a literal with an extension door, or refresh an intentional site with an owning issue while keeping the ceiling exact.',
  )
  process.exit(1)
}

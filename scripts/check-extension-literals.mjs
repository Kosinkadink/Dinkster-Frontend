import { execFileSync } from 'node:child_process'
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
const baselineRef = option(
  '--baseline-ref',
  process.env.DINKSTER_CEILING_BASE_REF,
)
const baselineAllowlistPath = option('--baseline-allowlist')
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
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
}

function attachOwningIssues(scanned, allowed) {
  const remaining = [...allowed]
  const resolved = new Array(scanned.length)
  const assign = (exact) => {
    for (const [index, site] of scanned.entries()) {
      if (resolved[index] !== undefined) continue
      const allowedIndex = remaining.findIndex((candidate) => {
        const sameSite =
          candidate.kind === site.kind &&
          candidate.path === site.path &&
          candidate.symbol === site.symbol
        const sameLocation =
          candidate.line === site.line && candidate.column === site.column
        return (
          sameSite &&
          (!exact || sameLocation) &&
          Number.isInteger(candidate.issue) &&
          candidate.issue > 0
        )
      })
      if (allowedIndex < 0) continue
      const [candidate] = remaining.splice(allowedIndex, 1)
      resolved[index] = { ...site, issue: candidate.issue }
    }
  }
  assign(true)
  assign(false)
  return {
    sites: resolved.filter((site) => site !== undefined),
    unowned: scanned.filter((_, index) => resolved[index] === undefined),
  }
}

const scannedSites = []
for (const root of sourceRoots) {
  for (const path of (await sourceFiles(root)).sort())
    scannedSites.push(...scan(path, await readFile(path, 'utf8')))
}
scannedSites.sort(
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
    scannedSites.filter((site) => site.kind === kind).length,
  ]),
)

let allowlist
try {
  allowlist = JSON.parse(await readFile(allowlistPath, 'utf8'))
} catch (error) {
  console.error(
    `Cannot read extension literal allowlist: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
}

let baselineCeilings
try {
  if (baselineRef && baselineAllowlistPath)
    throw new Error('choose either --baseline-ref or --baseline-allowlist')
  if (baselineAllowlistPath) {
    baselineCeilings = JSON.parse(
      await readFile(resolve(baselineAllowlistPath), 'utf8'),
    ).ceilings
  } else if (baselineRef) {
    const mergeBase = execFileSync('git', ['merge-base', 'HEAD', baselineRef], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim()
    if (!mergeBase)
      throw new Error(`cannot resolve merge base for ${baselineRef}`)
    baselineCeilings = JSON.parse(
      execFileSync(
        'git',
        ['show', `${mergeBase}:scripts/extension-literal-allowlist.json`],
        { cwd: repositoryRoot, encoding: 'utf8' },
      ),
    ).ceilings
  }
} catch (error) {
  console.error(
    `Cannot read extension literal baseline: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
}

const ceilingKeys = Object.keys(allowlist.ceilings ?? {})
const slackKeys = Object.keys(allowlist.slack ?? {})
const invalidKinds = [...ceilingKeys, ...slackKeys].filter(
  (kind) => !expectedKinds.includes(kind),
)
if (
  ceilingKeys.length !== expectedKinds.length ||
  slackKeys.length !== expectedKinds.length ||
  invalidKinds.length > 0
) {
  console.error('Extension literal ceiling and slack kinds differ')
  process.exit(1)
}
if (baselineCeilings) {
  const raised = expectedKinds.filter(
    (kind) => allowlist.ceilings[kind] > (baselineCeilings[kind] ?? -1),
  )
  if (raised.length > 0) {
    console.error(
      'Extension literal ceilings must not rise from the merge base:',
    )
    for (const kind of raised)
      console.error(
        `  ${kind}: baseline=${String(baselineCeilings[kind])}, proposed=${String(allowlist.ceilings[kind])}`,
      )
    process.exit(1)
  }
}

const { sites, unowned } = attachOwningIssues(
  scannedSites,
  allowlist.sites ?? [],
)
if (unowned.length > 0) {
  console.error('Extension literal sites require explicit owning issues:')
  for (const site of unowned)
    console.error(`  unlisted ${JSON.stringify(site)}`)
  console.error(
    'Add each site to the allowlist with a positive issue, then refresh with `node scripts/check-extension-literals.mjs --write`.',
  )
  process.exit(1)
}

if (write) {
  const raised = expectedKinds.filter((kind) => {
    const ceiling = allowlist.ceilings?.[kind]
    return !Number.isInteger(ceiling) || ceiling < 0 || counts[kind] > ceiling
  })
  if (
    invalidKinds.length > 0 ||
    ceilingKeys.length !== expectedKinds.length ||
    raised.length > 0
  ) {
    console.error(
      'Cannot refresh extension literal allowlist without raising ceilings:',
    )
    for (const kind of raised)
      console.error(
        `  ${kind}: current=${counts[kind]}, ceiling=${String(allowlist.ceilings?.[kind])}`,
      )
    for (const kind of invalidKinds)
      console.error(`  ${kind}: unexpected ceiling`)
    process.exit(1)
  }
  const ceilings = Object.fromEntries(
    expectedKinds.map((kind) => [
      kind,
      Math.min(allowlist.ceilings[kind], counts[kind]),
    ]),
  )
  const snapshot = { ceilings, slack: allowlist.slack, sites }
  await mkdir(dirname(allowlistPath), { recursive: true })
  await writeFile(allowlistPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  process.exit(0)
}

const ceilingProblems = expectedKinds.flatMap((kind) => {
  const ceiling = allowlist.ceilings?.[kind]
  const slack = allowlist.slack?.[kind]
  const allowed = (allowlist.sites ?? []).filter(
    (site) => site.kind === kind,
  ).length
  const current = counts[kind]
  return Number.isInteger(ceiling) &&
    Number.isInteger(slack) &&
    slack >= 0 &&
    current <= ceiling &&
    ceiling - current <= slack
    ? []
    : [
        `${kind}: current=${current ?? 0}, allowlisted=${allowed}, ceiling=${String(ceiling)}, slack=${String(slack)}`,
      ]
})
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

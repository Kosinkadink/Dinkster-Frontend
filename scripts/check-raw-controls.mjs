import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const root = resolve(option('--source', '.'))
const allowlistPath = resolve(
  option('--allowlist', 'scripts/raw-control-allowlist.json'),
)
const write = args.includes('--write')
const controls = new Set(['button', 'input', 'select', 'textarea'])
const primitiveFiles = new Set([
  'packages/app/src/ProductControls.tsx',
  'packages/app/src/ProductNumberInput.tsx',
  'packages/app/src/ProductSelect.tsx',
])

async function files(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await files(path)))
    else if (
      entry.isFile() &&
      (/\.(?:ts|tsx)$/u.test(entry.name) || entry.name === 'styles.css')
    )
      found.push(path)
  }
  return found
}

function countTs(path, sourceText) {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  let rawControl = 0
  let inlineStyle = 0
  const visit = (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      controls.has(node.tagName.getText(source))
    ) {
      rawControl += 1
    }
    if (ts.isJsxAttribute(node) && node.name.text === 'style') inlineStyle += 1
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { rawControl, inlineStyle }
}

function countCss(sourceText) {
  const declarations =
    sourceText.match(
      /(?:^|[;{])\s*(?:background(?:-color)?|color|border(?:-(?:top|right|bottom|left))?(?:-color)?|border-radius)\s*:\s*[^;}]+/gmu,
    ) ?? []
  return declarations.filter((declaration) =>
    /(?:#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(|border-radius\s*:\s*\d)/iu.test(
      declaration,
    ),
  ).length
}

const counts = []
const sourceRoot = args.includes('--source')
  ? root
  : resolve(root, 'packages/app/src')
for (const path of (await files(sourceRoot)).sort()) {
  const relativePath = relative(root, path).replaceAll('\\', '/')
  const sourceText = await readFile(path, 'utf8')
  if (path.endsWith('.css')) {
    const count = countCss(sourceText)
    if (count > 0)
      counts.push({ kind: 'cssLiteral', path: relativePath, count })
    continue
  }
  const result = countTs(path, sourceText)
  if (result.rawControl > 0 && !primitiveFiles.has(relativePath)) {
    counts.push({
      kind: 'rawControl',
      path: relativePath,
      count: result.rawControl,
    })
  }
  if (result.inlineStyle > 0)
    counts.push({
      kind: 'inlineStyle',
      path: relativePath,
      count: result.inlineStyle,
    })
}

let allowlist
try {
  allowlist = JSON.parse(await readFile(allowlistPath, 'utf8'))
} catch (error) {
  if (!write) {
    console.error(
      `Cannot read raw-control allowlist: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
  allowlist = { issue: 382, entries: [], ceilings: {} }
}

const kinds = ['rawControl', 'inlineStyle', 'cssLiteral']
const byKey = new Map(
  counts.map((entry) => [`${entry.kind}:${entry.path}`, entry]),
)
const listedByKey = new Map(
  (allowlist.entries ?? []).map((entry) => [
    `${entry.kind}:${entry.path}`,
    entry,
  ]),
)
const growth = counts.filter(
  (entry) =>
    entry.count > (listedByKey.get(`${entry.kind}:${entry.path}`)?.count ?? 0),
)
const stale = (allowlist.entries ?? []).filter(
  (entry) => !byKey.has(`${entry.kind}:${entry.path}`),
)
const totals = Object.fromEntries(
  kinds.map((kind) => [
    kind,
    counts
      .filter((entry) => entry.kind === kind)
      .reduce((sum, entry) => sum + entry.count, 0),
  ]),
)
const ceilingProblems = kinds.filter(
  (kind) =>
    !Number.isInteger(allowlist.ceilings?.[kind]) ||
    totals[kind] > allowlist.ceilings[kind],
)
const initializing =
  write &&
  (allowlist.entries ?? []).length === 0 &&
  Object.keys(allowlist.ceilings ?? {}).length === 0

if (!initializing && (growth.length > 0 || ceilingProblems.length > 0)) {
  console.error(
    'Raw controls and styling literals exceed the checked-in ratchet:',
  )
  for (const entry of growth)
    console.error(
      `  ${entry.kind} ${entry.path}: current=${entry.count}, allowed=${listedByKey.get(`${entry.kind}:${entry.path}`)?.count ?? 0}`,
    )
  for (const kind of ceilingProblems)
    console.error(
      `  ${kind}: current=${totals[kind]}, ceiling=${String(allowlist.ceilings?.[kind])}`,
    )
  process.exit(1)
}

if (write) {
  const entries = counts.map((entry) => ({
    ...entry,
    issue: allowlist.issue ?? 382,
  }))
  const ceilings = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      initializing
        ? totals[kind]
        : Math.min(allowlist.ceilings[kind], totals[kind]),
    ]),
  )
  await mkdir(dirname(allowlistPath), { recursive: true })
  await writeFile(
    allowlistPath,
    `${JSON.stringify({ issue: allowlist.issue ?? 382, ceilings, entries }, null, 2)}\n`,
  )
  process.exit(0)
}

if (
  stale.length > 0 ||
  JSON.stringify(counts) !==
    JSON.stringify(
      (allowlist.entries ?? []).map(({ issue: _issue, ...entry }) => entry),
    )
) {
  console.error(
    'Raw-control allowlist is stale; reduce it with `pnpm check:raw-controls:write`.',
  )
  process.exit(1)
}

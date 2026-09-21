import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import ts from 'typescript'

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const NATIVE_ROOTS = ['packages/core/src', 'packages/app/src']
const REQUIRED_V1_MODULES = [
  'packages/client/src/connection.ts',
  'packages/client/src/reconcile.ts',
  'packages/core/src/events/comfy-v1.ts',
  'packages/core/src/schema/compat.ts',
  'packages/core/src/schema/object-info.ts',
]
const V1_MODULES = new Set([
  'packages/app/src/v1-connection-kind.ts',
  'packages/client/src/comfy-v1.ts',
  'packages/core/src/comfy-v1.ts',
  ...REQUIRED_V1_MODULES,
])
const V1_ENTRY = 'packages/app/src/v1-connection-kind.ts'
const V1_ENTRY_OWNER = 'packages/app/src/app-state.ts'

const slash = (path) => path.split(sep).join('/')
const repoPath = (root, path) => slash(relative(root, path))
const inside = (parent, path) => {
  const child = relative(parent, path)
  return (
    child === '' ||
    (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
  )
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${slash(path)} is not valid JSON: ${error.message}`)
  }
}

const workspacePatterns = (root) => {
  const path = join(root, 'pnpm-workspace.yaml')
  if (!existsSync(path)) throw new Error('pnpm-workspace.yaml is missing')
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const patterns = []
  let inPackages = false
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim()) continue
    if (!inPackages && /^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    const match = inPackages ? /^\s+-\s+([^\s]+)\s*$/.exec(line) : undefined
    if (!match)
      throw new Error(
        `unsupported pnpm-workspace.yaml syntax on line ${index + 1}`,
      )
    const pattern = match[1].replace(/^['"]|['"]$/g, '')
    if (
      pattern.includes('!') ||
      !pattern.endsWith('/*') ||
      pattern.slice(0, -2).includes('*')
    ) {
      throw new Error(`unsupported workspace pattern: ${pattern}`)
    }
    patterns.push(pattern)
  }
  if (!inPackages || patterns.length === 0)
    throw new Error('pnpm-workspace.yaml has no package patterns')
  return patterns
}

const workspacePackages = (root) => {
  const byName = new Map()
  const byDirectory = new Map()
  for (const pattern of workspacePatterns(root)) {
    const parent = resolve(root, pattern.slice(0, -2))
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new Error(`workspace pattern has no directory: ${pattern}`)
    }
    const matches = readdirSync(parent, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory(),
    )
    if (matches.length === 0)
      throw new Error(`workspace pattern matches no packages: ${pattern}`)
    for (const entry of matches) {
      const directory = join(parent, entry.name)
      const manifestPath = join(directory, 'package.json')
      if (!existsSync(manifestPath))
        throw new Error(`${repoPath(root, directory)} has no package.json`)
      const manifest = readJson(manifestPath)
      if (typeof manifest.name !== 'string' || !manifest.name) {
        throw new Error(`${repoPath(root, manifestPath)} has no package name`)
      }
      if (byName.has(manifest.name))
        throw new Error(`duplicate workspace package name: ${manifest.name}`)
      const info = { directory, manifest, manifestPath }
      byName.set(manifest.name, info)
      byDirectory.set(directory, info)
    }
  }
  for (const { manifest, manifestPath } of byName.values()) {
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const dependencies = manifest[section]
      if (dependencies === undefined) continue
      if (
        dependencies === null ||
        typeof dependencies !== 'object' ||
        Array.isArray(dependencies)
      ) {
        throw new Error(
          `${repoPath(root, manifestPath)} has an invalid ${section} object`,
        )
      }
      for (const [name, version] of Object.entries(dependencies)) {
        if (typeof version !== 'string')
          throw new Error(
            `${manifest.name} has a non-string version for ${name}`,
          )
        if (version.startsWith('workspace:') && !byName.has(name)) {
          throw new Error(
            `${manifest.name} declares missing workspace package ${name}`,
          )
        }
      }
    }
  }
  return { byName, byDirectory }
}

const packageForFile = (packages, path) => {
  let directory = dirname(path)
  for (;;) {
    const found = packages.byDirectory.get(directory)
    if (found) return found
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

const exportedTarget = (root, info, subpath) => {
  const exports = info.manifest.exports
  if (exports === undefined)
    throw new Error(`${info.manifest.name} has no exports for ${subpath}`)
  const target =
    typeof exports === 'string' && subpath === '.'
      ? exports
      : exports?.[subpath]
  if (typeof target !== 'string') {
    throw new Error(
      `${info.manifest.name} export ${subpath} must be one file path`,
    )
  }
  const path = resolveFile(root, info.directory, target)
  if (!inside(info.directory, path))
    throw new Error(
      `${info.manifest.name} export ${subpath} leaves its package`,
    )
  return path
}

const resolveFile = (root, fromDirectory, specifier) => {
  const raw = resolve(fromDirectory, specifier)
  const extension = extname(raw)
  const candidates = [raw]
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    candidates.push(
      ...SOURCE_EXTENSIONS.map(
        (candidate) => raw.slice(0, -extension.length) + candidate,
      ),
    )
  } else if (!extension) {
    candidates.push(...SOURCE_EXTENSIONS.map((candidate) => raw + candidate))
    candidates.push(
      ...SOURCE_EXTENSIONS.map((candidate) => join(raw, `index${candidate}`)),
    )
  }
  const found = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  )
  if (!found)
    throw new Error(
      `unresolved local import ${specifier} from ${repoPath(root, fromDirectory)}`,
    )
  if (!inside(root, found))
    throw new Error(`local import leaves the repository: ${specifier}`)
  return found
}

const importsOf = (root, path) => {
  const text = readFileSync(path, 'utf8')
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  )
  if (source.parseDiagnostics.length > 0) {
    const diagnostic = source.parseDiagnostics[0]
    throw new Error(
      `syntax error in ${repoPath(root, path)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    )
  }
  const imports = []
  const add = (node) => {
    if (!ts.isStringLiteralLike(node)) {
      throw new Error(`non-literal dynamic import in ${repoPath(root, path)}`)
    }
    imports.push(node.text)
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      add(node.moduleReference.expression)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      if (node.arguments.length !== 1)
        throw new Error(`invalid dynamic import in ${repoPath(root, path)}`)
      if (
        !ts.isStringLiteralLike(node.arguments[0]) &&
        !node.getText(source).includes('/* @vite-ignore */')
      ) {
        throw new Error(`non-literal dynamic import in ${repoPath(root, path)}`)
      }
      if (ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return imports
}

const workspaceSpecifier = (packages, specifier) => {
  for (const [name, info] of packages.byName) {
    if (specifier === name) return { info, subpath: '.' }
    if (specifier.startsWith(`${name}/`))
      return { info, subpath: `./${specifier.slice(name.length + 1)}` }
  }
  if (specifier.startsWith('@dinkster/'))
    throw new Error(`unknown workspace package import: ${specifier}`)
  return undefined
}

const resolveImport = (root, packages, importer, specifier) => {
  if (specifier.startsWith('.'))
    return resolveFile(root, dirname(importer), specifier)
  const workspace = workspaceSpecifier(packages, specifier)
  if (!workspace) return undefined
  const owner = packageForFile(packages, importer)
  if (!owner)
    throw new Error(
      `workspace import outside a package: ${repoPath(root, importer)}`,
    )
  const names = new Set([
    ...Object.keys(owner.manifest.dependencies ?? {}),
    ...Object.keys(owner.manifest.devDependencies ?? {}),
    ...Object.keys(owner.manifest.peerDependencies ?? {}),
    ...Object.keys(owner.manifest.optionalDependencies ?? {}),
  ])
  if (owner !== workspace.info && !names.has(workspace.info.manifest.name)) {
    throw new Error(
      `${owner.manifest.name} imports undeclared workspace package ${workspace.info.manifest.name}`,
    )
  }
  return exportedTarget(root, workspace.info, workspace.subpath)
}

const sourceFiles = (directory) => {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (SOURCE_EXTENSIONS.includes(extname(entry.name))) files.push(path)
  }
  return files
}

export const checkV1Boundary = (rootPath) => {
  const root = resolve(rootPath)
  const packages = workspacePackages(root)
  for (const required of REQUIRED_V1_MODULES) {
    if (!existsSync(join(root, required)))
      throw new Error(`V1 boundary module is missing: ${required}`)
  }
  const violations = new Set()
  const visited = new Set()
  const walk = (path) => {
    const current = repoPath(root, path)
    if (visited.has(current)) return
    visited.add(current)
    for (const specifier of importsOf(root, path)) {
      const target = resolveImport(root, packages, path, specifier)
      if (!target || !SOURCE_EXTENSIONS.includes(extname(target))) continue
      const destination = repoPath(root, target)
      if (destination === V1_ENTRY && current === V1_ENTRY_OWNER) continue
      if (V1_MODULES.has(destination)) {
        violations.add(`${current} -> ${destination}`)
        continue
      }
      walk(target)
    }
  }
  for (const directory of NATIVE_ROOTS) {
    const absolute = join(root, directory)
    if (!existsSync(absolute))
      throw new Error(`native source root is missing: ${directory}`)
    for (const path of sourceFiles(absolute)) {
      if (!V1_MODULES.has(repoPath(root, path))) walk(path)
    }
  }
  if (violations.size > 0) {
    throw new Error(
      `native source reaches V1 modules:\n${[...violations].sort().join('\n')}`,
    )
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  try {
    checkV1Boundary(process.cwd())
    console.log('V1 dependency boundary passed')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

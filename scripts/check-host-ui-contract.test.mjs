import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const forbidden = [
  ['app', 'Mount'].join(''),
  ['Extension', 'App', 'Mount'].join(''),
  ['mount', 'Extension', 'Element'].join(''),
  ['create', 'Editor'].join(''),
  ['create', 'Viewer'].join(''),
  ['Extension', 'Shell', 'Slot'].join(''),
  ['register', 'App', 'Mount'].join(''),
  ['extension', 'Mounts'].join(''),
  ['Extension', 'Mount', 'Host'].join(''),
  ['Editor', 'Handle'].join(''),
  ['Edit', 'Session'].join(''),
  ['plain DOM', ' mount/unmount'].join(''),
  ['contract-bound to vanilla DOM', '/web components'].join(''),
  ['Host-owned element', ', selectors'].join(''),
  ['plain DOM', ' mount contract'].join(''),
  ['named app', ' mounts'].join(''),
  ['app ', 'mount'].join(''),
  ['disposable mounted', ' view'].join(''),
  ['host-owned mount', ' containers'].join(''),
  ['framework-neutral mount', ' lifecycle'].join(''),
  ['view owns only its container', ' contents'].join(''),
  ['container contents and returned', '\n  disposer'].join(''),
  ['returned editor', ' disposer'].join(''),
]

const binaryAssetExtensions = new Set(['.ico', '.mp4', '.png', '.webm'])
const fileReadBatchSize = 32

function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.name === 'dist' ||
      entry.name === 'node_modules' ||
      entry.name === 'release'
    )
      return []
    const child = join(path, entry.name)
    return entry.isDirectory()
      ? files(child)
      : entry.isFile() &&
          !binaryAssetExtensions.has(extname(entry.name).toLowerCase())
        ? [child]
        : []
  })
}

test('host UI source, tests and docs contain no removed extension symbols', async () => {
  const root = join(import.meta.dirname, '..')
  const matches = ['packages', 'docs'].flatMap((directory) =>
    files(join(root, directory)),
  )
  const retiredSymbols = []
  for (let start = 0; start < matches.length; start += fileReadBatchSize) {
    const batch = matches.slice(start, start + fileReadBatchSize)
    const contents = await Promise.all(
      batch.map(async (path) => [path, await readFile(path, 'utf8')]),
    )
    retiredSymbols.push(
      ...contents.flatMap(([path, content]) =>
        forbidden
          .filter((symbol) => content.includes(symbol))
          .map((symbol) => `${path}:${symbol}`),
      ),
    )
  }
  assert.deepEqual(retiredSymbols, [])
})

test('extension widget environment exposes exactly one readonly scoped client', () => {
  const root = join(import.meta.dirname, '..')
  const path = join(root, 'packages/core/src/widgets/contract.ts')
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const widgetEnvs = source.statements.filter(
    (statement) =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === 'WidgetEnv',
  )
  assert.equal(widgetEnvs.length, 1)
  assert.equal(
    widgetEnvs[0].modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ),
    true,
  )
  assert.equal(widgetEnvs[0].heritageClauses, undefined)
  const members = [...widgetEnvs[0].members]
  assert.equal(members.length, 1)
  const member = members[0]
  assert.equal(ts.isPropertySignature(member), true)
  assert.equal(member.name.getText(source), 'client')
  assert.equal(member.questionToken, undefined)
  assert.equal(
    member.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
    ),
    true,
  )
  assert.equal(
    member.type !== undefined && ts.isTypeReferenceNode(member.type),
    true,
  )
  assert.equal(member.type?.getText(source), 'ScopedClient')
})

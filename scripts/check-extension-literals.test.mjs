import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)
const script = resolve('scripts/check-extension-literals.mjs')
const kinds = ['nodeIdLiteral', 'widgetTypeComparison']

async function writeAllowlist(path, sites) {
  const ceilings = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      sites.filter((site) => site.kind === kind).length,
    ]),
  )
  const slack = Object.fromEntries(kinds.map((kind) => [kind, 0]))
  await writeFile(
    path,
    `${JSON.stringify({ ceilings, slack, sites }, null, 2)}\n`,
  )
}

test('extension literal guard rejects site and ceiling drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dinkster-extension-literals-'))
  const source = join(root, 'src')
  const allowlist = join(root, 'allowlist.json')
  const file = join(source, 'Example.ts')
  try {
    await mkdir(source)
    await writeFile(
      file,
      "export const node = 'dinkster.demo.deep.node'\nexport const matches = (widgetType: string) => widgetType === 'STRING'\n",
    )
    await writeAllowlist(allowlist, [
      {
        kind: 'nodeIdLiteral',
        path: 'Example.ts',
        line: 1,
        column: 21,
        symbol: 'dinkster.demo.deep.node',
        issue: 104,
      },
      {
        kind: 'widgetTypeComparison',
        path: 'Example.ts',
        line: 2,
        column: 48,
        symbol: 'widgetType:STRING',
        issue: 122,
      },
    ])
    await exec(process.execPath, [
      script,
      '--source',
      source,
      '--allowlist',
      allowlist,
      '--write',
    ])
    await exec(process.execPath, [
      script,
      '--source',
      source,
      '--allowlist',
      allowlist,
    ])

    await writeFile(
      file,
      "export const node = 'dinkster.demo.deep.node'\nexport const other = 'dinkster.demo.other'\nexport const matches = (widgetType: string) => widgetType === 'STRING'\n",
    )
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
      ]),
      (error) => String(error.stderr).includes('unlisted'),
    )

    await writeFile(file, "export const node = 'dinkster.demo.deep.node'\n")
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
      ]),
      (error) => String(error.stderr).includes('stale'),
    )

    const raised = JSON.parse(await readFile(allowlist, 'utf8'))
    raised.ceilings.nodeIdLiteral += 1
    await writeFile(allowlist, `${JSON.stringify(raised, null, 2)}\n`)
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
      ]),
      (error) => String(error.stderr).includes('ceiling'),
    )

    const missing = JSON.parse(await readFile(allowlist, 'utf8'))
    missing.ceilings.nodeIdLiteral -= 1
    delete missing.ceilings.widgetTypeComparison
    await writeFile(allowlist, `${JSON.stringify(missing, null, 2)}\n`)
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
      ]),
      (error) =>
        String(error.stderr).includes('ceiling and slack kinds differ'),
    )

    const unexpected = JSON.parse(await readFile(allowlist, 'utf8'))
    unexpected.ceilings.widgetTypeComparison = 1
    unexpected.ceilings.other = 0
    await writeFile(allowlist, `${JSON.stringify(unexpected, null, 2)}\n`)
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
      ]),
      (error) =>
        String(error.stderr).includes('ceiling and slack kinds differ'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('extension literal write refuses to raise a ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dinkster-extension-ceiling-'))
  const source = join(root, 'src')
  const allowlist = join(root, 'allowlist.json')
  const file = join(source, 'Example.ts')
  try {
    await mkdir(source)
    await writeFile(file, "export const node = 'dinkster.demo.deep.node'\n")
    await writeAllowlist(allowlist, [
      {
        kind: 'nodeIdLiteral',
        path: 'Example.ts',
        line: 1,
        column: 21,
        symbol: 'dinkster.demo.deep.node',
        issue: 104,
      },
    ])
    await exec(process.execPath, [
      script,
      '--source',
      source,
      '--allowlist',
      allowlist,
      '--write',
    ])
    const recorded = await readFile(allowlist, 'utf8')

    await writeFile(
      file,
      "export const node = 'dinkster.demo.deep.node'\nexport const other = 'dinkster.demo.other'\n",
    )
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
      ]),
      (error) => String(error.stderr).includes('explicit owning issues'),
    )
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
        '--write',
      ]),
      (error) =>
        String(error.stderr).includes('positive issue') &&
        String(error.stderr).includes('dinkster.demo.other'),
    )
    assert.equal(await readFile(allowlist, 'utf8'), recorded)

    const explicit = JSON.parse(recorded)
    explicit.sites.push({
      kind: 'nodeIdLiteral',
      path: 'Example.ts',
      line: 2,
      column: 22,
      symbol: 'dinkster.demo.other',
      issue: 104,
    })
    await writeFile(allowlist, `${JSON.stringify(explicit, null, 2)}\n`)
    const explicitRecorded = await readFile(allowlist, 'utf8')
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
        '--write',
      ]),
      (error) =>
        String(error.stderr).includes('nodeIdLiteral: current=2, ceiling=1'),
    )
    assert.equal(await readFile(allowlist, 'utf8'), explicitRecorded)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('extension literal ceilings ratchet against the baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dinkster-extension-ratchet-'))
  const source = join(root, 'src')
  const allowlist = join(root, 'allowlist.json')
  const baseline = join(root, 'baseline.json')
  const file = join(source, 'Example.ts')
  try {
    await mkdir(source)
    await writeFile(file, "export const node = 'dinkster.demo.deep.node'\n")
    const first = {
      kind: 'nodeIdLiteral',
      path: 'Example.ts',
      line: 1,
      column: 21,
      symbol: 'dinkster.demo.deep.node',
      issue: 104,
    }
    await writeAllowlist(allowlist, [first])
    await writeFile(baseline, await readFile(allowlist))

    const second = {
      kind: 'nodeIdLiteral',
      path: 'Example.ts',
      line: 2,
      column: 22,
      symbol: 'dinkster.demo.other',
      issue: 305,
    }
    await writeFile(
      file,
      "export const node = 'dinkster.demo.deep.node'\nexport const other = 'dinkster.demo.other'\n",
    )
    await writeAllowlist(allowlist, [first, second])
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
        '--baseline-allowlist',
        baseline,
      ]),
      (error) => String(error.stderr).includes('baseline=1, proposed=2'),
    )

    await writeFile(file, '')
    const stale = JSON.parse(await readFile(baseline, 'utf8'))
    stale.sites = []
    await writeFile(allowlist, JSON.stringify(stale))
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
      ]),
      (error) =>
        String(error.stderr).includes(
          'nodeIdLiteral: current=0, allowlisted=0, ceiling=1, slack=0',
        ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('default scan includes every package source root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dinkster-extension-roots-'))
  const app = join(root, 'packages', 'app', 'src')
  const canvas = join(root, 'packages', 'canvas', 'src')
  const allowlist = join(root, 'allowlist.json')
  const canvasFile = join(canvas, 'scene.ts')
  try {
    await mkdir(app, { recursive: true })
    await mkdir(canvas, { recursive: true })
    await writeFile(join(app, 'app.ts'), 'export const app = true\n')
    await writeFile(
      canvasFile,
      "export const matches = (widgetType: string) => widgetType === 'STRING'\n",
    )
    await writeAllowlist(allowlist, [
      {
        kind: 'widgetTypeComparison',
        path: 'packages/canvas/src/scene.ts',
        line: 1,
        column: 48,
        symbol: 'widgetType:STRING',
        issue: 122,
      },
    ])
    await exec(
      process.execPath,
      [script, '--allowlist', allowlist, '--write'],
      { cwd: root },
    )

    await writeFile(
      canvasFile,
      "export const matches = (widgetType: string) => widgetType === 'STRING' || widgetType === 'COMBO'\n",
    )
    await assert.rejects(
      exec(process.execPath, [script, '--allowlist', allowlist], { cwd: root }),
      (error) => String(error.stderr).includes('unlisted'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

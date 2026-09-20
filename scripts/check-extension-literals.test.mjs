import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)
const script = resolve('scripts/check-extension-literals.mjs')

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
      (error) => String(error.stderr).includes('widgetTypeComparison'),
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
      (error) => String(error.stderr).includes('unexpected ceiling'),
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
    await exec(process.execPath, [
      script,
      '--allowlist',
      allowlist,
      '--write',
    ], { cwd: root })

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

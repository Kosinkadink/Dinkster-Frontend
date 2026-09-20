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

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)
const script = resolve('scripts/check-raw-controls.mjs')

test('design tokens resolve from the shared projection or local declarations in every stylesheet', async () => {
  const source = await mkdtemp(join(tmpdir(), 'dinkster-tokens-'))
  const allowlist = join(source, 'allowlist.json')
  const css = join(source, 'panel.css')
  const args = [script, '--source', source, '--allowlist', allowlist]
  try {
    await writeFile(
      css,
      ':root { --dinkster-local: var(--dinkster-text-primary); }\n.panel { color: var(--dinkster-local); }\n',
    )
    await exec(process.execPath, [...args, '--write'])
    await exec(process.execPath, args)
    await writeFile(css, '.panel { color: var(--dinkster-unknown); }\n')
    await assert.rejects(exec(process.execPath, args), (error) =>
      String(error.stderr).includes('panel.css: --dinkster-unknown'),
    )
    await writeFile(css, ':root { --dinkster-local: red; }\n')
    await writeFile(
      join(source, 'Example.tsx'),
      'export const Example = () => <div title="var(--dinkster-unknown)" />\n',
    )
    await assert.rejects(exec(process.execPath, args), (error) =>
      String(error.stderr).includes('Example.tsx: --dinkster-unknown'),
    )
  } finally {
    await rm(source, { recursive: true, force: true })
  }
})

test('raw-control ratchet rejects new controls and styling literals but accepts reductions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dinkster-raw-controls-'))
  const source = join(root, 'src')
  const allowlist = join(root, 'allowlist.json')
  const component = join(source, 'Example.tsx')
  const css = join(source, 'styles.css')
  try {
    await mkdir(source)
    await writeFile(
      component,
      "export const Example = () => <button style={{ color: 'red' }}>Go</button>\n",
    )
    await writeFile(css, '.example { color: #fff; border-radius: 6px; }\n')
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
    const baseline = await readFile(allowlist, 'utf8')

    await writeFile(
      component,
      "export const Example = () => <><button style={{ color: 'red' }}>Go</button><input /></>\n",
    )
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
      ]),
      (error) => String(error.stderr).includes('rawControl'),
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
      (error) => String(error.stderr).includes('rawControl'),
    )
    assert.equal(await readFile(allowlist, 'utf8'), baseline)

    await writeFile(
      component,
      "export const Example = () => <><button style={{ color: 'red' }}>Go</button><span style={{ color: 'blue' }} /></>\n",
    )
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
      ]),
      (error) => String(error.stderr).includes('inlineStyle'),
    )

    await writeFile(
      component,
      'export const Example = () => <button>Go</button>\n',
    )
    await writeFile(
      css,
      '.example { color: #fff; border-radius: 6px; background: rgb(0 0 0); }\n',
    )
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--source',
        source,
        '--allowlist',
        allowlist,
      ]),
      (error) => String(error.stderr).includes('cssLiteral'),
    )

    await writeFile(css, '.example { color: #fff; }\n')
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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

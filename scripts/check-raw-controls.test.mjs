import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)
const script = resolve('scripts/check-raw-controls.mjs')

test('raw-control ratchet rejects stale controls and unused ceiling headroom', async () => {
  const source = await mkdtemp(join(tmpdir(), 'dinkster-raw-controls-'))
  const allowlist = join(source, 'allowlist.json')
  const component = join(source, 'Example.tsx')
  const args = [script, '--source', source, '--allowlist', allowlist]
  try {
    await writeFile(
      component,
      'export const Example = () => <button>Go</button>\n',
    )
    await writeFile(join(source, 'styles.css'), '.example { color: #fff; }\n')
    await exec(process.execPath, [...args, '--write'])
    const baseline = JSON.parse(await readFile(allowlist, 'utf8'))
    for (const kind of ['rawControl', 'cssLiteral']) {
      await writeFile(
        allowlist,
        JSON.stringify({
          ...baseline,
          ceilings: {
            ...baseline.ceilings,
            [kind]: baseline.ceilings[kind] + 1,
          },
        }),
      )
      await assert.rejects(exec(process.execPath, args), (error) =>
        String(error.stderr).includes(`${kind}: current=1, ceiling=2`),
      )
      await exec(process.execPath, [...args, '--write'])
      await exec(process.execPath, args)
      assert.equal(
        JSON.parse(await readFile(allowlist, 'utf8')).ceilings[kind],
        1,
      )
    }

    await writeFile(component, 'export const Example = () => <div>Done</div>\n')
    await writeFile(
      allowlist,
      JSON.stringify({
        ...baseline,
        ceilings: { ...baseline.ceilings, rawControl: 0 },
      }),
    )
    await assert.rejects(exec(process.execPath, args), (error) =>
      String(error.stderr).includes('allowlist is stale'),
    )
    await exec(process.execPath, [...args, '--write'])
    await exec(process.execPath, args)
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

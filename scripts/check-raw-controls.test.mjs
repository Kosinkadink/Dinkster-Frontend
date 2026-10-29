import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkRawControls } from './check-raw-controls.mjs'

test('raw-control ratchet rejects stale controls and unused ceiling headroom', async () => {
  const source = await mkdtemp(join(tmpdir(), 'dinkster-raw-controls-'))
  const allowlist = join(source, 'allowlist.json')
  const component = join(source, 'Example.tsx')
  const args = ['--source', source, '--allowlist', allowlist]
  try {
    await writeFile(
      component,
      'export const Example = () => <button>Go</button>\n',
    )
    await writeFile(join(source, 'styles.css'), '.example { color: #fff; }\n')
    await checkRawControls([...args, '--write'])
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
      await assert.rejects(checkRawControls(args), (error) =>
        error.message.includes(`${kind}: current=1, ceiling=2`),
      )
      await checkRawControls([...args, '--write'])
      await checkRawControls(args)
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
    await assert.rejects(checkRawControls(args), (error) =>
      error.message.includes('allowlist is stale'),
    )
    await checkRawControls([...args, '--write'])
    await checkRawControls(args)
  } finally {
    await rm(source, { recursive: true, force: true })
  }
})

test('design tokens resolve from the shared projection or local declarations in every stylesheet', async () => {
  const source = await mkdtemp(join(tmpdir(), 'dinkster-tokens-'))
  const allowlist = join(source, 'allowlist.json')
  const css = join(source, 'panel.css')
  const args = ['--source', source, '--allowlist', allowlist]
  try {
    await writeFile(
      css,
      ':root { --dinkster-local: var(--dinkster-text-primary); }\n.panel { color: var(--dinkster-local); }\n',
    )
    await checkRawControls([...args, '--write'])
    await checkRawControls(args)
    await writeFile(css, '.panel { color: var(--dinkster-unknown); }\n')
    await assert.rejects(checkRawControls(args), (error) =>
      error.message.includes('panel.css: --dinkster-unknown'),
    )
    await writeFile(css, ':root { --dinkster-local: red; }\n')
    await writeFile(
      join(source, 'Example.tsx'),
      'export const Example = () => <div title="var(--dinkster-unknown)" />\n',
    )
    await assert.rejects(checkRawControls(args), (error) =>
      error.message.includes('Example.tsx: --dinkster-unknown'),
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
  const args = ['--source', source, '--allowlist', allowlist]
  try {
    await mkdir(source)
    await writeFile(
      component,
      "export const Example = () => <button style={{ color: 'red' }}>Go</button>\n",
    )
    await writeFile(css, '.example { color: #fff; border-radius: 6px; }\n')
    await checkRawControls([...args, '--write'])
    await checkRawControls(args)
    const baseline = await readFile(allowlist, 'utf8')

    await writeFile(
      component,
      "export const Example = () => <><button style={{ color: 'red' }}>Go</button><input /></>\n",
    )
    await assert.rejects(checkRawControls(args), (error) =>
      error.message.includes('rawControl'),
    )
    await assert.rejects(checkRawControls([...args, '--write']), (error) =>
      error.message.includes('rawControl'),
    )
    assert.equal(await readFile(allowlist, 'utf8'), baseline)

    await writeFile(
      component,
      "export const Example = () => <><button style={{ color: 'red' }}>Go</button><span style={{ color: 'blue' }} /></>\n",
    )
    await assert.rejects(checkRawControls(args), (error) =>
      error.message.includes('inlineStyle'),
    )

    await writeFile(
      component,
      'export const Example = () => <button>Go</button>\n',
    )
    await writeFile(
      css,
      '.example { color: #fff; border-radius: 6px; background: rgb(0 0 0); }\n',
    )
    await assert.rejects(checkRawControls(args), (error) =>
      error.message.includes('cssLiteral'),
    )

    await writeFile(css, '.example { color: #fff; }\n')
    await checkRawControls([...args, '--write'])
    await checkRawControls(args)
    await mkdir(join(source, 'styles'))
    const extracted = join(source, 'styles', 'panel.css')
    await writeFile(css, "@import './styles/panel.css';\n")
    await writeFile(extracted, '.example { color: #fff; }\n')
    await checkRawControls(args)
    await writeFile(extracted, '.example { color: #fff; background: #000; }\n')
    await assert.rejects(checkRawControls(args), (error) =>
      error.message.includes('cssLiteral'),
    )
    await assert.rejects(checkRawControls([...args, '--write']), (error) =>
      error.message.includes('cssLiteral'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const checker = fileURLToPath(
  new URL('./check-ui-strings.mjs', import.meta.url),
)

test('UI string check distinguishes JSX text and labels from TypeScript', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dinkster-ui-strings-'))
  const source = join(directory, 'screen.tsx')
  const allowlist = join(directory, 'allowlist.json')
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [checker, '--source', directory, '--allowlist', allowlist, ...args],
      { encoding: 'utf8' },
    )
  try {
    await writeFile(allowlist, '{}')
    await writeFile(
      source,
      `
      const focused = (): boolean => props.host?.focused() ?? true
      const value = useSignal(app.changed)
      const [state, setState] = createSignal<Result>()
      // <button title="Not a label">Not text</button>
      const example = '<span>Not JSX</span>'
      const view = <section>{message('title')}</section>
    `,
    )
    const accepted = run()
    assert.equal(accepted.status, 0, accepted.stderr)
    await writeFile(
      source,
      `const view = <section title="Details">Before {count()} after <span>Nested</span></section>`,
    )
    const rejected = run()
    assert.equal(rejected.status, 1)
    for (const literal of [
      'attribute:title:Details',
      'text:Before',
      'text:after',
      'text:Nested',
    ])
      assert.ok(rejected.stderr.includes(literal), literal)
    assert.equal(run('--write').status, 0)
    assert.equal(run().status, 0)
    await writeFile(
      source,
      `const view = <section title="Details">Before {count()} after <span>Nested</span><span>Nested</span></section>`,
    )
    const duplicate = run()
    assert.equal(duplicate.status, 1)
    assert.match(duplicate.stderr, /text:Nested/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

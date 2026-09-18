import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)
const script = resolve('scripts/check-ui-strings.mjs')

test('UI string guard rejects literals added to new and allowlisted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dinkster-ui-strings-'))
  const source = join(root, 'src')
  const allowlist = join(root, 'allowlist.json')
  const component = join(source, 'Panel.tsx')
  try {
    await writeFile(allowlist, '{}\n')
    await mkdir(source)
    await writeFile(component, 'export const Panel = () => <button aria-label="Open">Open panel</button>\n')

    await assert.rejects(
      exec(process.execPath, [script, '--source', source, '--allowlist', allowlist]),
      (error) => String(error.stderr).includes('Panel.tsx'),
    )

    await exec(process.execPath, [script, '--source', source, '--allowlist', allowlist, '--write'])
    assert.match(await readFile(allowlist, 'utf8'), /Open panel/u)
    await exec(process.execPath, [script, '--source', source, '--allowlist', allowlist])

    await writeFile(component, 'export const Panel = () => <><button aria-label="Open">Open panel</button><p>New text</p></>\n')
    await assert.rejects(exec(process.execPath, [script, '--source', source, '--allowlist', allowlist]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

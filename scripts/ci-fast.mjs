import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const dinksterSource = process.env.DINKSTER_SOURCE_ROOT ?? '../Dinkster'
const ceilingBaseRef = `origin/${process.env.GITHUB_BASE_REF || 'main'}`
execFileSync(
  process.env.PYTHON ?? 'python3',
  [
    join(dinksterSource, 'tools/gen_extension_contribution_kinds.py'),
    '--check',
    '--frontend-root',
    '.',
  ],
  { stdio: 'inherit' },
)

for (const args of [
  [
    'exec',
    'prettier',
    '--check',
    '--single-quote',
    '--no-semi',
    'scripts/ci-fast.mjs',
  ],
  ['check:extension-literals'],
  ['check:raw-controls'],
  ['check:ui-strings'],
  ['typecheck'],
]) {
  const env = { ...process.env }
  if (args[0] === 'check:extension-literals')
    env.DINKSTER_CEILING_BASE_REF = ceilingBaseRef
  else delete env.DINKSTER_CEILING_BASE_REF
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    env,
    stdio: 'inherit',
  })
}

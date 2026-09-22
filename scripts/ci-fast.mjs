import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const dinksterSource = process.env.DINKSTER_SOURCE_ROOT ?? '../Dinkster'
const ceilingBaseRef = `origin/${process.env.GITHUB_BASE_REF ?? 'main'}`
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
execFileSync(
  process.env.PYTHON ?? 'python3',
  [
    join(dinksterSource, 'scripts/check_family_isinstance_gates.py'),
    '--root',
    dinksterSource,
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
    'packages/e2e/test/ci-workflow.test.ts',
  ],
  ['check:extension-literals'],
  ['check:ui-strings'],
  ['check:v1-boundary'],
  ['typecheck'],
  [
    '--filter',
    '@dinkster/core',
    'exec',
    'vitest',
    'run',
    'test/format.schema.test.ts',
    'test/dinkster-graph.test.ts',
    'test/dinkster-inline-value.test.ts',
    'test/object-info.golden.test.ts',
    'test/events.golden.test.ts',
  ],
  [
    '--filter',
    '@dinkster/e2e',
    'exec',
    'vitest',
    'run',
    'test/ci-workflow.test.ts',
  ],
  [
    '--filter',
    '@dinkster/app',
    'exec',
    'vitest',
    'run',
    'test/extension-dogfooding.test.ts',
    'test/extension-world.test.ts',
  ],
  [
    'exec',
    'node',
    '--test',
    'scripts/check-extension-literals.test.mjs',
    'scripts/check-ui-strings.test.mjs',
    'scripts/check-path-case.test.mjs',
    'scripts/check-v1-boundary.test.mjs',
  ],
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

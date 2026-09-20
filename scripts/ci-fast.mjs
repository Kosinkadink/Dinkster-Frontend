import { execFileSync } from 'node:child_process'

for (const args of [
  [
    'exec',
    'prettier',
    '--check',
    '--single-quote',
    '--no-semi',
    'scripts/ci-fast.mjs',
    'packages/desktop/test/ci-workflow.test.ts',
  ],
  ['check:ui-strings'],
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
  ],
  [
    '--filter',
    '@dinkster/desktop',
    'exec',
    'vitest',
    'run',
    'test/ci-workflow.test.ts',
    'test/published-verification.test.ts',
  ],
  [
    'exec',
    'node',
    '--test',
    'scripts/check-ui-strings.test.mjs',
    'scripts/check-path-case.test.mjs',
  ],
]) {
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    stdio: 'inherit',
  })
}

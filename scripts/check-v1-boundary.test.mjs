import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkV1Boundary } from './check-v1-boundary.mjs'

const write = (root, path, content) => {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'v1-boundary-'))
  write(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n')
  write(
    root,
    'packages/core/package.json',
    JSON.stringify({
      name: '@dinkster/core',
      exports: { '.': './src/index.ts', './comfy-v1': './src/comfy-v1.ts' },
    }),
  )
  write(
    root,
    'packages/client/package.json',
    JSON.stringify({
      name: '@dinkster/client',
      exports: { '.': './src/index.ts', './comfy-v1': './src/comfy-v1.ts' },
      dependencies: { '@dinkster/core': 'workspace:*' },
    }),
  )
  write(
    root,
    'packages/app/package.json',
    JSON.stringify({
      name: '@dinkster/app',
      dependencies: {
        '@dinkster/client': 'workspace:*',
        '@dinkster/core': 'workspace:*',
      },
    }),
  )
  write(root, 'packages/core/src/index.ts', 'export const native = true\n')
  write(
    root,
    'packages/core/src/comfy-v1.ts',
    "export * from './events/comfy-v1.js'\nexport * from './schema/object-info.js'\n",
  )
  write(
    root,
    'packages/core/src/events/comfy-v1.ts',
    'export class ComfyV1Normalizer {}\n',
  )
  write(
    root,
    'packages/core/src/schema/object-info.ts',
    'export const parseObjectInfo = () => ({})\n',
  )
  write(
    root,
    'packages/core/src/schema/compat.ts',
    'export const compatible = true\n',
  )
  write(
    root,
    'packages/client/src/index.ts',
    'export const nativeClient = true\n',
  )
  write(
    root,
    'packages/client/src/comfy-v1.ts',
    "export * from './connection.js'\nexport * from './reconcile.js'\n",
  )
  write(
    root,
    'packages/client/src/connection.ts',
    "import '@dinkster/core/comfy-v1'\nexport class BackendConnection {}\n",
  )
  write(
    root,
    'packages/client/src/reconcile.ts',
    "import './connection.js'\nexport const reconcileExecutions = () => {}\n",
  )
  write(root, 'packages/app/src/main.tsx', "import './app-state.js'\n")
  write(
    root,
    'packages/app/src/app-state.ts',
    "import './v1-connection-kind.js'\nimport '@dinkster/client'\n",
  )
  write(
    root,
    'packages/app/src/v1-connection-kind.ts',
    "export * from '@dinkster/client/comfy-v1'\n",
  )
  return root
}

const withFixture = (run) => {
  const root = fixture()
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('accepts one explicit V1 connection-kind entry', () =>
  withFixture((root) => {
    assert.doesNotThrow(() => checkV1Boundary(root))
  }))

test('rejects direct and transitive native imports of V1 code', () =>
  withFixture((root) => {
    write(root, 'packages/core/src/index.ts', "export * from './comfy-v1.js'\n")
    assert.throws(
      () => checkV1Boundary(root),
      /packages\/core\/src\/index\.ts -> packages\/core\/src\/comfy-v1\.ts/,
    )
  }))

test('fails closed on unresolved local imports', () =>
  withFixture((root) => {
    write(root, 'packages/app/src/main.tsx', "import './missing.js'\n")
    assert.throws(() => checkV1Boundary(root), /unresolved local import/)
  }))

test('fails closed on non-literal dynamic imports', () =>
  withFixture((root) => {
    write(
      root,
      'packages/app/src/main.tsx',
      "const path = './app-state.js'\nvoid import(path)\n",
    )
    assert.throws(() => checkV1Boundary(root), /non-literal dynamic import/)
  }))

test('allows explicit Vite external runtime imports', () =>
  withFixture((root) => {
    write(
      root,
      'packages/app/src/main.tsx',
      "const path = 'https://example.invalid/module.js'\nvoid import(/* @vite-ignore */ path)\n",
    )
    assert.doesNotThrow(() => checkV1Boundary(root))
  }))

test('fails closed on source syntax errors', () =>
  withFixture((root) => {
    write(root, 'packages/app/src/main.tsx', 'const =\n')
    assert.throws(() => checkV1Boundary(root), /syntax error/)
  }))

test('fails closed on malformed workspace manifests', () =>
  withFixture((root) => {
    write(root, 'packages/app/package.json', '{')
    assert.throws(() => checkV1Boundary(root), /is not valid JSON/)
  }))

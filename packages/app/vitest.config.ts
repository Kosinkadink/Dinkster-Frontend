import { configDefaults, defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

// Standalone vitest config: do NOT inherit vite.config.ts and its dev proxy.
// Solid's SSR transform lets focused component contract tests (plain
// .test.tsx, renderToString) run in Node alongside the .test.ts unit suite.
// Browser-mode component tests use the .dom.test.tsx suffix and run under
// vitest.component.config.ts (happy-dom, client solid-js builds).
export default defineConfig({
  plugins: [solid({ ssr: true })],
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, 'test/**/*.dom.test.tsx'],
  },
})

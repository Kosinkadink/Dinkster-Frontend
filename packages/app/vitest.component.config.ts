import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

const solidBrowser = new URL('./node_modules/solid-js/dist/dev.js', import.meta.url).pathname
const solidWebBrowser = new URL('./node_modules/solid-js/web/dist/dev.js', import.meta.url).pathname

export default defineConfig({
  plugins: [solid({ hot: false, ssr: false })],
  resolve: {
    alias: [
      { find: /^solid-js$/, replacement: solidBrowser },
      { find: /^solid-js\/web$/, replacement: solidWebBrowser },
    ],
    conditions: ['development', 'browser'],
  },
  server: { deps: { inline: [/^solid-js/] } },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.dom.test.tsx'],
    setupFiles: ['./vitest.storage.setup.ts'],
  },
})

import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import { semanticCssRoot } from '../core/src/ui/tokens.js'

// Native requests never fall through to the SPA when the engine is absent.
const NATIVE = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:3639'
const nativeHttp = { target: NATIVE, changeOrigin: true }

export default defineConfig({
  plugins: [
    {
      name: 'dinkster-semantic-tokens',
      transformIndexHtml: {
        order: 'pre',
        handler: () => [{
          tag: 'style',
          attrs: { 'data-dinkster-semantic-tokens': '' },
          children: semanticCssRoot,
          injectTo: 'head-prepend',
        }],
      },
    },
    solid(),
  ],
  server: {
    port: 5199,
    fs: {
      // Allow importing golden workflow fixtures from @dinkster/core.
      allow: ['..'],
    },
    proxy: {
      // Native engine: whole surfaces, never SPA fallthrough.
      '/api/events': { ...nativeHttp, ws: true },
      // Collab session delivery (GET /api/sessions/{id}/events) upgrades to
      // a WebSocket; without ws here the upgrade dies at the dev server.
      '/api/sessions': { ...nativeHttp, ws: true },
      '/api': nativeHttp,
      '/memory': nativeHttp,
      '/cache': nativeHttp,
      '/supervisor': nativeHttp,
    },
  },
})

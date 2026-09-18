import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import { semanticCssRoot } from '../core/src/ui/tokens.js'

// Dev proxy: the app runs same-origin (no CORS flags) against up to two
// backends.
//
// Native Dinkster engine (or supervisor): /api/* and /supervisor/* forward to
// DINKSTER_NATIVE_BACKEND, default http://127.0.0.1:3639 - the Dinkster engine's
// default port (3649 is the station port; 8188/8199 are ComfyUI/
// comfy-runner territory, deliberately avoided). Because these prefixes
// are ALWAYS proxied, an /api/* request can never fall through to the SPA
// and answer text/html: with no engine running it is a loud 502, with one
// it is the engine's own answer. Same-origin discovery (main.tsx) then
// finds the native engine and the default backend "just works".
//
// Legacy ComfyUI bridge: the v1 endpoints forward to DINKSTER_V1_BACKEND
// (default http://127.0.0.1:8199; DINKSTER_BACKEND kept as a legacy alias).
const NATIVE = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:3639'
const V1 =
  process.env['DINKSTER_V1_BACKEND'] ?? process.env['DINKSTER_BACKEND'] ?? 'http://127.0.0.1:8199'

// ComfyUI's origin-check middleware 403s requests whose Origin header does
// not match its own host, so the proxy must rewrite Origin to the target.
const v1Http = { target: V1, changeOrigin: true, headers: { origin: V1 } }
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
      '/supervisor': nativeHttp,
      // Legacy ComfyUI (v1) endpoints.
      '/object_info': v1Http,
      '/prompt': v1Http,
      '/interrupt': v1Http,
      '/view': v1Http,
      '/history': v1Http,
      '/queue': v1Http,
      '/system_stats': v1Http,
      '/ws': { target: V1, ws: true, changeOrigin: true, headers: { origin: V1 } },
      // Second same-origin route to the SAME v1 backend. E2e registers
      // '/b2' as an additional backend (distinct connection id/base url)
      // without needing a second ComfyUI server.
      '/b2/ws': {
        target: V1,
        ws: true,
        changeOrigin: true,
        headers: { origin: V1 },
        rewrite: (p: string) => p.replace(/^\/b2/, ''),
      },
      '/b2': { ...v1Http, rewrite: (p: string) => p.replace(/^\/b2/, '') },
    },
  },
})

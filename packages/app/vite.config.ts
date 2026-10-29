import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import { semanticCssRoot } from '../core/src/ui/tokens.js'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extname } from 'node:path'

const brandRoot = new URL('../../branding/', import.meta.url)
const brandFiles = ['svg', 'raster/color', 'platform'].flatMap((directory) =>
  readdirSync(new URL(`${directory}/`, brandRoot)).map(
    (name) => `${directory}/${name}`,
  ),
)
const manifest = JSON.stringify({
  name: 'Dinkster',
  short_name: 'Dinkster',
  start_url: './',
  display: 'standalone',
  icons: [256, 512].map((size) => ({
    src: `./branding/raster/color/${size}.png`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose: 'any',
  })),
})

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
  process.env['DINKSTER_V1_BACKEND'] ??
  process.env['DINKSTER_BACKEND'] ??
  'http://127.0.0.1:8199'
const STUB_V1_ENTRY = process.env['DINKSTER_STUB_V1_ENTRY'] === '1'
const V1_STUB_ID = '\0dinkster-v1-connection-kind-stub'

// ComfyUI's origin-check middleware 403s requests whose Origin header does
// not match its own host, so the proxy must rewrite Origin to the target.
const v1Http = { target: V1, changeOrigin: true, headers: { origin: V1 } }
const nativeHttp = { target: NATIVE, changeOrigin: true }

export default defineConfig({
  plugins: [
    {
      name: 'dinkster-brand-assets',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = request.url?.split('?')[0]
          if (path === '/manifest.webmanifest') {
            response.setHeader('Content-Type', 'application/manifest+json')
            response.end(manifest)
            return
          }
          const relative = path?.startsWith('/branding/')
            ? path.slice('/branding/'.length)
            : ''
          if (!brandFiles.includes(relative)) return next()
          response.setHeader(
            'Content-Type',
            {
              '.svg': 'image/svg+xml',
              '.png': 'image/png',
              '.ico': 'image/x-icon',
              '.icns': 'application/octet-stream',
            }[extname(relative)] ?? 'application/octet-stream',
          )
          response.end(readFileSync(new URL(relative, brandRoot)))
        })
      },
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'manifest.webmanifest',
          source: manifest,
        })
        for (const path of brandFiles)
          this.emitFile({
            type: 'asset',
            fileName: `branding/${path}`,
            source: readFileSync(new URL(path, brandRoot)),
          })
      },
    },
    {
      name: 'dinkster-v1-connection-kind-stub',
      enforce: 'pre',
      resolveId(source, importer) {
        if (
          STUB_V1_ENTRY &&
          source === './v1-connection-kind.js' &&
          importer?.endsWith('/app-state.ts')
        )
          return V1_STUB_ID
        return null
      },
      load(id) {
        if (id !== V1_STUB_ID) return null
        return `
          globalThis.__dinksterV1EntryStubbed = true
          const unavailable = () => { throw new Error('stock ComfyUI V1 compatibility is unavailable') }
          export class BackendConnection { constructor() { unavailable() } }
          export const buildSchemaRegistry = unavailable
          export const reconcileExecutions = unavailable
          export const v1ViewUrl = unavailable
        `
      },
    },
    {
      name: 'dinkster-semantic-tokens',
      transformIndexHtml: {
        order: 'pre',
        handler: () => [
          {
            tag: 'style',
            attrs: { 'data-dinkster-semantic-tokens': '' },
            children: semanticCssRoot,
            injectTo: 'head-prepend',
          },
        ],
      },
    },
    solid(),
  ],
  server: {
    port: 5199,
    fs: {
      // Allow importing golden workflow fixtures from @dinkster/core.
      allow: ['..', fileURLToPath(brandRoot)],
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
      // Legacy ComfyUI (v1) endpoints.
      '/object_info': v1Http,
      '/prompt': v1Http,
      '/interrupt': v1Http,
      '/view': v1Http,
      '/history': v1Http,
      '/queue': v1Http,
      '/system_stats': v1Http,
      '/ws': {
        target: V1,
        ws: true,
        changeOrigin: true,
        headers: { origin: V1 },
      },
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

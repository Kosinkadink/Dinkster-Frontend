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

// Native requests never fall through to the SPA when the engine is absent.
const NATIVE = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:3639'
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
    },
  },
})

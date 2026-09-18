/**
 * Dev routing contract: backend path prefixes are ALWAYS proxied, so an
 * /api/* or /supervisor/* request can never fall through to the SPA and
 * answer 200 text/html (the signature of the historical :5199/api/*
 * fallthrough bug). With no engine running the answer is a loud proxy
 * error; with one it is the engine's own answer - either way it is a
 * backend-shaped response, never the app shell.
 */
import { test, expect } from './fixtures.js'

for (const path of ['/api/definitely-not-a-route', '/api/nodes', '/supervisor/status']) {
  test(`${path} never answers as the SPA`, async ({ request }) => {
    const res = await request.get(path)
    const contentType = res.headers()['content-type'] ?? ''
    expect(contentType).not.toContain('text/html')
  })
}

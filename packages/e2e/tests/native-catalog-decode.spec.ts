import { expect, test } from '@playwright/test'

// On a host that always runs a live backend (the preview stack), set
// DINKSTER_REQUIRE_BACKEND=1 so an unreachable backend FAILS this spec instead
// of skipping it. A skipped catalog gate is how decode regressions (nodes
// silently dropped from the catalog) reached the live UI unnoticed.
const REQUIRED = process.env['DINKSTER_REQUIRE_BACKEND'] === '1'

test('the full live catalog decodes without schema errors and dynamic families materialize', async ({ page }) => {
  // Probe same-origin through the dev-server proxy so the probe and the page
  // are guaranteed to hit the same backend (the proxy target is set by
  // DINKSTER_NATIVE_BACKEND in the app's vite config).
  let payloadCount: number | undefined
  try {
    const response = await page.request.get('/api/nodes', { timeout: 5_000 })
    if (response.ok()) {
      const payload = await response.json() as { nodes: Record<string, unknown> }
      payloadCount = Object.keys(payload.nodes).length
    }
  } catch { /* handled below */ }
  if (payloadCount === undefined && !REQUIRED) {
    test.skip(true, 'no native Dinkster backend reachable through the dev proxy (set DINKSTER_NATIVE_BACKEND)')
  }
  expect(payloadCount, 'native backend unreachable through the dev proxy').toBeDefined()

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    (window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size ?? 0) > 0,
  ), { timeout: 15_000 }).toBe(true)

  const registry = await page.evaluate(() => {
    const reg = window.__dinksterTest!.app.backends.get()[0]!.registry.get()!
    return {
      schemaCount: reg.schemas.size,
      schemaErrors: ((reg.diagnostics ?? []) as readonly { code: string; severity?: string }[])
        .filter((d) => d.severity === 'error'),
      hasListMake: reg.schemas.has('std.list.make'),
    }
  })
  // Every node the backend serves must decode: an undecodable schema drops
  // the node from the catalog entirely, which users see as a missing node.
  expect(registry.schemaErrors).toEqual([])
  await expect.poll(async () => {
    const response = await page.request.get('/api/nodes')
    const payload = await response.json() as { nodes: Record<string, unknown> }
    const registryTypes = await page.evaluate(() =>
      [...window.__dinksterTest!.app.backends.get()[0]!.registry.get()!.schemas.keys()])
    return Object.keys(payload.nodes).filter((type) => !registryTypes.includes(type))
  }).toEqual([])

  if (registry.hasListMake) {
    // Dynamic input families must materialize members: a family that
    // elaborates zero members renders a node with no input pins at all.
    await page.evaluate(() => {
      window.__dinksterTest!.app.openDocument({
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'native-catalog-decode', root: 'g0',
        graphs: { g0: {
          id: 'g0', name: 'root',
          nodes: { m1: { id: 'm1', type: 'std.list.make', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
        } },
        view: { graphs: { g0: { nodes: { m1: { position: { x: 120, y: 120 } } } } } },
      } as never, 'Catalog decode smoke')
    })
    await expect.poll(() => page.evaluate(() => {
      const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n: { id: string }) => n.id === 'm1')
      return node === undefined ? -1 : node.layout.pins.filter((p: { direction: string }) => p.direction === 'in').length
    }), { timeout: 10_000 }).toBeGreaterThan(0)
  }
})

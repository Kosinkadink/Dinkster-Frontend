import { expect, test } from '@playwright/test'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

test.beforeEach(async ({ page }) => {
  test.skip(process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_NATIVE_BACKEND to an isolated Dinkster backend')
  let nodes: Record<string, unknown> | undefined
  try {
    const response = await fetch(`${NATIVE_BACKEND}/api/nodes`, {
      signal: AbortSignal.timeout(2_000),
    })
    if (response.ok) nodes = (await response.json() as { nodes: Record<string, unknown> }).nodes
  } catch { /* handled by the skip below */ }
  test.skip(nodes === undefined, `no native Dinkster backend reachable at ${NATIVE_BACKEND}`)
  test.skip(!('comfy.EmptyImage' in nodes! && 'comfy.ResizeImageMaskNode' in nodes!),
    'native backend lacks EmptyImage or ResizeImageMaskNode')

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.has('comfy.ResizeImageMaskNode') ?? false,
  ), { timeout: 15_000 }).toBe(true)
})

test('ResizeImageMask DynamicCombo choice is accepted and completes on Dinkster', async ({ page, request }) => {
  const color = Date.now() % 16_777_216
  let submitted: {
    clientId: string
    jobId: string
    graph: { nodes: Record<string, unknown> }
  } | undefined
  page.on('request', (outgoing) => {
    if (outgoing.method() !== 'POST' || new URL(outgoing.url()).pathname !== '/api/jobs') return
    submitted = outgoing.postDataJSON() as typeof submitted
  })

  await page.evaluate((color) => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'dynamic-combo-native-live', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          source: {
            id: 'source', type: 'comfy.EmptyImage',
            values: { width: 64, height: 48, batch_size: 1, color },
          },
          resize: {
            id: 'resize', type: 'comfy.ResizeImageMaskNode',
            values: {
              scale_method: 'bicubic',
              'resize_type.width': 32,
              'resize_type.height': 24,
              'resize_type.crop': 'disabled',
            },
            dynamic: { resize_type: { selected: 'scale dimensions' } },
          },
        },
        links: {
          image: { id: 'image', from: { node: 'source', port: 'image' }, to: { node: 'resize', port: 'input' } },
        },
        nets: {}, reroutes: {}, nextOrdinal: 3,
      } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 80, y: 120 } },
        resize: { position: { x: 420, y: 120 } },
      } } } },
    } as never, 'DynamicCombo Native Acceptance')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, color)

  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, ['resize'])
  })
  await expect.poll(() => page.evaluate(() => {
    const executions = [...window.__dinksterTest!.app.store.executions.get().values()]
    return executions.sort((a, b) => b.queuedAt - a.queuedAt)[0]?.status
  }), { timeout: 30_000 }).toBe('completed')

  expect(submitted).toBeDefined()
  expect(submitted!.graph.nodes.resize).toEqual({
    nodeType: 'comfy.ResizeImageMaskNode',
    inputs: {
      input: { $link: { node: 'source', output: 'image' } },
      scale_method: 'bicubic',
      'resize_type.width': 32,
      'resize_type.height': 24,
      'resize_type.crop': 'disabled',
    },
    slotVariants: { resize_type: 'scale dimensions' },
  })

  const completed = await request.get(
    `${NATIVE_BACKEND}/api/jobs/${encodeURIComponent(submitted!.clientId)}/${encodeURIComponent(submitted!.jobId)}`,
  )
  expect(completed.ok()).toBe(true)
  const job = await completed.json() as Record<string, unknown>
  expect(job['state']).toBe('completed')
  expect(job['executed']).toEqual(expect.arrayContaining(['source', 'resize']))
  await test.info().attach('dynamic-combo-native-acceptance.json', {
    body: JSON.stringify({ submitted, job }, null, 2),
    contentType: 'application/json',
  })
})

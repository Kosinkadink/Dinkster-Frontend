import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { expect, nativeTest as test } from './fixtures.js'

test('reviews template models without opening or submitting a workflow and revokes on feature disable', async ({ page }) => {
  const plans: unknown[] = []
  const starts: string[] = []
  const cancellations: string[] = []
  let started = false
  let phase = 'downloading'
  let jobId = 'template-job'
  let modelsPresent = false
  let notifyMountsChanged = (): void => { throw new Error('Events socket not connected') }
  const selection = {
    name: 'missing.safetensors', kind: 'model/vae', project: 'default', provider: 'huggingface',
    source: 'https://huggingface.co/example/models/resolve/main/missing.safetensors', repo: 'example/models',
    revision: 'a'.repeat(40), file: 'missing.safetensors', sha256: 'b'.repeat(64), size: 1000,
    license: 'test', destination: '/models/missing.safetensors', mount: 'models',
  }
  const job = () => ({ ...selection, jobId, status: phase, received: phase === 'completed' ? 1000 : 410,
    ...(phase === 'completed' ? { path: '/models/missing.safetensors', reused: false, renamed: false,
      asset: { digest: `blake3:${'c'.repeat(64)}`, name: selection.name, size: 1000,
        mediaType: 'application/octet-stream', virtualPath: 'models/missing.safetensors' } } : {}),
  })
  await page.routeWebSocket('**/api/events*', (socket) => {
    notifyMountsChanged = () => socket.send(JSON.stringify({ type: 'mounts_changed' }))
  })
  await page.route('/api/settings', (route) => route.fulfill({ json: {
    features: { templates: { enabled: true } }, categories: { granted: [], available: [] }, settings: {},
  } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'gallery-test', schemaWire: 2 }, packs: {}, nodes: {},
  } }))
  await page.route('/api/templates*', (route) => route.fulfill({ json: { templates: [{
    pack: 'demo', id: 'models', name: 'Image starter', digest: 'sha256:test', models: ['missing.safetensors'],
  }] } }))
  await page.route('/api/models/settings*', (route) => route.fulfill({ json: {
    settings: { version: 1, locations: [{ id: 'models', path: '/models', mode: 'readwrite', visibility: 'always-on' }], downloadLocation: 'models' },
    locations: [{ id: 'models', path: '/models', mode: 'readwrite', visibility: 'always-on', mounts: ['models'], enabled: true, active: true }],
    revision: 'r1', project: 'default', changesAllowed: true, restartRequired: false, pendingRemovals: [],
  } }))
  await page.route('/api/assets/guess*', (route) => route.fulfill({ json: { matches: phase === 'completed' ? [{
    query: selection.name, candidates: [{ digest: `blake3:${'c'.repeat(64)}`, name: selection.name, confidence: 'name', held: true }],
  }] : [] } }))
  await page.route('**/index/templates*', (route) => route.fulfill({ json: { catalogVersion: 1, templates: [] } }))
  await page.route('/api/packs/demo/templates/models', (route) => route.fulfill({ json: {
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'review-only', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'Models', nodes: {
      loader: { id: 'loader', type: 'ReviewLoader', values: { model: 'missing.safetensors' } },
    }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } }, view: { graphs: { g0: { nodes: {} } } },
  } }))
  await page.route('/api/models/presence', (route) => {
    const { models } = route.request().postDataJSON() as { models: Array<{ name: string; kind: string }> }
    return route.fulfill({ json: { models: models.map((model) => ({ ...model,
      status: modelsPresent ? 'local' : 'missing', plannable: true })) } })
  })
  await page.route('/api/models/downloads?*', (route) => route.fulfill({ json: { instance: 'test', jobs: [
    ...(started ? [job()] : []),
    { ...job(), jobId: 'other-project', project: 'another-project', received: 900 },
    { ...job(), jobId: 'other-kind', kind: 'model/checkpoint', received: 900 },
  ] } }))
  await page.route('/api/models/downloads/plan*', (route) => {
    plans.push(route.request().postDataJSON())
    return route.fulfill({ json: { ...selection, status: 'consent-required', planId: 'reviewed-plan' } })
  })
  await page.route('/api/models/downloads/start*', (route) => {
    starts.push(route.request().url())
    started = true
    return route.fulfill({ json: job() })
  })
  await page.route('/api/models/downloads/template-job?*', (route) => {
    if (route.request().method() === 'DELETE') {
      cancellations.push('template-job')
      phase = 'cancelling'
    }
    return route.fulfill({ json: job() })
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'start from a template' })).toBeVisible()
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([{
    type: 'ReviewLoader', displayName: 'Load model', category: 'test', source: 'v3', isOutputNode: false,
    body: [{ kind: 'input', id: 'model', optional: false, type: { kind: 'concrete', name: 'ASSET' },
      widget: { widgetType: 'ASSET', kind: 'model/vae', options: {} } }],
  }]))
  await page.getByRole('button', { name: 'start from a template' }).click()
  const count = await page.evaluate(() => window.__dinksterTest!.app.tabs.get().length)
  await expect(page.getByRole('button', { name: 'Download 1 model', exact: true })).toBeVisible()
  await captureProof(page, 'template-download-before.png')
  await page.getByRole('button', { name: 'Download 1 model', exact: true }).click()
  const dialog = page.getByTestId('asset-consent-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('missing.safetensors')
  await expect(dialog.getByRole('button', { name: 'Run once', exact: true })).toHaveCount(0)
  expect(plans).toEqual([])
  expect(starts).toEqual([])
  await captureProof(page, 'template-download-review.png')
  await dialog.getByRole('button', { name: 'Review source', exact: true }).click()
  await expect.poll(() => plans).toEqual([{ name: 'missing.safetensors', kind: 'model/vae', project: 'default', scope: 'local' }])
  await dialog.getByRole('button', { name: 'Download', exact: true }).click()
  await expect(dialog.getByTestId('model-consent-bytes')).toBeVisible()
  await dialog.getByRole('button', { name: 'Dismiss', exact: true }).click()
  const gallery = page.getByTestId('templates-page')
  await expect(gallery).toContainText('Downloading 1 model, 41%')
  const modelState = gallery.locator('.dinkster-template-model-state')
  await expect(modelState).toHaveText('Downloading')
  const secondaryColor = await gallery.locator('.dinkster-template-fact dt').first().evaluate((element) => getComputedStyle(element).color)
  await expect(modelState).toHaveCSS('color', secondaryColor)
  await expect(gallery.getByRole('listbox', { name: 'Templates', exact: true }).getByRole('option', { selected: true })).toContainText('41%')
  expect(cancellations).toEqual([])
  await captureProof(page, 'template-download-progress.png')
  await page.getByRole('button', { name: 'Close Templates', exact: true }).click()
  expect(cancellations).toEqual([])
  await page.keyboard.press('Alt+t')
  await expect(gallery).toContainText('Downloading 1 model, 41%')
  await page.setViewportSize({ width: 900, height: 900 })
  await page.mouse.move(0, 0)
  await gallery.getByRole('searchbox', { name: 'Search templates', exact: true }).focus()
  await gallery.getByRole('searchbox', { name: 'Search templates', exact: true }).blur()
  await expect(gallery.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await captureProof(page, 'template-download-progress-900.png')
  await page.setViewportSize({ width: 1440, height: 900 })
  phase = 'publishing'
  await expect(gallery.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
  phase = 'downloading'
  await expect(gallery.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
  await gallery.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => cancellations).toEqual(['template-job'])
  await expect(gallery.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
  await captureProof(page, 'template-download-stopping.png')
  phase = 'cancelled'
  await expect(gallery.getByRole('button', { name: 'Download 1 model', exact: true })).toBeVisible()
  await expect(modelState).toHaveText('Missing')
  await captureProof(page, 'template-download-cancelled.png')
  jobId = 'external-retry'
  phase = 'downloading'
  await expect(modelState).toHaveText('Downloading')
  phase = 'failed'
  await expect(modelState).toHaveText('Missing')
  await captureProof(page, 'template-download-failed.png')
  jobId = 'external-completion'
  phase = 'downloading'
  await expect(modelState).toHaveText('Downloading')
  phase = 'completed'
  await expect(modelState).toHaveText('Here')
  await expect(gallery).toContainText('1 of 1 on this computer')
  await expect(gallery.getByRole('button', { name: 'Download 1 model', exact: true })).toHaveCount(0)
  await captureProof(page, 'template-download-completed.png')
  // A changed catalog can expose another missing requirement for review.
  phase = 'cancelled'
  await page.getByRole('button', { name: 'Close Templates', exact: true }).click()
  await page.keyboard.press('Alt+t')
  await gallery.getByRole('button', { name: 'Download 1 model', exact: true }).click()
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.tabs.get().length)).toBe(count)
  expect(await page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)).toBe(0)
  await page.evaluate(() => {
    const backend = window.__dinksterTest!.app.backends.get().find((item) => item.protocol === 'dinkster')!
    ;(backend as unknown as { templatesEnabled: { set(enabled: boolean): void } }).templatesEnabled.set(false)
  })
  await expect(dialog).toBeHidden()
  expect(starts).toHaveLength(1)
  await page.evaluate(() => {
    const backend = window.__dinksterTest!.app.backends.get().find((item) => item.protocol === 'dinkster')! as unknown as {
      templatesEnabled: { set(enabled: boolean): void }
      registry: { get(): import('@dinkster/client').SchemaRegistry; set(value: import('@dinkster/client').SchemaRegistry): void }
    }
    backend.templatesEnabled.set(true)
    const registry = backend.registry.get()!
    backend.registry.set({ ...registry, packs: new Map([...(registry.packs ?? []), ['demo', {
      displayName: 'Demo', assets: [{ id: 'missing', name: 'missing.safetensors',
        kind: 'model/vae', size: 2048, digest: `blake3:${'b'.repeat(64)}` }],
    }]]) })
  })
  await page.keyboard.press('Alt+t')
  await gallery.getByRole('button', { name: 'Use template', exact: true }).click()
  await expect(gallery).toBeHidden()
  await expect(page.getByTestId('import-asset-resolution-dialog')).toHaveCount(0)
  const banner = page.getByTestId('missing-models-banner')
  await expect(banner).toContainText('1 model missing')
  await expect(banner).toContainText('2 KiB')
  await captureProof(page, 'template-canvas-missing.png')
  await page.setViewportSize({ width: 900, height: 900 })
  await expect(banner).toBeVisible()
  await captureProof(page, 'template-canvas-missing-900.png')
  await page.setViewportSize({ width: 1440, height: 900 })
  await banner.getByRole('button', { name: 'Review download', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('missing.safetensors')
  await expect(dialog.getByRole('button', { name: 'Run once', exact: true })).toHaveCount(0)
  expect(starts).toHaveLength(1)
  expect(await page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)).toBe(0)
  await captureProof(page, 'template-canvas-review.png')
  const plansBeforeCanvasReview = plans.length
  await dialog.getByRole('button', { name: 'Review source', exact: true }).click()
  await expect.poll(() => plans.length).toBe(plansBeforeCanvasReview + 1)
  expect(starts).toHaveLength(1)
  phase = 'downloading'
  jobId = 'canvas-job'
  await dialog.getByRole('button', { name: 'Download', exact: true }).click()
  await expect.poll(() => starts.length).toBe(2)
  await expect(dialog.getByTestId('model-consent-bytes')).toBeVisible()
  await dialog.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(banner).toBeVisible()
  phase = 'completed'
  modelsPresent = true
  notifyMountsChanged()
  await expect(banner).toBeHidden()
  expect(await page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)).toBe(0)
  await captureProof(page, 'template-canvas-model-present.png')
  modelsPresent = false
  notifyMountsChanged()
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Review download', exact: true }).click()
  await expect(dialog).toBeVisible()
  await page.evaluate(() => {
    const backend = window.__dinksterTest!.app.backends.get().find((item) => item.protocol === 'dinkster')!
    ;(backend as unknown as { templatesEnabled: { set(enabled: boolean): void } }).templatesEnabled.set(false)
  })
  await expect(dialog).toBeHidden()
  await expect(banner).toBeHidden()
  await captureProof(page, 'template-canvas-feature-off.png')
})

const proofDir = process.env['DINKSTER_TEMPLATE_PROOF_DIR']
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })
const captureProof = async (page: import('@playwright/test').Page, name: string): Promise<void> => {
  if (proofDir !== undefined) {
    await page.screenshot({ path: join(proofDir, name), animations: 'disabled' })
  }
}
const body = JSON.stringify({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'remote-template',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'Remote starter',
      nodes: {},
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 0,
    },
  },
  view: { graphs: { g0: { nodes: {} } } },
})
const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`

async function openGalleryFromSearch(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('> From a template')
  await page
    .locator('[data-group="core.commands"]')
    .getByRole('option', { name: /From a template/ })
    .click()
}

test('renders a local template thumbnail from owned bytes and cancels it when the gallery closes', async ({ page }) => {
  let empty = false
  await page.routeWebSocket('**/api/events*', () => {})
  await page.route('/api/settings', (route) => route.fulfill({ json: {
    features: { templates: { enabled: true } }, categories: { granted: [], available: [] }, settings: {},
  } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'gallery-test', schemaWire: 2 }, packs: {}, nodes: {},
  } }))
  await page.route('/api/templates*', (route) => route.fulfill({ json: { templates: empty ? [] : [{
    pack: 'demo', id: 'starter', name: 'Local image starter', digest,
    family: 'SD 1.5', tags: ['image'], models: ['base.safetensors'],
    thumbnail: { digest: `sha256:${'a'.repeat(64)}`, mediaType: 'image/svg+xml' },
  }] } }))
  await page.route('/api/models/settings*', (route) => route.fulfill({ json: {
    settings: { version: 1, locations: [], downloadLocation: null }, locations: [],
    revision: 'r1', project: 'default', changesAllowed: true, restartRequired: false, pendingRemovals: [],
  } }))
  await page.route('/api/assets/guess*', (route) => route.fulfill({ json: { matches: [{ query: 'base.safetensors', candidates: [] }] } }))
  await page.route('**/index/templates*', (route) => route.fulfill({ json: { catalogVersion: 1, templates: [] } }))
  await page.route('**/api/packs/demo/templates/starter/thumbnail', (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#244268"/><circle cx="160" cy="90" r="55" fill="#c0defa"/></svg>',
  }))
  await page.goto('/')
  const open = page.getByRole('button', { name: 'start from a template' })
  await expect(open).toBeVisible()
  const newTabMenu = page.getByRole('button', { name: 'New tab', exact: true })
  await expect(page.getByTestId('new-tab-options')).toHaveCount(0)
  await expect(page.getByTestId('new-tab').getByRole('button', { name: 'New tab', exact: true })).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(newTabMenu).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
  await expect(newTabMenu).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await newTabMenu.hover()
  await newTabMenu.evaluate(async (button) => { await Promise.all(button.getAnimations().map((animation) => animation.finished)) })
  const hoverFill = await newTabMenu.evaluate((button) => getComputedStyle(button).backgroundColor)
  expect(hoverFill).not.toBe('rgba(0, 0, 0, 0)')
  const beforeMenu = await page.getByRole('tab').count()
  await newTabMenu.click()
  await expect(page.getByRole('tab')).toHaveCount(beforeMenu)
  await page.mouse.move(0, 0)
  await expect(newTabMenu).toHaveCSS('background-color', hoverFill)
  await expect(page.getByRole('menuitem').locator('.dinkster-menu-item-label')).toHaveText(['Blank workflow', 'From a template'])
  await expect(page.getByRole('menuitem', { name: 'Blank workflow', exact: true }).locator('.dinkster-key')).toHaveText(['Alt', 'N'])
  await expect(page.getByRole('menuitem', { name: 'From a template', exact: true }).locator('.dinkster-key')).toHaveText(['Alt', 'T'])
  await captureProof(page, 'plus-menu-open.png')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitem')).toHaveCount(0)
  const beforeShortcut = await page.getByRole('tab').count()
  await page.keyboard.press('Control+Shift+Digit1')
  await page.keyboard.press('Control+Shift+Digit2')
  await expect(page.getByRole('tab')).toHaveCount(beforeShortcut)
  await expect(page.getByTestId('templates-page')).toHaveCount(0)
  await page.keyboard.press('Alt+n')
  await expect(page.getByRole('tab')).toHaveCount(beforeShortcut + 1)
  await page.keyboard.press('Alt+t')
  await expect(page.getByTestId('templates-page')).toBeVisible()
  await page.keyboard.press('Alt+n')
  await expect(page.getByRole('tab')).toHaveCount(beforeShortcut + 3)
  await expect(page.getByTestId('templates-page')).toBeHidden()
  await page.getByRole('button', { name: 'Close Templates', exact: true }).click()
  await newTabMenu.click()
  await page.getByTestId('graph-canvas').click({ position: { x: 20, y: 100 } })
  await expect(page.getByRole('menuitem')).toHaveCount(0)
  await newTabMenu.click()
  const tabCount = await page.getByRole('tab').count()
  await page.getByRole('menuitem', { name: 'Blank workflow', exact: true }).click()
  await expect(page.getByRole('tab')).toHaveCount(tabCount + 1)
  await expect(page.getByRole('menuitem')).toHaveCount(0)
  await newTabMenu.click()
  await page.getByRole('menuitem', { name: 'From a template', exact: true }).click()
  await expect(page.getByTestId('templates-page')).toBeVisible()
  await page.getByRole('button', { name: 'Close Templates', exact: true }).click()
  await open.click()
  const gallery = page.getByTestId('templates-page')
  const image = gallery.getByRole('option', { name: /Local image starter/ }).locator('img')
  await expect(image).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(320)
  const source = await image.getAttribute('src')
  await expect(gallery.getByRole('alert')).toHaveCount(0)
  await expect(gallery.getByText('No model folder yet')).toBeVisible()
  await captureProof(page, 'templates-page-integrated.png')
  if (proofDir !== undefined) await gallery.screenshot({ path: join(proofDir, 'local-template-thumbnail.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Close Templates', exact: true }).click()
  await expect(gallery).toBeHidden()
  await expect.poll(() => page.evaluate(async (url) => {
    try { await fetch(url!); return false } catch { return true }
  }, source)).toBe(true)
  empty = true
  await open.click()
  await expect(gallery.getByText('No templates yet. Packs you add can bring their own.')).toBeVisible()
  await expect(gallery.locator('.dinkster-template-detail')).toHaveCount(0)
  await captureProof(page, 'templates-page-empty-integrated.png')
  await gallery.getByRole('button', { name: 'Blank workflow', exact: true }).click()
  await expect(gallery).toBeHidden()
  await expect(page.getByRole('tab', { name: /Templates/ })).toHaveCount(0)
  await expect(page.getByRole('tab')).toHaveCount(tabCount + 2)
})

test('refreshes the remote family gallery and opens a digest-verified template', async ({
  page,
}) => {
  let published = 1
  let catalogRequests = 0
  let templateFailures = 1
  const registry = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    if (request.url?.startsWith('/index/templates') === true) {
      catalogRequests += 1
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          catalogVersion: 1,
          templates: [
            {
              pack: 'starters',
              version: '1.0.0',
              id: 'sd15',
              name: 'Stable Diffusion 1.5',
              digest,
              family: 'dinkster.sd15',
              models: ['sd15.safetensors'],
            },
            ...(published > 1
              ? [
                  {
                    pack: 'starters',
                    version: '1.1.0',
                    id: 'minimax-h3',
                    name: 'MiniMax H3',
                    digest,
                    family: 'dinkster.minimax_h3',
                    models: ['h3-dit.safetensors', 'h3-video-vae.safetensors'],
                  },
                ]
              : []),
          ],
        }),
      )
      return
    }
    if (
      /^\/index\/packs\/starters\/versions\/[^/]+\/templates\/[^/]+$/.test(
        request.url ?? '',
      )
    ) {
      if (request.url?.endsWith('/minimax-h3') === true && templateFailures-- > 0) {
        response.statusCode = 403
        response.end('blocked template')
        return
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(body)
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve))
  const address = registry.address()
  if (address === null || typeof address === 'string')
    throw new Error('local registry did not bind')
  const registryUrl = `http://127.0.0.1:${address.port}`
  try {
    await page.routeWebSocket('**/api/events*', () => {})
    await page.route('/api/settings', (route) => route.fulfill({ json: {
      features: { templates: { enabled: true } },
      categories: { granted: [], available: [] }, settings: {},
    } }))
    await page.route('/api/nodes*', (route) =>
      route.fulfill({
        json: {
          schemaVersion: 1,
          epoch: 1,
          dinkster: { version: 'gallery-test', schemaWire: 2 },
          packs: {},
          nodes: {},
        },
      }),
    )
    await page.route('/api/templates*', (route) =>
      route.fulfill({ json: { templates: [] } }),
    )
    await page.route('/api/models/settings*', (route) => route.fulfill({ json: {
      settings: { version: 1, locations: [], downloadLocation: null }, locations: [],
      revision: 'r1', project: 'default', changesAllowed: true, restartRequired: false, pendingRemovals: [],
    } }))
    await page.route('/api/assets/guess', async (route) => {
      const request = route.request().postDataJSON() as { names: string[] }
      await route.fulfill({
        json: {
          matches: request.names.map((query) => ({ query, candidates: [] })),
        },
      })
    })

    await page.goto('/')
    await expect
      .poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined))
      .toBe(true)
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__dinksterTest!.app.backends.get()[0]?.protocol,
        ),
      )
      .toBe('dinkster')
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__dinksterTest!.app.backends.get()[0]?.registry.get() !==
            undefined,
        ),
      )
      .toBe(true)
    await expect.poll(() => page.evaluate(() => {
      const app = window.__dinksterTest!.app as unknown as {
        settings: { list(): readonly { id: string }[] }
      }
      return app.settings.list().some((setting) => setting.id === 'templates.registryUrl')
    })).toBe(true)
    await page.evaluate((registry) => {
      const app = window.__dinksterTest!.app as unknown as {
        settings: { set(id: string, value: string): void }
      }
      app.settings.set('templates.registryUrl', registry)
    }, registryUrl)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const app = window.__dinksterTest!.app as unknown as {
            settings: { get(id: string): string }
          }
          return app.settings.get('templates.registryUrl')
        }),
      )
      .toBe(registryUrl)

    const gallery = page.getByTestId('templates-page')
    await expect(gallery).toBeHidden()
    const openGallery = page.getByRole('button', { name: 'start from a template' })
    await expect(openGallery).toBeVisible()
    await captureProof(page, 'starter-template-blank-startup.png')
    const canvas = page.getByTestId('graph-canvas')
    await canvas.dblclick({ position: { x: 120, y: 120 } })
    await expect(page.getByTestId('node-palette')).toBeVisible()
    await page.keyboard.press('Escape')

    await openGallery.click()
    await expect(gallery).toBeVisible()
    await gallery.getByRole('button', { name: 'Blank workflow', exact: true }).click()
    await expect(gallery).toBeHidden()
    await captureProof(page, 'starter-template-after-start-blank.png')

    await openGalleryFromSearch(page)
    await expect(gallery).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(gallery).toBeVisible()
    await page.mouse.click(1, 1)
    await expect(gallery).toBeVisible()
    await captureProof(page, 'starter-template-page.png')
    if (proofDir !== undefined) {
      await page.setViewportSize({ width: 700, height: 900 })
      await page.screenshot({
        path: join(proofDir, 'starter-template-page-narrow.png'),
        animations: 'disabled',
      })
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    await page.getByRole('button', { name: 'Close Templates', exact: true }).click()
    await expect(gallery).toBeHidden()
    await captureProof(page, 'starter-template-after-close.png')
    await openGalleryFromSearch(page)
    await expect.poll(() => catalogRequests).toBeGreaterThan(0)
    const tiles = gallery.getByRole('listbox', { name: 'Templates', exact: true }).getByRole('option')
    await expect(tiles).toHaveCount(1)
    await expect(gallery.locator('.dinkster-template-detail')).toContainText('sd15.safetensors')
    const gallerySearch = gallery.getByRole('searchbox', { name: 'Search templates' })
    for (const query of ['SD 1.5', 'sd1.5', 'SD15']) {
      await gallerySearch.fill(query)
      await expect(tiles).toHaveCount(1)
      await expect(tiles).toContainText('Stable Diffusion 1.5')
    }
    if (proofDir !== undefined)
      await gallery.screenshot({
        path: join(proofDir, 'starter-template-search-sd15.png'),
        animations: 'disabled',
      })
    await gallerySearch.fill('')
    await page.getByRole('button', { name: 'Close Templates', exact: true }).click()

    published = 2
    await openGalleryFromSearch(page)
    await expect(tiles).toHaveCount(2)
    if (proofDir !== undefined)
      await gallery.screenshot({
        path: join(proofDir, 'starter-template-gallery.png'),
        animations: 'disabled',
      })
    await gallery.getByRole('option', { name: /MiniMax H3/ }).click()
    await expect(gallery.getByRole('alert')).toHaveCount(0)
    await expect(gallery.locator('.dinkster-template-detail')).toContainText('h3-video-vae.safetensors')
    await gallery.getByRole('button', { name: 'Use template', exact: true }).click()
    await expect(gallery.getByRole('alert')).toContainText('MiniMax H3 could not be opened')
    await expect(gallery).toBeVisible()
    await captureProof(page, 'starter-template-gallery-error.png')
    await gallery.getByRole('button', { name: 'Use template', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__dinksterTest!.app.activeTab()?.store.doc.lineage,
        ),
      )
      .toBe('remote-template')
    await expect(gallery).toBeHidden()
    await captureProof(page, 'starter-template-after-retry.png')
  } finally {
    await new Promise<void>((resolve, reject) =>
      registry.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    )
  }
})

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'

const proofDir = process.env['DINKSTER_TEMPLATE_PROOF_DIR']
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })
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

test('refreshes the remote family gallery and opens a digest-verified template', async ({
  page,
}) => {
  let published = 1
  let catalogRequests = 0
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
    await page.route('/api/nodes*', (route) =>
      route.fulfill({
        json: {
          schemaVersion: 1,
          epoch: 1,
          dinkster: { version: 'gallery-test', schemaWire: 1 },
          packs: {},
          nodes: {},
        },
      }),
    )
    await page.route('/api/templates*', (route) =>
      route.fulfill({ json: { templates: [] } }),
    )
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

    const gallery = page.getByTestId('template-gallery')
    await expect(gallery).toBeVisible()
    const canvas = page.getByTestId('graph-canvas')
    await canvas.dblclick({ position: { x: 120, y: 120 } })
    await expect(page.getByTestId('node-palette')).toBeVisible()
    await expect(gallery).toBeVisible()
    if (proofDir !== undefined)
      await page.screenshot({ path: join(proofDir, 'starter-template-gallery-with-palette.png'), fullPage: true })
    await page.keyboard.press('Escape')
    if (proofDir !== undefined) {
      await page.setViewportSize({ width: 700, height: 900 })
      await page.screenshot({ path: join(proofDir, 'starter-template-gallery-narrow.png'), fullPage: true })
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    await gallery
      .getByRole('button', { name: 'Close template gallery' })
      .click()
    await page.getByTestId('topbar-search').click()
    await page
      .getByTestId('universal-search-input')
      .fill('> Open template gallery')
    await page
      .locator('[data-provider="core.commands"]')
      .getByRole('option', { name: 'Open template gallery' })
      .click()
    await expect.poll(() => catalogRequests).toBeGreaterThan(0)
    await expect(page.getByTestId('template-card')).toHaveCount(1)
    await expect(gallery.locator('.template-family')).toHaveAttribute(
      'data-family',
      'dinkster.sd15',
    )
    await expect(page.getByTestId('template-card')).toContainText(
      '1 required model(s) missing',
    )
    const gallerySearch = gallery.getByTestId('template-gallery-search')
    for (const query of ['SD 1.5', 'sd1.5', 'SD15']) {
      await gallerySearch.fill(query)
      await expect(page.getByTestId('template-card')).toHaveCount(1)
      await expect(page.getByTestId('template-card')).toContainText('Stable Diffusion 1.5')
    }
    if (proofDir !== undefined)
      await gallery.screenshot({
        path: join(proofDir, 'starter-template-search-sd15.png'),
        animations: 'disabled',
      })
    await gallery.getByTestId('template-gallery-search-clear').click()
    await gallery
      .getByRole('button', { name: 'Close template gallery' })
      .click()

    published = 2
    await page.getByTestId('topbar-search').click()
    await page
      .getByTestId('universal-search-input')
      .fill('> Open template gallery')
    await page
      .locator('[data-provider="core.commands"]')
      .getByRole('option', { name: 'Open template gallery' })
      .click()
    await expect(page.getByTestId('template-card')).toHaveCount(2)
    await expect(
      gallery.locator('[data-family="dinkster.minimax_h3"]'),
    ).toContainText('2 required model(s) missing')
    if (proofDir !== undefined)
      await gallery.screenshot({
        path: join(proofDir, 'starter-template-gallery.png'),
        animations: 'disabled',
      })
    await gallery.getByRole('option', { name: /MiniMax H3/ }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__dinksterTest!.app.activeTab()?.store.doc.lineage,
        ),
      )
      .toBe('remote-template')
  } finally {
    await new Promise<void>((resolve, reject) =>
      registry.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    )
  }
})

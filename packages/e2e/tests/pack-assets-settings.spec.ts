import { mkdirSync } from 'node:fs'
import { expect, test } from './fixtures.js'

const proofDir = process.env['DINKSTER_PACK_ASSETS_SETTINGS_PROOF_DIR']

test('a pack static asset and declared settings are available through the native connection', async ({
  page,
}) => {
  if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })
  let values = { enabled: true, quality: 2 }
  const settingsResponse = () => ({
    packId: 'render.pack',
    displayName: 'Render Pack',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: {
          type: 'boolean',
          title: 'Enable enhancement',
          description: 'Use the pack enhancement.',
          default: true,
        },
        quality: {
          type: 'integer',
          title: 'Quality level',
          default: 2,
          minimum: 1,
          maximum: 5,
        },
      },
      required: ['enabled', 'quality'],
    },
    values,
  })
  await page.routeWebSocket('**/ws*', () => {})
  await page.route('/supervisor/status', (route) =>
    route.fulfill({ status: 502, body: 'no supervisor' }),
  )
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/api/diagnostics', (route) =>
    route.fulfill({ json: { diagnostics: [] } }),
  )
  await page.route('/api/composition', (route) => route.fulfill({ json: {} }))
  await page.route('/api/nodes*', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 44,
        epoch: 1,
        dinkster: { version: 'pack-assets-settings-e2e', schemaWire: 44 },
        packs: {
          'render.pack': { displayName: 'Render Pack', settings: true },
        },
        nodes: {},
      },
    }),
  )
  await page.route('/packs/render.pack/static/theme.css', (route) =>
    route.fulfill({
      contentType: 'text/css',
      body: '.render-pack { color: #7ab7ff; }\n',
    }),
  )
  await page.route('/api/packs/render.pack/settings', async (route) => {
    if (route.request().method() === 'PUT')
      values = route.request().postDataJSON() as typeof values
    await route.fulfill({ json: settingsResponse() })
  })

  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('0 node schemas', {
    timeout: 15_000,
  })
  expect(
    await page.evaluate(async () => {
      const response = await fetch('/packs/render.pack/static/theme.css')
      return {
        body: await response.text(),
        contentType: response.headers.get('content-type'),
      }
    }),
  ).toEqual({
    body: '.render-pack { color: #7ab7ff; }\n',
    contentType: 'text/css',
  })

  await page.getByTestId('settings-button').click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog
    .locator('.settings-categories')
    .getByRole('button', { name: 'Render Pack', exact: true })
    .click()
  await expect(
    dialog.getByRole('heading', { name: 'Render Pack' }),
  ).toBeVisible()
  const enabled = dialog.getByRole('checkbox', { name: 'Enable enhancement' })
  const quality = dialog.getByRole('spinbutton', { name: 'Quality level' })
  await expect(enabled).toHaveAttribute('aria-checked', 'true')
  await expect(quality).toHaveValue('2')
  await enabled.click()
  await expect(enabled).toHaveAttribute('aria-checked', 'false')
  await quality.fill('4')
  await quality.press('Enter')
  await expect.poll(() => values).toEqual({ enabled: false, quality: 4 })

  const screenshot =
    proofDir === undefined
      ? test.info().outputPath('pack-assets-settings.png')
      : `${proofDir}/pack-assets-settings.png`
  await page.screenshot({
    path: screenshot,
    animations: 'disabled',
    fullPage: true,
  })
  await test
    .info()
    .attach('pack-assets-settings', {
      path: screenshot,
      contentType: 'image/png',
    })
})

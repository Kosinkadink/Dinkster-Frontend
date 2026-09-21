import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const proofDirectory = process.env['DINKSTER_EXTENSION_CONTRACT_PROOF_DIR']

test('an ordinary third-party pack activates and executes through public contracts', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(
    /\d+ node schemas/,
    { timeout: 30_000 },
  )
  await expect
    .poll(() =>
      page.evaluate(() => {
        const schemas = window
          .__dinksterTest!.app.backends.get()[0]
          ?.registry.get()?.schemas
        return {
          contract: schemas?.has('fixture.extension.contract'),
          value: schemas?.has('fixture.extension.value'),
          defaultPack: schemas?.has('dinkster.int'),
        }
      }),
    )
    .toEqual({ contract: true, value: true, defaultPack: false })
  const status = page.locator(
    '[data-host-ui-contribution="dinkster-extension-contract-fixture.status"]',
  )
  await expect(status).toContainText('Third-party pack route ready', {
    timeout: 15_000,
  })
  await expect(status).toContainText('Waiting for custom fixture execution')

  const diagnostics = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'extension-contract-pack',
        root: 'root',
        graphs: {
          root: {
            id: 'root',
            name: 'Extension contract',
            nets: {},
            reroutes: {},
            nextOrdinal: 3,
            nodes: {
              value: {
                id: 'value',
                type: 'fixture.extension.value',
                title: 'Extension contract value',
                values: { width: 13, height: 7 },
              },
              proof: {
                id: 'proof',
                type: 'fixture.extension.contract',
                title: 'Extension contract proof',
                values: {},
              },
            },
            links: {
              sample: {
                id: 'sample',
                from: { node: 'value', port: 'sample' },
                to: { node: 'proof', port: 'sample' },
              },
            },
          },
        },
        view: {
          graphs: {
            root: {
              nodes: {
                value: { position: { x: 80, y: 180 } },
                proof: { position: { x: 320, y: 180 } },
              },
            },
          },
        },
      } as never,
      'Third-party extension contract',
    )
  })
  expect(diagnostics).toEqual([])
  await expect
    .poll(() =>
      page.evaluate(() =>
        window
          .__dinksterTest!.renderer!.getScene()
          .nodes.map((node) => node.id)
          .sort(),
      ),
    )
    .toEqual(['proof', 'value'])

  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, ['proof'])
  })
  await expect(
    page.getByTestId('execution-row').first().locator('.execution-status'),
  ).toHaveText('Completed', { timeout: 30_000 })
  await expect(status).toContainText(
    'Custom fixture execution: 13 x 7 (mean 0.500)',
  )

  const screenshot = await page.screenshot({ animations: 'disabled' })
  await testInfo.attach('ordinary-third-party-pack.png', {
    body: screenshot,
    contentType: 'image/png',
  })
  if (proofDirectory !== undefined) {
    mkdirSync(proofDirectory, { recursive: true })
    await page.screenshot({
      path: `${proofDirectory}/ordinary-third-party-pack.png`,
      animations: 'disabled',
    })
  }
})

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadDocument } from '@dinkster/core'
import { expect, nativeTest as test, waitForWorkspaceReady } from './fixtures.js'

const backend = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const proofDir = process.env['DINKSTER_TEMPLATE_PROOF_DIR']

test('a served template replaces the Templates page with its workflow without running it', async ({ page, request }) => {
  const response = await request.get(`${backend}/api/packs/dinkster-nodes-dev/templates/dev-gallery`)
  expect(response.ok()).toBe(true)
  const expected = loadDocument(await response.json()).document
  expect(expected).toBeDefined()

  await page.goto(process.env['DINKSTER_E2E_NATIVE_FRONTEND'] ?? '/')
  await waitForWorkspaceReady(page)
  await page.keyboard.press('Alt+t')
  const gallery = page.getByTestId('templates-page')
  await expect(gallery).toBeVisible()
  await gallery.getByRole('searchbox', { name: 'Search templates', exact: true }).fill('Widget & Socket Gallery')
  await gallery.getByRole('option', { name: /Widget & Socket Gallery/ }).click()
  if (proofDir !== undefined) {
    mkdirSync(proofDir, { recursive: true })
    await page.screenshot({ path: join(proofDir, 'served-template-page.png'), animations: 'disabled' })
  }

  const before = await page.getByRole('tablist', { name: 'Open workflows' }).getByRole('tab').count()
  await gallery.getByRole('button', { name: 'Use template', exact: true }).click()
  await expect(gallery).toBeHidden()
  await expect(page.getByRole('tab', { name: /Widget & Socket Gallery/, selected: true })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Open workflows' }).getByRole('tab')).toHaveCount(before)
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const document = app.activeTab()!.store.doc
    return Object.fromEntries(Object.entries(document.graphs).map(([id, graph]) => [id,
      Object.values(graph.nodes).map((node) => [node.id, node.type]).sort(),
    ]))
  })).toEqual(Object.fromEntries(Object.entries(expected!.graphs).map(([id, graph]) => [id,
    Object.values(graph.nodes).map((node) => [node.id, node.type]).sort(),
  ])))
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer?.getScene().nodes.length ?? 0)).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)).toBe(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((problem) => problem.severity === 'error').map((problem) => `${problem.code}: ${problem.message}`))).toEqual([])
  if (proofDir !== undefined)
    await page.screenshot({ path: join(proofDir, 'served-template-opened.png'), animations: 'disabled' })
})

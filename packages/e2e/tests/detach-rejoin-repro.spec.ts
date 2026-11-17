import type { Page } from '@playwright/test'
import { nativeTest as test, expect, waitForStartupOwnership } from './fixtures.js'

const catalog = { schemaVersion: 1, epoch: 1, dinkster: { version: 'window-test', schemaWire: 1 }, nodes: {} }

test.beforeEach(async ({ context }) => {
  await context.route('**/api/nodes*', (route) => route.fulfill({ json: catalog }))
  await context.route('**/supervisor/status', (route) => route.fulfill({ status: 502 }))
  await context.routeWebSocket('**/api/events?*', () => {})
})

async function ready(page: Page): Promise<void> {
  await waitForStartupOwnership(page)
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([
    { type: 'TestNode', displayName: 'Test node', category: 'test', source: 'v3', isOutputNode: false, items: [] },
  ]))
}

async function addNode(page: Page): Promise<void> {
  expect(await page.evaluate(async () => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const index = Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes).length
    const outcome = tab.store.dispatch({ command: 'node.add', params: {
      graphId: tab.store.doc.root, type: 'TestNode', position: { x: (index % 3) * 360, y: Math.floor(index / 3) * 180 },
    } })
    await (tab.store as unknown as { settle(): Promise<void> }).settle()
    return outcome.ok
  })).toBe(true)
}

async function nodes(page: Page, id: string) {
  return page.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((tab) => tab.id === id)!
    return tab.store.doc.graphs[tab.store.doc.root]!.nodes
  }, id)
}

async function detach(page: Page): Promise<Page> {
  await page.locator('[id^="workflow-tab-"]').click({ button: 'right' })
  const popup = page.waitForEvent('popup')
  await page.getByRole('menuitem', { name: 'Move to new window', exact: true }).click()
  const detached = await popup
  await ready(detached)
  await expect(page.getByTestId('detached-workspace-state')).toBeVisible()
  return detached
}

test('repeated detach and rejoin preserves foreign edits and remains editable', async ({ page, context }, info) => {
  const errors: string[] = []
  const observe = (p: Page) => {
    p.on('pageerror', (error) => errors.push(error.message))
    p.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('[SharedDocumentSession]')) errors.push(message.text())
    })
  }
  observe(page)
  context.on('page', observe)
  await page.goto('/')
  await ready(page)
  const id = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.id)
  await addNode(page)
  for (let cycle = 0; cycle < 3; cycle++) {
    const detached = await detach(page)
    await addNode(detached)
    expect(await detached.evaluate(async (cycle) => {
      const tab = window.__dinksterTest!.app.activeTab()!
      const nodeId = Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes)[0]!
      for (const title of [`Detached edit ${cycle}`, `Final detached edit ${cycle}`]) {
        const outcome = tab.store.dispatch({ command: 'node.setTitle', params: { graphId: tab.store.doc.root, nodeId, title } })
        if (!outcome.ok) return false
        await (tab.store as unknown as { settle(): Promise<void> }).settle()
      }
      return true
    }, cycle)).toBe(true)
    const detachedNodes = await nodes(detached, id)
    await expect.poll(() => nodes(page, id)).toEqual(detachedNodes)
    await Promise.all([detached.waitForEvent('close'), detached.getByTestId('redock-workflow').click()])
    await expect(page.getByTestId('detached-workspace-state')).toHaveCount(0)
    await addNode(page)
    expect(Object.keys(await nodes(page, id))).toHaveLength(3 + cycle * 2)
    expect(Object.values(await nodes(page, id))[0]!.title).toBe(`Final detached edit ${cycle}`)
  }
  const beforeUndo = await nodes(page, id)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  await expect.poll(async () => Object.keys(await nodes(page, id)).length).toBe(6)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.redo())).toBe(true)
  await expect.poll(() => nodes(page, id)).toEqual(beforeUndo)
  await expect(page.getByTestId('workflow-session-recovery')).toHaveCount(0)
  await page.getByTestId('canvas-fit-view').click()
  await page.screenshot({ path: info.outputPath('rejoined.png') })
  expect(errors).toEqual([])
})

test('failed session offers a recovery copy without replacing its source', async ({ page }, info) => {
  await page.goto('/')
  await ready(page)
  await addNode(page)
  const original = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return { id: tab.id, document: tab.store.doc }
  })
  const detached = await detach(page)
  await page.route('**/api/library/retentions/document/*?scope=local', (route) =>
    route.fulfill({ status: 409, json: { error: 'Ownership admission refused' } }))
  await addNode(detached)
  await Promise.all([detached.waitForEvent('close'), detached.getByTestId('redock-workflow').click()])
  const recovery = page.getByTestId('workflow-session-recovery')
  await expect(recovery).toBeVisible()
  await expect(recovery).toContainText('Editing has stopped')
  await page.screenshot({ path: info.outputPath('session-recovery.png') })
  await recovery.getByRole('button', { name: 'Open recovery copy', exact: true }).click()
  await expect(recovery).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.tabs.get().length)).toBe(1)
  await page.unroute('**/api/library/retentions/document/*?scope=local')
  await recovery.getByRole('button', { name: 'Open recovery copy', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.id)).not.toBe(original.id)
  await expect(recovery).toHaveCount(0)
  const recovered = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return { id: app.activeTab()!.id, document: app.activeTab()!.store.doc,
      source: app.tabs.get().find((tab) => tab.id !== app.activeTab()!.id)!.store.doc }
  })
  expect({ ...recovered.document, lineage: original.id }).toEqual(original.document)
  expect(recovered.source).toEqual(original.document)
  await ready(page)
  await addNode(page)
  expect(Object.keys(await nodes(page, recovered.id))).toHaveLength(2)
  await page.getByTestId('canvas-fit-view').click()
  await page.screenshot({ path: info.outputPath('recovered-copy.png') })
})

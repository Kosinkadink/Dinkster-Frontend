import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

const BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const fixture = JSON.parse(
  readFileSync(new URL('../../core/fixtures/workflows/seed-basic.json', import.meta.url), 'utf8'),
) as unknown

test('a remote link drag paints a presence noodle and clears on release', async ({ browser }) => {
  const ownerContext = await browser.newContext()
  const peerContext = await browser.newContext()
  const owner = await ownerContext.newPage()
  const peer = await peerContext.newPage()
  let ownerTabId: string | undefined
  let cleanupError: string | undefined
  try {
    let backendReady = false
    try {
      backendReady = (await fetch(`${BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2000) })).ok
    } catch { /* unreachable */ }
    test.skip(!backendReady, `no native Dinkster backend reachable at ${BACKEND} (set DINKSTER_NATIVE_BACKEND)`)

    await Promise.all([owner.goto('/'), peer.goto('/')])
    await Promise.all([owner, peer].map(async (page) => {
      await page.getByTestId('backends-sidebar-toggle').click()
      await page.getByTestId('backend-url-input').fill(BACKEND)
      await page.getByTestId('backend-add').click()
    }))
    await Promise.all([
      owner.waitForFunction(() => {
        const app = window.__dinksterTest?.app as unknown as { collabBackend(): unknown } | undefined
        return window.__dinksterTest?.renderer && app?.collabBackend()
      }),
      peer.waitForFunction(() => {
        const app = window.__dinksterTest?.app as unknown as { collabBackend(): unknown } | undefined
        return window.__dinksterTest?.renderer && app?.collabBackend()
      }),
    ])
    await Promise.all([owner, peer].map((page) => page.waitForFunction(() => {
      const app = window.__dinksterTest!.app
      const tab = app.activeTab()
      const registry = app.backends.get().find((backend) => backend.protocol === 'dinkster')?.registry.get() as
        { resolve(type: string): unknown } | undefined
      return tab !== undefined && 'status' in tab.store &&
        registry?.resolve('EmptyImage') !== undefined &&
        registry.resolve('PreviewImage') !== undefined
    })))
    const openFailures = await owner.evaluate(
      (document) => window.__dinksterTest!.app.openDocument(document, 'Collab noodle presence'),
      fixture,
    )
    expect(openFailures).toEqual([])
    await owner.waitForFunction(() => {
      const tab = window.__dinksterTest!.app.activeTab()
      return tab !== undefined && 'status' in tab.store &&
        (tab.store.status as { get(): string }).get() === 'live' &&
        tab.store.doc.lineage === 'lineage-seed-basic'
    })

    const shared = await owner.evaluate(async () => {
      const app = window.__dinksterTest!.app as unknown as {
        activeTab(): { id: string; store: { settle(): Promise<void> } }
        shareActiveTab(): Promise<string | undefined>
        collabFor(tabId: string): { descriptor: { sessionId: string } } | undefined
      }
      await app.activeTab().store.settle()
      const error = await app.shareActiveTab()
      const tabId = app.activeTab().id
      return { error, tabId, sessionId: app.collabFor(tabId)?.descriptor.sessionId }
    })
    expect(shared.error).toBeUndefined()
    expect(shared.sessionId).toBeTruthy()
    ownerTabId = shared.tabId
    const joinError = await peer.evaluate(async (id) => {
      const app = window.__dinksterTest!.app as unknown as {
        joinCollabSession(sessionId: string): Promise<string | undefined>
      }
      return app.joinCollabSession(id)
    }, shared.sessionId!)
    expect(joinError).toBeUndefined()

    const pin = await owner.evaluate(() => {
      const renderer = window.__dinksterTest!.renderer!
      renderer.setViewport({ x: 0, y: 0, scale: 1 })
      const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'n0')!
      const output = node.layout.pins.find((candidate) =>
        candidate.direction === 'out' && (!('widgetTap' in candidate) || candidate.widgetTap !== true),
      )!
      return { x: node.x + node.layout.width, y: node.y + output.y }
    })
    await peer.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))

    const ownerBox = await owner.getByTestId('graph-canvas').boundingBox()
    if (ownerBox === null) throw new Error('owner canvas missing')
    await owner.mouse.move(ownerBox.x + pin.x, ownerBox.y + pin.y)
    await owner.mouse.down()
    await owner.mouse.move(ownerBox.x + pin.x + 180, ownerBox.y + pin.y + 90, { steps: 4 })

    await expect.poll(() => peer.evaluate(() => {
      const renderer = window.__dinksterTest!.renderer! as unknown as {
        getPresence(): readonly { link?: unknown }[]
      }
      return renderer.getPresence().some((actor) => actor.link !== undefined)
    })).toBe(true)

    await owner.mouse.up()
    await expect.poll(() => peer.evaluate(() => {
      const renderer = window.__dinksterTest!.renderer! as unknown as {
        getPresence(): readonly { link?: unknown }[]
      }
      return renderer.getPresence().every((actor) => actor.link === undefined)
    })).toBe(true)
  } finally {
    try {
      if (ownerTabId !== undefined && !owner.isClosed()) {
        cleanupError = await owner.evaluate(async (tabId) => {
          const app = window.__dinksterTest!.app as unknown as {
            endCollabSession(tabId: string): Promise<string | undefined>
          }
          return app.endCollabSession(tabId)
        }, ownerTabId)
      }
    } finally {
      await Promise.allSettled([ownerContext.close(), peerContext.close()])
    }
  }
  expect(cleanupError).toBeUndefined()
})

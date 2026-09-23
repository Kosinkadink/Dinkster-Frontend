import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const BACKEND =
  process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:3639'
const proofDir = (): string =>
  process.env['DINKSTER_COLLAB_PROOF_DIR'] ??
  join(test.info().project.outputDir, 'evidence', 'issue-107')

/**
 * Live two-client proof that image and video documents share the ONE
 * document/collaboration pipeline with workflows: mixed kinds in one tab
 * strip, shared sessions of both non-workflow kinds against the live native
 * backend, convergence in both directions, the full image command surface,
 * reload rejoin, and per-tab view state. Requires a reachable native backend
 * (DINKSTER_NATIVE_BACKEND, default http://127.0.0.1:3639).
 */

type TestApp = {
  activeTab(): { id: string; store: { settle(): Promise<void> } }
  shareActiveTab(): Promise<string | undefined>
  joinCollabSession(sessionId: string): Promise<string | undefined>
  collabFor(tabId: string):
    | {
        descriptor: { sessionId: string }
        session: { status: { get(): string } }
      }
    | undefined
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const app = (window as unknown as { __dinksterTest?: { app?: unknown } })
      .__dinksterTest
    return app?.app !== undefined
  })
}

async function waitForBackend(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const app = (
      window as unknown as {
        __dinksterTest?: { app?: { collabBackend(): unknown } }
      }
    ).__dinksterTest?.app
    return app !== undefined && app.collabBackend() !== undefined
  })
}

const clickTab = (page: Page, tabId: string) =>
  page.locator(`.tab[data-tab-id="${tabId}"] .tab-select`).click()

/** A client may hold several image documents; only the active panel is on screen. */
const activeImagePanel = (page: Page) =>
  page
    .getByTestId('image-document-workspace')
    .locator('.image-document-tabpanel:not([hidden])')

async function rasterFile(
  page: Page,
  name: string,
  width: number,
  height: number,
  paint: 'base' | 'overlay' | 'mask' | 'peer',
) {
  const bytes = await page.evaluate(
    async ({ width, height, paint }) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const target = canvas.getContext('2d')!
      if (paint === 'base') {
        const gradient = target.createLinearGradient(0, 0, width, height)
        gradient.addColorStop(0, '#173f6c')
        gradient.addColorStop(0.48, '#377aa2')
        gradient.addColorStop(1, '#d7a86e')
        target.fillStyle = gradient
        target.fillRect(0, 0, width, height)
        target.fillStyle = '#ffffffcc'
        target.font = '600 54px sans-serif'
        target.fillText('Shared image document', 48, 110)
      } else if (paint === 'overlay') {
        target.fillStyle = '#ea5f8acc'
        target.beginPath()
        target.arc(
          width / 2,
          height / 2,
          Math.min(width, height) * 0.42,
          0,
          Math.PI * 2,
        )
        target.fill()
        target.fillStyle = '#ffdf77dd'
        target.fillRect(width * 0.18, height * 0.4, width * 0.64, height * 0.2)
      } else if (paint === 'peer') {
        target.fillStyle = '#2e8b57'
        target.fillRect(0, 0, width, height)
        target.fillStyle = '#ffffff'
        target.font = '600 40px sans-serif'
        target.fillText('peer edit', 24, height / 2)
      } else {
        const gradient = target.createLinearGradient(0, 0, width, 0)
        gradient.addColorStop(0, '#000')
        gradient.addColorStop(1, '#fff')
        target.fillStyle = gradient
        target.fillRect(0, 0, width, height)
      }
      const response = await fetch(canvas.toDataURL('image/png'))
      return [...new Uint8Array(await response.arrayBuffer())]
    },
    { width, height, paint },
  )
  return { name, mimeType: 'image/png', buffer: Buffer.from(bytes) }
}

async function createImageDocument(
  page: Page,
  file: Awaited<ReturnType<typeof rasterFile>>,
) {
  const workspace = page.getByTestId('image-document-workspace')
  await workspace
    .locator('.image-document-tabs input[type=file]')
    .setInputFiles(file)
  await expect(page.getByTestId('image-document-editor')).toBeVisible()
  const tabId = await page
    .locator('.tab[data-tab-id^="image:"]')
    .getAttribute('data-tab-id')
  expect(tabId).toBeTruthy()
  return { workspace, tabId: tabId! }
}

async function createVideoDocument(page: Page) {
  await page.getByTestId('new-video-tab').click()
  const workspace = page.getByTestId('video-document-workspace')
  await expect(workspace).toBeVisible()
  const tabId = await page
    .locator('.tab[data-tab-id^="video:"]')
    .getAttribute('data-tab-id')
  expect(tabId).toBeTruthy()
  return { workspace, tabId: tabId! }
}

/** A client may hold several video documents; only the active panel is on screen. */
const activeVideoPanel = (page: Page) =>
  page
    .getByTestId('video-document-workspace')
    .locator('.video-document-panel:not([hidden])')

const activeVideoJson = (page: Page) =>
  activeVideoPanel(page).getByTestId('video-document-json')

async function setSessionStatus(page: Page, tabId: string): Promise<string> {
  return page.evaluate((id) => {
    const app = (window as unknown as { __dinksterTest?: { app?: TestApp } })
      .__dinksterTest!.app!
    return app.collabFor(id)?.session.status.get() ?? 'missing'
  }, tabId)
}

async function viewportX(page: Page): Promise<number> {
  return page.evaluate(() => {
    const renderer = (
      window as unknown as {
        __dinksterTest?: { renderer?: { getViewport(): { x: number } } }
      }
    ).__dinksterTest!.renderer!
    return renderer.getViewport().x
  })
}

async function setViewport(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ x, y }) => {
      const renderer = (
        window as unknown as {
          __dinksterTest?: {
            renderer?: {
              setViewport(v: { x: number; y: number; scale: number }): void
            }
          }
        }
      ).__dinksterTest!.renderer!
      renderer.setViewport({ x, y, scale: 1 })
    },
    { x, y },
  )
}

test('two clients share image and video documents through the one document pipeline', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const ownerContext = await browser.newContext()
  const peerContext = await browser.newContext()
  const owner = await ownerContext.newPage()
  const peer = await peerContext.newPage()
  let documentIds: string[] = []
  try {
    mkdirSync(proofDir(), { recursive: true })
    let backendReady = false
    try {
      backendReady = (
        await fetch(`${BACKEND}/api/nodes`, {
          signal: AbortSignal.timeout(2000),
        })
      ).ok
    } catch {
      /* unreachable */
    }
    test.skip(
      !backendReady,
      `no native Dinkster backend reachable at ${BACKEND} (set DINKSTER_NATIVE_BACKEND)`,
    )

    await Promise.all([owner.goto('/'), peer.goto('/')])
    await Promise.all([owner, peer].map(waitForApp))
    await Promise.all([owner, peer].map(waitForBackend))

    // -- Owner creates one document of each kind -------------------------
    const workflowTabId = await owner
      .getByRole('tab')
      .first()
      .evaluate((tab) => tab.closest('.tab')?.getAttribute('data-tab-id') ?? '')
    expect(workflowTabId).toBeTruthy()

    const ownerImage = await createImageDocument(
      owner,
      await rasterFile(owner, 'coastline.png', 900, 560, 'base'),
    )
    const ownerVideo = await createVideoDocument(owner)
    const ownerVideoJson = activeVideoJson(owner)
    const authored = JSON.parse(await ownerVideoJson.inputValue()) as {
      settings: { width: number; height: number; rate: number }
    }
    authored.settings.width = 1920
    await ownerVideoJson.fill(JSON.stringify(authored, null, 2))
    await ownerVideo.workspace.getByRole('button', { name: 'Apply' }).click()
    await expect(ownerVideoJson).toHaveValue(/1920/)
    documentIds = [
      ownerImage.tabId.slice('image:'.length),
      ownerVideo.tabId.slice('video:'.length),
      workflowTabId!,
    ]

    // -- Owner shares all three kinds; the tab strip stays mixed ---------
    await clickTab(owner, ownerImage.tabId)
    await ownerImage.workspace.getByTestId('image-collab-share').click()
    await expect(
      ownerImage.workspace.getByTestId('image-collab-leave'),
    ).toBeVisible()

    await clickTab(owner, ownerVideo.tabId)
    await ownerVideo.workspace
      .getByRole('button', { name: 'Share', exact: true })
      .click()
    await expect(
      ownerVideo.workspace.getByRole('button', { name: 'Share', exact: true }),
    ).toBeDisabled()

    await clickTab(owner, workflowTabId!)
    const shared = await owner.evaluate(async (tabId) => {
      const app = (window as unknown as { __dinksterTest?: { app?: TestApp } })
        .__dinksterTest!.app!
      await app.activeTab().store.settle()
      const error = await app.shareActiveTab()
      return { error, sessionId: app.collabFor(tabId)?.descriptor.sessionId }
    }, workflowTabId!)
    expect(shared.error).toBeUndefined()
    expect(shared.sessionId).toBeTruthy()

    for (const kind of ['workflow', 'image', 'video'] as const) {
      await expect(owner.locator(`[data-document-kind="${kind}"]`)).toHaveCount(
        1,
      )
    }

    // -- Peer stands up local image/video tabs (activates both workspaces)
    await createImageDocument(
      peer,
      await rasterFile(peer, 'peer-local.png', 320, 200, 'peer'),
    )
    const peerLocalImageTabId = (await peer
      .locator('.tab[data-tab-id^="image:"]')
      .getAttribute('data-tab-id'))!
    await createVideoDocument(peer)
    const peerLocalVideoTabId = (await peer
      .locator('.tab[data-tab-id^="video:"]')
      .getAttribute('data-tab-id'))!

    // -- Peer joins the shared image session through the workspace -------
    const ownerImageLineage = ownerImage.tabId.slice('image:'.length)
    await clickTab(peer, peerLocalImageTabId)
    await peer.getByTestId('image-collab-browse').click()
    await expect(peer.locator('.image-document-collaboration')).toBeVisible()
    await peer
      .locator('.image-document-collaboration')
      .getByTestId('image-collab-join')
      .filter({ hasText: ownerImageLineage })
      .click()
    await expect(
      peer.locator(`.tab[data-tab-id="${ownerImage.tabId}"]`),
    ).toHaveCount(1)

    // -- Peer joins the shared video session through the workspace -------
    const ownerVideoLineage = ownerVideo.tabId.slice('video:'.length)
    await clickTab(peer, peerLocalVideoTabId)
    await peer
      .getByTestId('video-document-workspace')
      .getByRole('button', { name: 'Shared video documents' })
      .click()
    await expect(peer.locator('.video-document-shared-dialog')).toBeVisible()
    await peer
      .locator('.video-document-shared-dialog')
      .getByRole('button')
      .filter({ hasText: ownerVideoLineage })
      .click()
    await expect(
      peer.locator(`.tab[data-tab-id="${ownerVideo.tabId}"]`),
    ).toHaveCount(1)

    // -- Peer joins the shared workflow session ---------------------------
    const joinError = await peer.evaluate(async (sessionId) => {
      const app = (window as unknown as { __dinksterTest?: { app?: TestApp } })
        .__dinksterTest!.app!
      return app.joinCollabSession(sessionId!)
    }, shared.sessionId!)
    expect(joinError).toBeUndefined()

    for (const page of [owner, peer]) {
      for (const kind of ['workflow', 'image', 'video'] as const) {
        await expect(
          page.locator(`[data-document-kind="${kind}"]`).first(),
        ).toHaveCount(1)
      }
    }
    await clickTab(owner, workflowTabId!)
    // Late workspace activations can race the tab click; settle before
    // capturing the mixed tab strip so the strip shows the workflow tab active.
    await owner.waitForTimeout(1500)
    await expect(
      owner.locator(`.tab[data-tab-id="${workflowTabId}"] .tab-select`),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(owner.getByTestId('graph-canvas')).toBeVisible()
    await owner.screenshot({
      path: join(proofDir(), 'owner-mixed-shared-tabs.png'),
    })
    await peer.screenshot({
      path: join(proofDir(), 'peer-mixed-shared-tabs.png'),
    })

    // -- Owner drives the full image command surface on the shared image --
    await clickTab(owner, ownerImage.tabId)
    const panel = activeImagePanel(owner)

    // image.canvas.resize
    await panel.getByRole('spinbutton', { name: 'Resize width' }).fill('640')
    await panel.getByRole('spinbutton', { name: 'Resize height' }).fill('360')
    await panel.getByRole('button', { name: 'Apply resize' }).click()
    await expect(panel).toContainText('640 x 360')

    // image.canvas.crop
    await panel.getByRole('spinbutton', { name: 'Crop x' }).fill('10')
    await panel.getByRole('spinbutton', { name: 'Crop y' }).fill('10')
    await panel.getByRole('spinbutton', { name: 'Crop width' }).fill('300')
    await panel.getByRole('spinbutton', { name: 'Crop height' }).fill('200')
    await panel.getByRole('button', { name: 'Apply crop' }).click()
    await expect(panel).toContainText('300 x 200')

    // image.canvas.update (linear compositing)
    await panel
      .getByRole('checkbox', { name: 'Linear color compositing' })
      .click()

    // image.output.update
    await panel.getByRole('combobox', { name: 'Output format' }).click()
    await owner.getByRole('option', { name: 'WEBP', exact: true }).click()

    // image.layer.addRaster
    await panel.getByRole('button', { name: '+ Raster', exact: true }).click()
    await panel
      .locator('.image-document-layers input[type=file]')
      .setInputFiles(
        await rasterFile(owner, 'owner overlay.png', 420, 320, 'overlay'),
      )
    await expect(panel.locator('.image-document-layer-row')).toHaveCount(2)

    // image.layer.update (transform, blend, opacity)
    await panel
      .getByRole('spinbutton', { name: 'Layer transform X' })
      .fill('120')
    await panel
      .getByRole('spinbutton', { name: 'Layer transform X' })
      .press('Enter')
    await panel
      .getByRole('spinbutton', { name: 'Layer transform Y' })
      .fill('80')
    await panel
      .getByRole('spinbutton', { name: 'Layer transform Y' })
      .press('Enter')
    await panel.getByRole('combobox', { name: 'Layer blend mode' }).click()
    await owner.getByRole('option', { name: 'screen', exact: true }).click()
    await panel.getByRole('slider', { name: 'Layer opacity' }).press('Home')
    for (let step = 0; step < 5; step += 1) {
      await panel.getByRole('slider', { name: 'Layer opacity' }).press('PageUp')
    }

    // image.layer.move
    await panel.getByRole('button', { name: 'Lower', exact: true }).click()

    // image.layer.group
    await panel
      .getByRole('button', { name: /Wrap in group|Group with below/ })
      .click()
    await expect(panel).toContainText('Group')

    // image.mask.addRaster + image.mask.update + image.mask.remove
    await panel
      .locator('.image-document-layer-row')
      .filter({ hasText: 'owner overlay' })
      .first()
      .click()
    await panel.getByRole('button', { name: '+ Raster mask' }).click()
    await panel
      .locator('.image-document-properties input[type=file]')
      .setInputFiles(await rasterFile(owner, 'fade mask.png', 420, 320, 'mask'))
    await expect(panel.locator('.image-document-mask')).toHaveCount(1)
    await panel.getByRole('combobox', { name: 'Mask channel' }).click()
    await owner.getByRole('option', { name: 'luminance', exact: true }).click()
    await panel.getByRole('checkbox', { name: 'Invert mask' }).click()
    await panel.getByRole('button', { name: 'Remove mask' }).click()
    await expect(panel.locator('.image-document-mask')).toHaveCount(0)
    await panel.getByRole('button', { name: '+ Raster mask' }).click()
    await panel
      .locator('.image-document-properties input[type=file]')
      .setInputFiles(await rasterFile(owner, 'fade mask.png', 420, 320, 'mask'))
    await expect(panel.locator('.image-document-mask')).toHaveCount(1)
    await panel.getByRole('combobox', { name: 'Mask channel' }).click()
    await owner.getByRole('option', { name: 'luminance', exact: true }).click()

    // image.layer.remove (sacrificial layer)
    await panel.getByRole('button', { name: '+ Raster', exact: true }).click()
    await panel
      .locator('.image-document-layers input[type=file]')
      .setInputFiles(await rasterFile(owner, 'scratch.png', 64, 64, 'overlay'))
    await expect(panel.locator('.image-document-layer-row')).toHaveCount(4)
    await panel
      .locator('.image-document-layer-row')
      .filter({ hasText: 'scratch' })
      .first()
      .click()
    await panel.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(panel.locator('.image-document-layer-row')).toHaveCount(3)

    await owner.screenshot({
      path: join(proofDir(), 'owner-image-actions.png'),
    })

    // -- Owner -> peer convergence on the image document ------------------
    await clickTab(peer, ownerImage.tabId)
    const peerPanel = activeImagePanel(peer)
    await expect(peerPanel).toContainText('300 x 200')
    await expect(peerPanel.locator('.image-document-layer-row')).toHaveCount(3)
    await expect(peerPanel).toContainText('Raster mask')
    await peer.screenshot({
      path: join(proofDir(), 'peer-image-converged.png'),
    })
    await peerPanel.screenshot({
      path: join(proofDir(), 'peer-image-panel.png'),
    })

    // -- Peer -> owner convergence on the image document ------------------
    await peerPanel
      .getByRole('button', { name: '+ Raster', exact: true })
      .click()
    await peerPanel
      .locator('.image-document-layers input[type=file]')
      .setInputFiles(
        await rasterFile(peer, 'peer accent.png', 200, 140, 'peer'),
      )
    await expect(peerPanel.locator('.image-document-layer-row')).toHaveCount(4)
    await clickTab(owner, ownerImage.tabId)
    await expect
      .poll(async () => panel.locator('.image-document-layer-row').count())
      .toBe(4)
    await expect(panel).toContainText('peer accent')
    await owner.screenshot({
      path: join(proofDir(), 'owner-image-reverse-converged.png'),
    })

    // -- Video convergence both directions --------------------------------
    await clickTab(owner, ownerVideo.tabId)
    const ownerEdited = JSON.parse(
      await ownerVideoJson.inputValue(),
    ) as typeof authored
    ownerEdited.settings.height = 1080
    await ownerVideoJson.fill(JSON.stringify(ownerEdited, null, 2))
    await ownerVideo.workspace.getByRole('button', { name: 'Apply' }).click()

    await clickTab(peer, ownerVideo.tabId)
    const peerVideoJson = activeVideoJson(peer)
    await expect(peerVideoJson).toHaveValue(/1080/)

    const peerEdited = JSON.parse(
      await peerVideoJson.inputValue(),
    ) as typeof authored
    peerEdited.settings.width = 1280
    await peerVideoJson.fill(JSON.stringify(peerEdited, null, 2))
    await activeVideoPanel(peer).getByRole('button', { name: 'Apply' }).click()
    await clickTab(owner, ownerVideo.tabId)
    await expect(ownerVideoJson).toHaveValue(/1280/)
    await peer.screenshot({
      path: join(proofDir(), 'peer-video-converged.png'),
    })

    // -- Per-tab view state: independent viewports on the shared workflow --
    await clickTab(owner, workflowTabId!)
    await setViewport(peer, 333, 44)
    await setViewport(owner, 111, 22)
    await clickTab(owner, ownerImage.tabId)
    await clickTab(owner, workflowTabId!)
    expect(await viewportX(owner)).toBe(111)
    await clickTab(peer, ownerImage.tabId)
    await clickTab(peer, workflowTabId!)
    expect(await viewportX(peer)).toBe(333)

    // -- Reload: both clients rejoin the live sessions ---------------------
    await owner.reload()
    await waitForApp(owner)
    await expect(
      owner.locator(`.tab[data-tab-id="${workflowTabId}"]`),
    ).toHaveCount(1)
    await expect
      .poll(async () => setSessionStatus(owner, workflowTabId!))
      .toBe('live')
    await owner.screenshot({
      path: join(proofDir(), 'owner-after-reload.png'),
    })

    await peer.reload()
    await waitForApp(peer)
    await expect(
      peer.locator(`.tab[data-tab-id="${workflowTabId}"]`),
    ).toHaveCount(1)
    await expect
      .poll(async () => setSessionStatus(peer, workflowTabId!))
      .toBe('live')

    // -- Cross-client convergence still holds after both reloads ----------
    await clickTab(owner, ownerImage.tabId)
    await expect(ownerImage.workspace).toContainText('peer accent')
    await expect(
      ownerImage.workspace.locator('.image-document-layer-row'),
    ).toHaveCount(4)
    await clickTab(peer, ownerImage.tabId)
    await expect(peerPanel).toContainText('peer accent')
  } finally {
    // End every session this test created so the shared scope is not littered.
    try {
      await owner.waitForLoadState('domcontentloaded', { timeout: 5000 })
      const listed = await owner.evaluate(async () => {
        const response = await fetch('/api/sessions?scope=shared')
        return response.ok
          ? ((await response.json()) as {
              sessionId: string
              documentId: string
            }[])
          : []
      })
      const mine = new Set(documentIds)
      for (const session of listed) {
        if (mine.has(session.documentId)) {
          await owner.evaluate(async (id) => {
            await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
          }, session.sessionId)
        }
      }
    } catch {
      /* best effort */
    }
    await ownerContext.close()
    await peerContext.close()
  }
})

test('large viewport review of a shared image document converges cleanly', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const ownerContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  })
  const reviewerContext = await browser.newContext({
    viewport: { width: 1680, height: 1050 },
  })
  const owner = await ownerContext.newPage()
  const reviewer = await reviewerContext.newPage()
  let sessionId: string | undefined
  let imageLineage: string | undefined
  try {
    mkdirSync(proofDir(), { recursive: true })
    await Promise.all([owner.goto('/'), reviewer.goto('/')])
    await Promise.all([owner, reviewer].map(waitForApp))
    await Promise.all([owner, reviewer].map(waitForBackend))

    // Owner shares a plain image document: no blend, ordering, grouping, or
    // canvas color edits, so the browser preview stays authoritative and the
    // representative review screenshot shows a clean full-height workspace.
    const ownerImage = await createImageDocument(
      owner,
      await rasterFile(owner, 'review-shared.png', 900, 560, 'base'),
    )
    // A short document name keeps the shared tab title legible in the
    // reviewer's evidence screenshot instead of a truncated lineage id.
    await ownerImage.workspace
      .getByRole('textbox', { name: 'Image document name' })
      .fill('Review shared')
    await ownerImage.workspace.getByTestId('image-collab-share').click()
    await expect(
      ownerImage.workspace.getByTestId('image-collab-leave'),
    ).toBeVisible()
    const readSessionId = () =>
      owner.evaluate(async (lineage) => {
        const response = await fetch('/api/sessions?scope=shared')
        if (!response.ok) return undefined
        const listed = (await response.json()) as {
          sessions: { sessionId: string; documentId: string }[]
        }
        return listed.sessions.find((session) => session.documentId === lineage)
          ?.sessionId
      }, ownerImage.tabId.slice('image:'.length))
    await expect.poll(readSessionId, { timeout: 15_000 }).toBeTruthy()
    sessionId = await readSessionId()
    imageLineage = ownerImage.tabId.slice('image:'.length)
    expect(sessionId).toBeTruthy()

    // Add a raster mask on the owner so the reviewer's evidence shot shows the
    // converged mask state, not just a single base layer.
    await ownerImage.workspace
      .locator('.image-document-layer-row')
      .first()
      .click()
    await ownerImage.workspace
      .getByRole('button', { name: '+ Raster mask' })
      .click()
    await ownerImage.workspace
      .locator('.image-document-properties input[type=file]')
      .setInputFiles(
        await rasterFile(owner, 'review mask.png', 900, 560, 'mask'),
      )
    await expect(
      ownerImage.workspace.locator('.image-document-mask'),
    ).toHaveCount(1)

    // Reviewer joins at a large full-height viewport so layer rows, the mask
    // area, tab titles, and the preview are all legible in the evidence shot.
    await createImageDocument(
      reviewer,
      await rasterFile(reviewer, 'reviewer-local.png', 320, 200, 'peer'),
    )
    const reviewerLocalImageTabId = (await reviewer
      .locator('.tab[data-tab-id^="image:"]')
      .getAttribute('data-tab-id'))!
    await clickTab(reviewer, reviewerLocalImageTabId)
    await reviewer.getByTestId('image-collab-browse').click()
    await expect(
      reviewer.locator('.image-document-collaboration'),
    ).toBeVisible()
    await reviewer
      .locator('.image-document-collaboration')
      .getByTestId('image-collab-join')
      .filter({ hasText: ownerImage.tabId.slice('image:'.length) })
      .first()
      .click()
    await expect(
      reviewer.locator(`.tab[data-tab-id="${ownerImage.tabId}"]`),
    ).toHaveCount(1)
    await clickTab(reviewer, ownerImage.tabId)

    const reviewerPanel = activeImagePanel(reviewer)
    await expect(reviewerPanel).toContainText('900 x 560')
    await expect(
      reviewerPanel.locator('.image-document-layer-row'),
    ).toHaveCount(1)
    await expect(reviewerPanel.locator('.image-document-mask')).toHaveCount(1)
    await expect(reviewerPanel.locator('[role="alert"]')).toHaveCount(0)
    await reviewerPanel.getByTestId('image-document-preview').waitFor({
      state: 'visible',
    })

    await reviewer.screenshot({
      path: join(proofDir(), 'reviewer-image-convergence-large.png'),
      fullPage: true,
    })
    await reviewerPanel.screenshot({
      path: join(proofDir(), 'reviewer-image-panel-large.png'),
    })
    // The mask controls sit below the fold of the pane; capture the properties
    // region so the converged mask state is legible in the evidence set.
    const maskRow = reviewerPanel.locator('.image-document-mask')
    await maskRow.scrollIntoViewIfNeeded()
    await reviewerPanel
      .locator('.image-document-properties')
      .screenshot({ path: join(proofDir(), 'reviewer-image-mask-large.png') })

    // The owner sees the reviewer joined: both clients converge on one session.
    await clickTab(owner, ownerImage.tabId)
    await expect(
      activeImagePanel(owner).locator('.image-document-layer-row'),
    ).toHaveCount(1)
  } finally {
    try {
      if (sessionId !== undefined) {
        await owner.evaluate(async (id) => {
          await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
        }, sessionId!)
      } else if (imageLineage !== undefined) {
        await owner.evaluate(async (lineage) => {
          const response = await fetch('/api/sessions?scope=shared')
          if (!response.ok) return
          const listed = (await response.json()) as {
            sessions: { sessionId: string; documentId: string }[]
          }
          for (const session of listed.sessions) {
            if (session.documentId === lineage) {
              await fetch(`/api/sessions/${session.sessionId}`, {
                method: 'DELETE',
              })
            }
          }
        }, imageLineage)
      }
    } catch {
      /* best effort */
    }
    await ownerContext.close()
    await reviewerContext.close()
  }
})

import { expect, test as base, type BrowserContext, type WebSocketRoute } from '@playwright/test'
import { applyOps, type Json, type CollabClientOp, type CollabServerOp, type DocumentTypeAdapter } from '@dinkster/core'

const test = base.extend<{ otherContext: BrowserContext }>({
  otherContext: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({ baseURL: baseURL! })
    await use(context)
    await context.close()
  },
})

test('two image editors share edits and presence, while unknown kinds open read-only', async ({ otherContext, context, page }, testInfo) => {
  let snapshot: Json = null
  let snapshotRevision = 0
  let revision = 0
  let documentId = ''
  const operations: CollabServerOp[] = []
  const sockets = new Set<WebSocketRoute>()
  const extensionSockets = new Set<WebSocketRoute>()
  const resources = new Map<string, Buffer>()
  const descriptor = () => ({
    protocolVersion: 1, sessionId: 'shared-image', scope: 'shared', documentId,
    documentKind: 'dinkster.image', revision, snapshotRevision,
  })
  const unknown = { ...descriptor(), sessionId: 'unknown', documentId: 'Extension notes', documentKind: 'example.notes' }
  const contexts = [context, otherContext]
  for (const context of contexts) {
    await context.route('**/api/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const path = url.pathname
      if (path === '/api/nodes') return route.fulfill({ json: {
        schemaVersion: 1, epoch: 1, dinkster: { version: 'shared-document-test', schemaWire: 23 }, packs: {}, nodes: {},
      } })
      if (path === '/api/assets/media') {
        const digest = (await request.headerValue('x-dinkster-digest'))!
        const bytes = request.postDataBuffer()!
        resources.set(digest, bytes)
        return route.fulfill({ json: { kind: 'media/image', asset: {
          digest, name: 'canvas.png', size: bytes.byteLength, mediaType: 'image/png', virtualPath: 'input/canvas.png',
        } } })
      }
      if (path.startsWith('/api/assets/')) {
        const bytes = resources.get(decodeURIComponent(path.slice('/api/assets/'.length)))
        return bytes === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ body: bytes, contentType: 'image/png' })
      }
      if (path === '/api/sessions') {
        if (request.method() === 'POST') {
          const body = request.postDataJSON() as { documentId: string; snapshot: Json; documentKind: string }
          expect(body.documentKind).toBe('image')
          snapshot = body.snapshot
          documentId = body.documentId
          return route.fulfill({ status: 201, json: descriptor() })
        }
        return route.fulfill({ json: { sessions: [...(snapshot === null ? [] : [descriptor()]), unknown] } })
      }
      if (path === '/api/sessions/unknown/actors') return route.fulfill({ json: {} })
      if (path === '/api/sessions/unknown/snapshot') return route.fulfill({ json: { revision: 0, document: { title: 'Read-only extension document', text: 'No adapter installed. Nothing will be changed.' } } })
      if (path === '/api/sessions/unknown') return route.fulfill({ json: unknown })
      if (path === '/api/sessions/shared-image/actors') return route.fulfill({ json: {} })
      if (path === '/api/sessions/shared-image/snapshot') {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON() as { revision: number; document: Json }
          expect(body.revision).toBe(revision)
          snapshot = body.document
          snapshotRevision = revision
          return route.fulfill({ json: {} })
        }
        return route.fulfill({ json: { revision: snapshotRevision, document: snapshot } })
      }
      if (path === '/api/sessions/shared-image/ops') {
        if (request.method() === 'GET') return route.fulfill({ json: { ops: operations.filter((op) => op.revision > Number(url.searchParams.get('after'))) } })
        const submitted = request.postDataJSON() as CollabClientOp
        if (submitted.baseRevision !== revision) return route.fulfill({ status: 409, json: { error: 'stale-base', revision } })
        const op: CollabServerOp = { ...submitted, revision: ++revision, timestamp: Date.now() }
        operations.push(op)
        for (const socket of sockets) socket.send(JSON.stringify({ type: 'op', ...op }))
        return route.fulfill({ json: op })
      }
      if (path === '/api/sessions/shared-image') return route.fulfill({ json: descriptor() })
      return route.fulfill({ status: 404, json: { error: 'not-found' } })
    })
    await context.route('**/supervisor/**', (route) => route.fulfill({ status: 404 }))
    await context.routeWebSocket('**/*', (socket) => {
      if (new URL(socket.url()).pathname.endsWith('/unknown/events')) {
        extensionSockets.add(socket)
        socket.send(JSON.stringify({ type: 'session', ...unknown }))
        socket.onClose(() => { extensionSockets.delete(socket) })
        return
      }
      if (!new URL(socket.url()).pathname.endsWith('/shared-image/events')) return
      sockets.add(socket)
      socket.send(JSON.stringify({ type: 'session', ...descriptor() }))
      socket.onMessage((message) => {
        for (const peer of sockets) if (peer !== socket) peer.send(message)
      })
      socket.onClose(() => { sockets.delete(socket) })
    })
  }

  await page.goto('/')
  await page.waitForFunction(() => (window.__dinksterTest?.app as unknown as { collabBackend(): unknown })?.collabBackend() !== undefined)
  await page.getByTestId('image-documents-button').click()
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 600
    canvas.height = 360
    const paint = canvas.getContext('2d')!
    paint.fillStyle = '#254b75'
    paint.fillRect(0, 0, 600, 360)
    paint.fillStyle = '#f5d179'
    paint.font = '32px sans-serif'
    paint.fillText('A shared image document', 45, 180)
    return [...new Uint8Array(await (await fetch(canvas.toDataURL('image/png'))).arrayBuffer())]
  })
  const workspace = page.getByTestId('image-document-workspace')
  await workspace.locator('.image-document-tabs input[type=file]').setInputFiles({ name: 'canvas.png', mimeType: 'image/png', buffer: Buffer.from(bytes) })
  await workspace.getByTestId('image-collab-share').click()
  await expect(workspace.locator('.image-document-shared-status')).toHaveText('Shared')

  const second = await otherContext.newPage()
  await second.goto('/')
  await second.getByTestId('image-documents-button').click()
  const other = second.getByTestId('image-document-workspace')
  await other.getByTestId('image-collab-browse').click()
  await other.getByTestId('image-collab-join').click()
  await expect(other.locator('.image-document-shared-status')).toHaveText('Shared')
  await expect(workspace.getByTestId('collab-participant')).toHaveCount(1)
  await expect(other.getByTestId('collab-participant')).toHaveCount(1)
  await other.getByRole('textbox', { name: 'Name', exact: true }).fill('Shared foreground')
  await other.getByRole('textbox', { name: 'Name', exact: true }).press('Enter')
  await expect(workspace.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Shared foreground')
  await workspace.getByRole('slider', { name: 'Layer opacity' }).press('Home')
  await expect(other.getByRole('slider', { name: 'Layer opacity' })).toHaveAttribute('aria-valuenow', '0')
  await workspace.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(other.getByRole('slider', { name: 'Layer opacity' })).toHaveAttribute('aria-valuenow', '100')
  const canvas = other.getByTestId('image-document-preview')
  await canvas.hover({ position: { x: 100, y: 90 } })
  await expect(workspace.getByTestId('image-collab-cursor')).toBeVisible()
  const finalDocument = operations.filter((op) => op.revision > snapshotRevision)
    .reduce<Json>((document, op) => applyOps(document, op.patch), snapshot)
  expect(JSON.stringify(finalDocument)).toContain('Shared foreground')
  await workspace.screenshot({ path: testInfo.outputPath('image-participants.png'), animations: 'disabled' })
  await other.getByTestId('image-collab-leave').click()
  await expect(workspace.getByTestId('collab-participant')).toHaveCount(0)

  await workspace.getByRole('button', { name: 'Back to workflows' }).click()
  await page.getByTestId('collab-button').click()
  const panel = page.getByTestId('collab-panel')
  await panel.getByTestId('collab-join').click()
  await expect(panel.getByTestId('collab-read-only')).toContainText('No adapter installed')
  await expect(panel.getByTestId('collab-read-only').locator('input, textarea, [contenteditable]')).toHaveCount(0)
  await panel.screenshot({ path: testInfo.outputPath('unknown-document-read-only.png'), animations: 'disabled' })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      collabDocumentTypes: { register(adapter: DocumentTypeAdapter<{ title: string; text: string }>): unknown }
    }
    app.collabDocumentTypes.register({
      kind: 'example.notes', commandIds: new Set(),
      load: (value) => ({ document: value as { title: string; text: string }, diagnostics: [] }),
      check: () => [], execute: () => ({ ok: false, diagnostics: [] }),
    })
  })
  await panel.getByTestId('collab-join').click()
  await expect(panel.getByTestId('collab-read-only')).toContainText('Session: live')
  await expect(panel).not.toContainText('Join failed')
  for (const socket of extensionSockets) socket.send(JSON.stringify({
    type: 'op', protocolVersion: 1, opId: 'note-peer-edit', actorId: 'peer',
    baseRevision: 0, revision: 1, timestamp: Date.now(),
    patch: [{ op: 'replace', path: ['text'], value: 'A remote edit through the registered adapter.' }],
  }))
  await expect(panel.getByTestId('collab-read-only')).toContainText('A remote edit through the registered adapter.')
  await panel.screenshot({ path: testInfo.outputPath('registered-document-live.png'), animations: 'disabled' })
  await panel.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(panel.getByTestId('collab-read-only')).toHaveCount(0)
  await expect.poll(() => extensionSockets.size).toBe(0)
})

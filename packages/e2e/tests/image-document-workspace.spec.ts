import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_IMAGE_DOCUMENT_PROOF_DIR'] ??
  fileURLToPath(new URL('../../../docs/evidence/issue-310/', import.meta.url))
const localeProofDir = fileURLToPath(new URL('../../../docs/evidence/issue-457/', import.meta.url))

const nativeTable = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'image-document-e2e', schemaWire: 23 },
  packs: {},
  nodes: {},
}

async function rasterFile(
  page: Page,
  name: string,
  width: number,
  height: number,
  paint: 'base' | 'overlay' | 'mask',
) {
  const bytes = await page.evaluate(async ({ width, height, paint }) => {
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
      target.fillText('Durable ImageDocument', 48, 110)
      target.font = '28px sans-serif'
      target.fillText('Layered, recoverable, publishable', 50, 158)
    } else if (paint === 'overlay') {
      target.clearRect(0, 0, width, height)
      target.fillStyle = '#ea5f8acc'
      target.beginPath()
      target.arc(width / 2, height / 2, Math.min(width, height) * 0.42, 0, Math.PI * 2)
      target.fill()
      target.fillStyle = '#ffdf77dd'
      target.fillRect(width * 0.18, height * 0.4, width * 0.64, height * 0.2)
    } else {
      const gradient = target.createLinearGradient(0, 0, width, 0)
      gradient.addColorStop(0, '#000')
      gradient.addColorStop(1, '#fff')
      target.fillStyle = gradient
      target.fillRect(0, 0, width, height)
    }
    const response = await fetch(canvas.toDataURL('image/png'))
    return [...new Uint8Array(await response.arrayBuffer())]
  }, { width, height, paint })
  return { name, mimeType: 'image/png', buffer: Buffer.from(bytes) }
}

test('edits and recovers a durable layered image document', async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  await page.goto('/')
  const graphCanvas = page.getByTestId('graph-canvas')
  const graphLens = await graphCanvas.getAttribute('data-lens')
  await page.getByTestId('image-documents-button').click()
  const workspace = page.getByTestId('image-document-workspace')
  await expect(workspace).toContainText('No image documents are open')
  await expect(page.getByTestId('editor-split-region')).toBeAttached()
  await expect(page.getByTestId('editor-split-region')).toBeHidden()
  await workspace.getByRole('button', { name: 'New from image' }).focus()
  await page.keyboard.press('d')
  await expect(graphCanvas).toHaveAttribute('data-lens', graphLens!)

  await workspace.locator('.image-document-tabs input[type=file]').setInputFiles(
    await rasterFile(page, 'coastline.png', 900, 560, 'base'),
  )
  await expect(page.getByTestId('image-document-editor')).toBeVisible()
  await expect(workspace).toContainText('900 x 560')

  await workspace.getByRole('button', { name: '+ Raster', exact: true }).click()
  await workspace.locator('.image-document-layers input[type=file]').setInputFiles(
    await rasterFile(page, 'color accent.png', 420, 320, 'overlay'),
  )
  await expect(workspace.locator('.image-document-layer-row')).toHaveCount(2)
  await workspace.getByRole('spinbutton', { name: 'Layer transform X' }).fill('250')
  await workspace.getByRole('spinbutton', { name: 'Layer transform X' }).press('Enter')
  await workspace.getByRole('spinbutton', { name: 'Layer transform Y' }).fill('150')
  await workspace.getByRole('spinbutton', { name: 'Layer transform Y' }).press('Enter')
  await workspace.getByRole('combobox', { name: 'Layer blend mode' }).click()
  await page.getByRole('option', { name: 'screen', exact: true }).click()
  await workspace.getByRole('slider', { name: 'Layer opacity' }).press('Home')
  for (let step = 0; step < 7; step += 1) {
    await workspace.getByRole('slider', { name: 'Layer opacity' }).press('PageUp')
  }

  await workspace.getByRole('button', { name: '+ Raster mask' }).click()
  await workspace.locator('.image-document-properties input[type=file]').setInputFiles(
    await rasterFile(page, 'fade mask.png', 420, 320, 'mask'),
  )
  await expect(workspace).toContainText('Raster mask')
  await workspace.getByRole('combobox', { name: 'Mask channel' }).click()
  await page.getByRole('option', { name: 'luminance', exact: true }).click()
  await expect(workspace).not.toContainText('Preview failed')
  await workspace.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByTestId('status-bar')).toContainText('Saved image draft')
  await workspace.screenshot({ path: `${proofDir}/image-document-workspace.png`, animations: 'disabled' })
  await workspace.getByRole('button', { name: 'Back to workflows' }).click()
  await expect(workspace).toBeHidden()
  await expect(page.getByTestId('editor-split-region')).toBeVisible()
  await page.getByTestId('image-documents-button').click()
  await expect(workspace).toBeVisible()
  await expect(workspace.locator('.image-document-layer-row')).toHaveCount(2)

  await page.reload()
  await page.getByTestId('image-documents-button').click()
  await expect(page.getByTestId('image-document-workspace')).toContainText('color accent')
  await expect(page.getByTestId('image-document-workspace').locator('.image-document-layer-row')).toHaveCount(2)
  await expect(page.getByTestId('image-document-workspace')).toContainText('Raster mask')
})

test('renders the current ImageDocument and changes mounted editor chrome locale', async ({ page, request }) => {
  mkdirSync(proofDir, { recursive: true })
  mkdirSync(localeProofDir, { recursive: true })
  await page.setViewportSize({ width: 1600, height: 1400 })
  let outputDigest = ''
  let assetRequests = 0
  const cacheKey = 'blake3:' + 'e'.repeat(64)
  let outputBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let adoptedDependencies: readonly object[] = []
  await page.route('/api/nodes*', (route) => route.fulfill({ json: nativeTable }))
  await page.route(/\/api\/assets(?:\/.*)?(?:\?.*)?$/, async (route) => {
    assetRequests += 1
    const request = route.request()
    const url = new URL(request.url())
    const path = decodeURIComponent(url.pathname)
    if (path === '/api/assets/media' && request.method() === 'POST') {
      const digest = await request.headerValue('x-dinkster-digest')
      expect(digest).not.toBeNull()
      outputDigest = digest!
      outputBytes = request.postDataBuffer() ?? Buffer.alloc(0)
      const name = url.searchParams.get('name') ?? 'image.png'
      await route.fulfill({
        status: 201,
        json: {
          kind: 'media/image',
          asset: {
            digest,
            name,
            size: request.postDataBuffer()?.byteLength ?? 0,
            mediaType: 'image/png',
            virtualPath: `input/${name}`,
          },
        },
      })
      return
    }
    if (path === '/api/assets/image-document' && request.method() === 'POST') {
      const digest = await request.headerValue('x-dinkster-digest')
      const document = request.postDataJSON() as {
        resources: Record<string, {
          id: string
          digest: string
          byteSize: number
          mediaType: string
          width: number
          height: number
          colorSpace: string
          channelDepth: number
          alphaMode: string
        }>
      }
      const dependencies = Object.values(document.resources).map((resource) => ({
        resourceId: resource.id,
        digest: resource.digest,
        byteSize: resource.byteSize,
        mediaType: resource.mediaType,
        width: resource.width,
        height: resource.height,
        colorSpace: resource.colorSpace,
        channelDepth: resource.channelDepth,
        alphaMode: resource.alphaMode,
      }))
      adoptedDependencies = dependencies
      await route.fulfill({
        status: 201,
        json: {
          digest,
          mediaType: 'application/vnd.dinkster.image-document+json',
          byteSize: request.postDataBuffer()?.byteLength ?? 0,
          dependencies,
        },
      })
      return
    }
    if (path.endsWith('/render') && request.method() === 'POST') {
      const documentDigest = path.split('/').at(-2)!
      const body = request.postDataJSON() as { selector: string; profile: string }
      const provenance = {
        documentDigest,
        selector: body.selector,
        profile: body.profile,
        rendererContract: '2;pillow=12.1.1;jpeg=9.0;webp=1.6.0',
        encoding: 'image/png;dinkster-canonical=1',
        source: {
          digest: documentDigest,
          mediaType: 'application/vnd.dinkster.image-document+json',
          dependencies: adoptedDependencies,
        },
        output: {
          digest: outputDigest,
          byteSize: outputBytes.byteLength,
          mediaType: 'image/png',
          width: 900,
          height: 560,
          encoding: 'image/png;dinkster-canonical=1',
        },
      }
      const asset = {
        digest: outputDigest,
        name: 'image-document-render.png',
        size: outputBytes.byteLength,
        mediaType: 'image/png',
        virtualPath: '',
      }
      await route.fulfill({ status: 201, json: { cacheKey, cached: false, asset, provenance } })
      return
    }
    if (path === `/api/assets/${outputDigest}` && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'image/png', body: outputBytes })
      return
    }
    await route.abort()
  })

  await page.goto('/')
  await page.waitForFunction(() => {
    const app = window.__dinksterTest?.app as unknown as {
      libraryBackend(): { protocol?: string } | undefined
    } | undefined
    return app?.libraryBackend()?.protocol === 'dinkster'
  })
  const source = await rasterFile(page, 'authoritative-source.png', 900, 560, 'base')
  outputBytes = source.buffer
  await page.getByTestId('image-documents-button').click()
  const workspace = page.getByTestId('image-document-workspace')
  await workspace.locator('.image-document-tabs input[type=file]').setInputFiles(source)
  await expect(workspace.getByRole('combobox', { name: 'Authoritative render target' })).toBeVisible()
  const authoritativeRenderCompleted = page.waitForResponse((response) => {
    const request = response.request()
    return request.method() === 'POST' && new URL(response.url()).pathname.endsWith('/render') && response.status() === 201
  })
  await Promise.all([
    authoritativeRenderCompleted,
    workspace.getByRole('button', { name: 'Render', exact: true }).click(),
  ])
  const result = workspace.getByTestId('authoritative-image-document-render')
  await expect(result).toBeVisible()
  await expect(workspace).toContainText('Fresh render')
  await expect(result).toContainText('dinkster-image-document-v2-cpu-reference')
  await expect(result).toContainText(outputDigest)
  await expect(result.getByRole('link', { name: 'Download PNG' })).toHaveAttribute(
    'href',
    `/api/assets/${encodeURIComponent(outputDigest)}`,
  )
  await expect(result.getByRole('img', { name: 'Authoritative ImageDocument output' }))
    .toHaveJSProperty('naturalWidth', 900)
  await page.screenshot({ path: `${localeProofDir}/image-document-editor-i18n-en.png`, fullPage: true })
  const requestsBeforeLocale = assetRequests
  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'imageDocument.editor.action.addRaster': '[+ Rasterbild]',
      'imageDocument.editor.action.applyCrop': '[Zuschnitt anwenden]',
      'imageDocument.editor.action.applyResize': '[Grosse anwenden]',
      'imageDocument.editor.action.downloadPng': '[PNG herunterladen]',
      'imageDocument.editor.action.exportSnapshot': '[In Graph exportieren]',
      'imageDocument.editor.action.lower': '[Senken]',
      'imageDocument.editor.action.publish': '[Veroffentlichen]',
      'imageDocument.editor.action.raise': '[Anheben]',
      'imageDocument.editor.action.redo': '[Wiederholen]',
      'imageDocument.editor.action.remove': '[X]',
      'imageDocument.editor.action.render': '[Referenz rendern]',
      'imageDocument.editor.action.saveDraft': '[Entwurf speichern]',
      'imageDocument.editor.action.undo': '[Ruckgangig]',
      'imageDocument.editor.action.wrapGroup': '[In Gruppe]',
      'imageDocument.editor.aria.layerOpacity': '[Ebenendeckkraft]',
      'imageDocument.editor.aria.renderTarget': '[Referenz-Renderziel]',
      'imageDocument.editor.description.preview': '[Browser-Vorschau. Die Referenzausgabe unten ist verbindlich.]',
      'imageDocument.editor.description.quality': '[Qualitat gilt fur JPEG und WebP. PNG bleibt verlustfrei.]',
      'imageDocument.editor.field.blendMode': '[Mischmodus]',
      'imageDocument.editor.field.format': '[Format]',
      'imageDocument.editor.field.height': '[Hohe]',
      'imageDocument.editor.field.linearColor': '[Lineare Farbe]',
      'imageDocument.editor.field.name': '[Name]',
      'imageDocument.editor.field.opacity': '[Deckkraft]',
      'imageDocument.editor.field.quality': '[Qualitat]',
      'imageDocument.editor.field.visible': '[Sichtbar]',
      'imageDocument.editor.field.width': '[Breite]',
      'imageDocument.editor.field.x': '[X]',
      'imageDocument.editor.field.y': '[Y]',
      'imageDocument.editor.provenance.cacheKey': '[Cache]',
      'imageDocument.editor.provenance.output': '[Ausgabe]',
      'imageDocument.editor.provenance.outputDigest': '[Prufsumme]',
      'imageDocument.editor.provenance.profile': '[Profil]',
      'imageDocument.editor.provenance.renderer': '[Renderer]',
      'imageDocument.editor.provenance.source': '[Quelle]',
      'imageDocument.editor.provenance.target': '[Ziel]',
      'imageDocument.editor.status.freshRender': '[Neu]',
      'imageDocument.editor.status.on': '[AN]',
      'imageDocument.editor.target.composite': '[Vollstandiges Komposit]',
      'imageDocument.editor.title.authoritative': '[CPU-Referenz]',
      'imageDocument.editor.title.canvas': '[Leinwand]',
      'imageDocument.editor.title.crop': '[Zuschnitt]',
      'imageDocument.editor.title.layer': '[Ebene]',
      'imageDocument.editor.title.layers': '[Ebenen]',
      'imageDocument.editor.title.output': '[Ausgabe]',
      'imageDocument.editor.title.resize': '[Grosse]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(workspace).toContainText('[Ebenen]')
  await expect(workspace).toContainText('[CPU-Referenz]')
  await expect(workspace).toContainText('[Neu]')
  await expect(workspace).toContainText('[Prufsumme]')
  await expect(workspace.getByRole('combobox', { name: '[Referenz-Renderziel]' })).toContainText('[Vollstandiges Komposit]')
  await expect(workspace).toContainText('authoritative-source')
  await expect(result).toContainText(outputDigest)
  await expect(result).toContainText('dinkster-image-document-v2-cpu-reference')
  expect(assetRequests).toBe(requestsBeforeLocale)
  await page.screenshot({ path: `${localeProofDir}/image-document-editor-i18n-de-DE.png`, fullPage: true })
  await workspace.screenshot({
    path: `${proofDir}/image-document-authoritative-render.png`,
    animations: 'disabled',
  })

  await workspace.getByRole('slider', { name: '[Ebenendeckkraft]' }).press('Home')
  await expect(workspace).toContainText('Stale - render again')
})

test('shares an image document and confirms ending it for everyone', async ({ page, request }) => {
  mkdirSync(proofDir, { recursive: true })
  mkdirSync(localeProofDir, { recursive: true })
  await page.setViewportSize({ width: 1600, height: 950 })
  let sessionRequests = 0
  let snapshot: unknown
  const descriptor = {
    protocolVersion: 1,
    sessionId: 'image-document-e2e-session',
    scope: 'shared',
    documentId: 'image-document-e2e-collaboration',
    documentKind: 'image',
    revision: 0,
    snapshotRevision: 0,
    createdAt: 1,
  }
  await page.route('/api/nodes*', (route) => route.fulfill({ json: nativeTable }))
  await page.route('/api/assets/media*', async (route) => {
    const request = route.request()
    const digest = await request.headerValue('x-dinkster-digest')
    const url = new URL(request.url())
    const name = url.searchParams.get('name') ?? 'image.png'
    const size = request.postDataBuffer()?.byteLength ?? 0
    await route.fulfill({
      json: {
        kind: 'media/image',
        asset: { digest, name, size, mediaType: 'image/png', virtualPath: `input/${name}` },
      },
    })
  })
  await page.route('/api/sessions', async (route) => {
    sessionRequests += 1
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { snapshot: unknown; documentId: string }
      snapshot = body.snapshot
      descriptor.documentId = body.documentId
      await route.fulfill({ status: 201, json: descriptor })
    } else {
      await route.fulfill({ json: { sessions: [descriptor] } })
    }
  })
  await page.route('/api/sessions/*/snapshot', (route) => {
    sessionRequests += 1
    return route.fulfill({ json: { revision: 0, document: snapshot } })
  })
  await page.route('/api/sessions/*', (route) => {
    sessionRequests += 1
    return route.fulfill({ json: descriptor })
  })

  await page.goto('/')
  await page.waitForFunction(() => {
    const app = window.__dinksterTest?.app as unknown as {
      collabBackend(): { protocol?: string } | undefined
    } | undefined
    return app?.collabBackend()?.protocol === 'dinkster'
  })
  await page.getByTestId('image-documents-button').click()
  const workspace = page.getByTestId('image-document-workspace')
  await workspace.locator('.image-document-tabs input[type=file]').setInputFiles(
    await rasterFile(page, 'shared-canvas.png', 900, 560, 'base'),
  )
  await workspace.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(workspace.locator('.image-document-shared-status')).toHaveText('Shared')
  await workspace.getByRole('button', { name: 'End', exact: true }).click()
  await expect(workspace.getByRole('dialog', { name: 'End shared image session?' })).toBeVisible()
  await workspace.screenshot({
    path: `${proofDir}/image-document-collaboration-confirm.png`,
    animations: 'disabled',
  })
  await page.screenshot({ path: `${localeProofDir}/image-document-workspace-shell-en.png`, fullPage: true })
  const requestsBeforeLocale = sessionRequests

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'imageDocument.workspace.action.back': '[Zuruck zu Arbeitsablaufen]',
      'imageDocument.workspace.action.cancel': '[Abbrechen]',
      'imageDocument.workspace.action.end': '[Freigabe beenden]',
      'imageDocument.workspace.action.endSession': '[Geteilte Sitzung beenden]',
      'imageDocument.workspace.action.leave': '[Sitzung verlassen]',
      'imageDocument.workspace.action.newFromImage': '[Neues Bilddokument erstellen]',
      'imageDocument.workspace.action.openLibrary': '[Bildbibliothek offnen]',
      'imageDocument.workspace.action.sharedImages': '[Geteilte Bilder anzeigen]',
      'imageDocument.workspace.dialog.end.description': '[Alle Teilnehmer werden getrennt. Das aktuelle Bild bleibt als lokaler Entwurf erhalten.]',
      'imageDocument.workspace.dialog.end.title': '[Geteilte Bildsitzung beenden?]',
      'imageDocument.workspace.shared.live': '[Geteilt]',
      'imageDocument.workspace.tablist': '[Offene Bilddokumente]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(workspace.getByRole('tablist')).toHaveAttribute('aria-label', '[Offene Bilddokumente]')
  await expect(workspace.getByRole('button', { name: '[Freigabe beenden]', exact: true })).toBeVisible()
  await expect(workspace.locator('.image-document-shared-status')).toHaveText('[Geteilt]')
  await expect(workspace.getByRole('dialog', { name: '[Geteilte Bildsitzung beenden?]' })).toBeVisible()
  await expect(workspace.getByTestId('image-collab-end-confirm')).toHaveText('[Geteilte Sitzung beenden]')
  await expect(workspace.getByTestId('image-collab-end-cancel')).toHaveText('[Abbrechen]')
  await expect(workspace).toContainText('shared-canvas')
  expect(sessionRequests).toBe(requestsBeforeLocale)
  await page.screenshot({ path: `${localeProofDir}/image-document-workspace-shell-de-DE.png`, fullPage: true })
})

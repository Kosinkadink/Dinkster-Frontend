import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

const PROOF = 'test-results/latent-assets'

const emptyWorkflow = (lineage: string) => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage, root: 'g0',
  graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
  view: { graphs: { g0: { nodes: {} } } },
})

const STARTUP_CATALOG = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'latent-file-drop-proof', schemaWire: 1 },
  packs: {},
  nodes: {
    'dinkster.load_image': {
      schemaVersion: 1, nodeType: 'dinkster.load_image', displayName: 'Load Image', category: 'image',
      interface: [
        { role: 'input', id: 'image', required: true, type: { kind: 'asset', element: { kind: 'concrete', types: ['comfy.IMAGE'] } }, widget: { type: 'ASSET', accept: ['image/*'], kind: 'media/image' } },
        { role: 'output', id: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] } },
      ],
    },
    'dinkster.load_latent': {
      schemaVersion: 1, nodeType: 'dinkster.load_latent', displayName: 'Load Latent', category: 'latent',
      interface: [
        { role: 'input', id: 'latent', required: true, type: { kind: 'asset', element: { kind: 'concrete', types: ['comfy.LATENT'] } }, widget: { type: 'ASSET', accept: ['application/x-comfy-latent'], kind: 'data/latent' } },
        { role: 'output', id: 'samples', type: { kind: 'concrete', types: ['comfy.LATENT'] } },
        { role: 'output', id: 'vae_hint', type: { kind: 'concrete', types: ['core.string'] } },
      ],
    },
  },
}

async function dropBytes(page: Page, bytes: number[], name: string, type: string, extraTransferType = false): Promise<void> {
  await page.getByTestId('graph-canvas').evaluate((canvas, payload) => {
    const transfer = new DataTransfer()
    if (payload.extraTransferType) transfer.items.add('file:///ignored', 'text/uri-list')
    transfer.items.add(new File([Uint8Array.from(payload.bytes)], payload.name, { type: payload.type }))
    canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: 420, clientY: 320, dataTransfer: transfer }))
  }, { bytes, name, type, extraTransferType })
}

async function dragBytes(page: Page, bytes: number[], name: string, type: string): Promise<void> {
  await page.getByTestId('graph-canvas').evaluate((canvas, payload) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(payload.bytes)], payload.name, { type: payload.type }))
    canvas.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, clientX: 420, clientY: 320, dataTransfer: transfer }))
  }, { bytes, name, type })
}

async function dropDeferredBytes(page: Page, bytes: number[], name: string, type: string): Promise<void> {
  await page.getByTestId('graph-canvas').evaluate((canvas, payload) => {
    const transfer = new DataTransfer()
    const file = new File([Uint8Array.from(payload.bytes)], payload.name, { type: payload.type })
    const read = file.arrayBuffer.bind(file)
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => new Promise<ArrayBuffer>((resolve, reject) => {
        ;(window as unknown as { __resolveFileInspection: () => void }).__resolveFileInspection = () => {
          void read().then(resolve, reject)
        }
      }),
    })
    transfer.items.add(file)
    canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: 420, clientY: 320, dataTransfer: transfer }))
  }, { bytes, name, type })
}

async function leaveFileDrag(page: Page): Promise<void> {
  await page.getByTestId('graph-canvas').evaluate((canvas) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array([0])], 'leaving.bin'))
    canvas.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
}

async function closeRightRail(page: Page): Promise<void> {
  const toggle = page.getByTestId('rail-toggle')
  if (await toggle.getAttribute('aria-pressed') === 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
}

const pngChunk = (kind: string, data: Uint8Array): number[] => {
  const out = new Uint8Array(12 + data.length)
  new DataView(out.buffer).setUint32(0, data.length)
  out.set([...kind].map((value) => value.charCodeAt(0)), 4)
  out.set(data, 8)
  let crc = 0xffffffff
  for (const byte of out.subarray(4, 8 + data.length)) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  new DataView(out.buffer).setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0)
  return [...out]
}

const pngBytes = (workflow?: unknown): number[] => {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  const header = new Uint8Array(13); new DataView(header.buffer).setUint32(0, 1); new DataView(header.buffer).setUint32(4, 1); header[8] = 8; header[9] = 6
  return [
    ...signature,
    ...pngChunk('IHDR', header),
    ...(workflow === undefined ? [] : pngChunk('tEXt', new TextEncoder().encode(`workflow\0${JSON.stringify(workflow)}`))),
    ...pngChunk('IDAT', Uint8Array.from([0])),
    ...pngChunk('IEND', new Uint8Array()),
  ]
}

const latentBytes = (metadata: Record<string, string> = {}): number[] => {
  const body = [0, 0, 0, 0]
  const raw = new TextEncoder().encode(JSON.stringify({
    __metadata__: metadata,
    latent_tensor: { dtype: 'F32', shape: [1], data_offsets: [0, body.length] },
  }))
  const header = new Uint8Array(raw.length + (-raw.length & 7)); header.set(raw); header.fill(0x20, raw.length)
  const prefix = new Uint8Array(8)
  new DataView(prefix.buffer).setBigUint64(0, BigInt(header.length), true)
  return [...prefix, ...header, ...body]
}

const exponentShapeLatentBytes = (): number[] => {
  const bytes = latentBytes()
  const headerLength = Number(new DataView(Uint8Array.from(bytes.slice(0, 8)).buffer).getBigUint64(0, true))
  const header = new TextDecoder().decode(Uint8Array.from(bytes.slice(8, 8 + headerLength))).replace(/ +$/, '')
  const replacement = new TextEncoder().encode(header.replace('"shape":[1]', '"shape":[1e0]'))
  const raw = new Uint8Array(replacement.length + (-replacement.length & 7))
  raw.set(replacement)
  raw.fill(0x20, replacement.length)
  const prefix = new Uint8Array(8)
  new DataView(prefix.buffer).setBigUint64(0, BigInt(raw.length), true)
  return [...prefix, ...raw, ...bytes.slice(8 + headerLength)]
}

async function installImageDropBackend(page: Page, uploadDigest: string, deferred = false): Promise<void> {
  await page.evaluate(({ digest, deferred }) => {
    const app = window.__dinksterTest!.app
    const backend = (app as unknown as {
      backendForTab: (tab: unknown) => { protocol: string; connection: { uploadAsset?: (body: Blob) => Promise<string> } }
    }).backendForTab(app.activeTab()!)
    backend.protocol = 'dinkster'
    backend.connection.uploadAsset = deferred
      ? () => new Promise((resolve) => {
          ;(window as unknown as { __resolveFileDropUpload: () => void }).__resolveFileDropUpload = () => resolve(digest)
        })
      : async () => digest
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { digest: uploadDigest, deferred })
}

async function installLatentDropBackend(page: Page, deferred = false, ignoreAbort = false): Promise<void> {
  await page.evaluate(({ deferred, ignoreAbort }) => {
    const app = window.__dinksterTest!.app
    const backend = (app as unknown as {
      backendForTab: (tab: unknown) => { protocol: string; connection: { uploadLatentAsset?: (body: File, options: unknown) => Promise<unknown> } }
    }).backendForTab(app.activeTab()!)
    backend.protocol = 'dinkster'
    const state = window as unknown as { __latentUploads?: number; __latentSignalAborted?: boolean; __resolveLatentUpload?: () => void }
    state.__latentUploads = 0
    state.__latentSignalAborted = false
    const asset = {
      digest: `blake3:${'e'.repeat(64)}`, name: 'canonical.latent', size: 128,
      mediaType: 'application/x-comfy-latent', virtualPath: '',
    }
    backend.connection.uploadLatentAsset = async (_body, rawOptions) => {
      state.__latentUploads! += 1
      const signal = (rawOptions as { signal?: AbortSignal }).signal
      if (deferred) await new Promise<void>((resolve, reject) => {
        state.__resolveLatentUpload = resolve
        signal?.addEventListener('abort', () => {
          state.__latentSignalAborted = true
          if (!ignoreAbort) reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })
      return asset
    }
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { deferred, ignoreAbort })
}

test.beforeEach(async ({ page }) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'none' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: STARTUP_CATALOG }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('2 node schemas', { timeout: 15_000 })
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const registry = (app as unknown as {
      registryForTab: (tab: unknown) => { resolve: (type: string) => { items: readonly {
        kind: string; widget?: { widgetType: string; kind?: string }
      }[] } | undefined } | undefined
    }).registryForTab(app.activeTab()!)
    const loadImage = registry?.resolve('dinkster.load_image')
    const loadLatent = registry?.resolve('dinkster.load_latent')
    return (loadImage?.items.some((item) => item.kind === 'input' && item.widget?.widgetType === 'ASSET') ?? false) &&
      (loadLatent?.items.some((item) => item.kind === 'input' && item.widget?.kind === 'data/latent') ?? false)
  })).toBe(true)
})

test('JSON bytes import through the existing workflow ingress while script bytes preserve the document', async ({ page }) => {
  const workflow = emptyWorkflow('file-drop-json')
  await dropBytes(page, [...new TextEncoder().encode(JSON.stringify(workflow))], 'not-an-extension.bin', 'application/octet-stream', true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()?.id)).toBe('file-drop-json')
  const before = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
  await dropBytes(page, [...new TextEncoder().encode('<script>alert(1)</script>')], 'workflow.json', 'application/json')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get().some((problem) => problem.code === 'fileDrop.unsupported'))).toBe(true)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(before)
})

test('embedded PNG is keyboard-modal and Cancel leaves graph and history unchanged', async ({ page }) => {
  const workflow = emptyWorkflow('embedded-file-drop')
  const bytes = pngBytes(workflow)
  const before = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return { document: JSON.stringify(tab.store.doc), revision: tab.store.revision }
  })
  await dropBytes(page, bytes, 'embedded.png', 'text/html')
  const dialog = page.getByTestId('embedded-file-drop-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(dialog.getByRole('button', { name: 'Load image' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  expect(await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return { document: JSON.stringify(tab.store.doc), revision: tab.store.revision }
  })).toEqual(before)
})

test('plain image inserts one anonymous AssetRef batch at drop coordinates and undo removes it', async ({ page }) => {
  const digest = `blake3:${'a'.repeat(64)}`
  await installImageDropBackend(page, digest)
  await dropBytes(page, pngBytes(), 'private-local-name.png', 'text/html')
  await expect.poll(() => page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(document.graphs[document.root]!.nodes).length
  })).toBe(1)
  const inserted = await page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(document.graphs[document.root]!.nodes)[0]
  })
  expect(inserted).toMatchObject({ type: 'dinkster.load_image', values: { image: {
    digest, name: 'dropped-image.png', mediaType: 'image/png', virtualPath: '',
  } } })
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(document.graphs[document.root]!.nodes).length
  })).toBe(0)
})

test('embedded Load image consumes the choice without cancelling its own upload', async ({ page }) => {
  const digest = `blake3:${'b'.repeat(64)}`
  await installImageDropBackend(page, digest)
  await dropBytes(page, pngBytes(emptyWorkflow('ignored-embedded-workflow')), 'embedded.png', 'image/png')
  const dialog = page.getByTestId('embedded-file-drop-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Load image' }).click()
  await expect(dialog).not.toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(document.graphs[document.root]!.nodes).length
  })).toBe(1)
  expect(await page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(document.graphs[document.root]!.nodes)[0]
  })).toMatchObject({
    type: 'dinkster.load_image', values: { image: { digest, name: 'dropped-image.png' } },
  })
})

test('a modal opened during upload prevents the eventual graph mutation', async ({ page }) => {
  const digest = `blake3:${'c'.repeat(64)}`
  await installImageDropBackend(page, digest, true)
  await dropBytes(page, pngBytes(), 'plain.png', 'image/png')
  await expect.poll(() => page.evaluate(() =>
    typeof (window as unknown as { __resolveFileDropUpload?: unknown }).__resolveFileDropUpload)).toBe('function')
  await page.evaluate(() => {
    const dialog = document.createElement('dialog')
    dialog.dataset['modal'] = 'other-operation'
    dialog.setAttribute('aria-modal', 'true')
    dialog.dataset['testid'] = 'in-flight-external-modal'
    document.body.append(dialog)
    dialog.showModal()
    ;(window as unknown as { __resolveFileDropUpload: () => void }).__resolveFileDropUpload()
  })
  await page.waitForTimeout(50)
  expect(await page.evaluate(() => {
    const documentState = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(documentState.graphs[documentState.root]!.nodes).length
  })).toBe(0)
  await page.evaluate(() => document.querySelector('[data-testid="in-flight-external-modal"]')?.remove())
})

test('embedded Open workflow uses document import while malformed metadata fails closed', async ({ page }) => {
  const workflow = emptyWorkflow('embedded-opened')
  await dropBytes(page, pngBytes(workflow), 'workflow.svg', 'image/svg+xml')
  await page.getByTestId('embedded-file-drop-dialog').getByRole('button', { name: 'Open embedded workflow' }).click()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()?.id)).toBe('embedded-opened')
  const before = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
  const malformed = pngBytes(workflow); malformed[malformed.length - 1] = malformed[malformed.length - 1]! ^ 1
  await dropBytes(page, malformed, 'bad.png', 'image/png')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get().some((problem) => problem.code === 'fileDrop.invalidPngMetadata'))).toBe(true)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(before)
})

test('file drag presents a responsive, reduced-motion canvas target and clears on leave', async ({ page }) => {
  await mkdir(PROOF, { recursive: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await closeRightRail(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await dragBytes(page, latentBytes(), 'preview.latent', 'application/x-comfy-latent')

  const surface = page.getByTestId('canvas-file-drop-surface')
  await expect(surface).toHaveAttribute('data-state', 'drag')
  await expect(surface).toContainText('Drop file on canvas')
  await expect(surface).toContainText('workflow, image, or latent')
  expect(await surface.evaluate((element) => {
    const rect = element.querySelector('.canvas-file-drop-card')!.getBoundingClientRect()
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
  })).toBe(true)
  await page.screenshot({ path: `${PROOF}/latent-drag-390x844.png`, fullPage: true })

  await leaveFileDrag(page)
  await expect(surface).toHaveCount(0)
  await page.evaluate(() => {
    const dialog = document.createElement('dialog')
    dialog.dataset['modal'] = 'other-operation'
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
    dialog.showModal()
  })
  await dragBytes(page, latentBytes(), 'blocked.latent', 'application/x-comfy-latent')
  await expect(surface).toHaveAttribute('data-state', 'disabled')
  await expect(surface).toHaveAttribute('role', 'alert')
  await expect(surface).toContainText('Close the active modal operation')
  await leaveFileDrag(page)
  await page.evaluate(() => document.querySelector('[data-modal="other-operation"]')?.remove())

  const pendingWorkflow = emptyWorkflow('cancelled-file-inspection')
  await dropDeferredBytes(page, [...new TextEncoder().encode(JSON.stringify(pendingWorkflow))], 'pending.json', 'application/json')
  await expect(surface).toHaveAttribute('data-state', 'inspecting')
  await expect(surface).toHaveAttribute('aria-busy', 'true')
  await surface.getByRole('button', { name: 'Cancel' }).click()
  await expect(surface).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { __resolveFileInspection: () => void }).__resolveFileInspection())
  await page.waitForTimeout(50)
  await expect(surface).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.tabs.get().some((tab) => tab.id === 'cancelled-file-inspection'))).toBe(false)

  await page.setViewportSize({ width: 1366, height: 768 })
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  await dragBytes(page, latentBytes(), 'preview.latent', 'application/x-comfy-latent')
  await expect(surface).toHaveAttribute('data-state', 'drag')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: `${PROOF}/latent-drag-1366x768-zoom-200.png`, fullPage: true })
  await leaveFileDrag(page)
})

test('latent workflow metadata uses normal workflow recovery without upload or execution', async ({ page }) => {
  await installLatentDropBackend(page)
  const workflow = emptyWorkflow('latent-recovered-workflow')
  await dropBytes(page, latentBytes({ workflow: JSON.stringify(workflow) }), 'recovery.latent', 'application/octet-stream')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()?.id)).toBe('latent-recovered-workflow')
  expect(await page.evaluate(() => (window as unknown as { __latentUploads: number }).__latentUploads)).toBe(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)).toBe(0)
})

test('latent without a valid workflow uploads canonically and inserts Load Latent without auto-execution', async ({ page }) => {
  await mkdir(PROOF, { recursive: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1366, height: 768 })
  await closeRightRail(page)
  await installLatentDropBackend(page, true)
  const hint = JSON.stringify({ latentSpace: 'dinkster.test', sourceDigest: `blake3:${'f'.repeat(64)}`, sourceName: '<img src=x onerror=alert(1)>', version: 1 })
  await dropBytes(page, latentBytes({ workflow: '{"not":"a workflow"}', dinkster_vae_hint: hint }), 'private.safetensors', 'text/html')
  const surface = page.getByTestId('canvas-file-drop-surface')
  await expect(surface).toHaveAttribute('data-state', 'uploading')
  await expect(surface).toContainText('Adding latent')
  await expect(surface).toContainText('preparing Load Latent')
  await expect(surface.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  expect(await surface.locator('.canvas-file-drop-icon svg').evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  await page.screenshot({ path: `${PROOF}/latent-uploading-1366x768.png`, fullPage: true })
  await dropBytes(page, latentBytes(), 'second.latent', 'application/x-comfy-latent')
  await expect(surface).toHaveAttribute('data-state', 'uploading')
  expect(await page.evaluate(() => (window as unknown as { __latentUploads: number }).__latentUploads)).toBe(1)
  await page.evaluate(() => (window as unknown as { __resolveLatentUpload: () => void }).__resolveLatentUpload())
  await expect.poll(() => page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(document.graphs[document.root]!.nodes).length
  })).toBe(1)
  expect(await page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(document.graphs[document.root]!.nodes)[0]
  })).toMatchObject({ type: 'dinkster.load_latent', values: { latent: {
    digest: `blake3:${'e'.repeat(64)}`, name: 'canonical.latent', size: 128,
    mediaType: 'application/x-comfy-latent', virtualPath: '',
  } } })
  await expect(surface).toHaveAttribute('data-state', 'success')
  await expect(surface).toContainText('Latent added')
  await expect(surface).toContainText('Load Latent was inserted without running the workflow')
  await expect(surface).toContainText('VAE source')
  await expect(surface).toContainText('<img src=x onerror=alert(1)>')
  await expect(surface).toContainText('Latent space')
  await expect(surface).toContainText('dinkster.test')
  expect(await page.locator('img[src="x"]').count()).toBe(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)).toBe(0)
  const dismiss = surface.getByRole('button', { name: 'Dismiss Latent added' })
  await dismiss.focus()
  await expect(dismiss).toBeFocused()
  await page.waitForTimeout(8_100)
  await expect(surface).toHaveAttribute('data-state', 'success')
  await expect(dismiss).toBeFocused()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      problems: { set: (problems: readonly unknown[]) => void }
      transientStatus: { set: (status: string | undefined) => void }
    }
    app.problems.set([])
    app.transientStatus.set(undefined)
  })

  await page.setViewportSize({ width: 390, height: 844 })
  expect(await surface.evaluate((element) => {
    const rect = element.querySelector('.canvas-file-drop-card')!.getBoundingClientRect()
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
  })).toBe(true)
  await page.screenshot({ path: `${PROOF}/latent-added-390x844.png`, fullPage: true })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: `${PROOF}/latent-added-1366x768-zoom-200.png`, fullPage: true })

  await page.evaluate(() => { document.documentElement.style.zoom = '1' })
  await dismiss.click()
  await page.route('**/api/mounts', (route) => route.fulfill({ json: { mounts: [
    { id: 'latents', mode: 'read', state: 'ready', kind: 'data/latent', entryCount: 0 },
  ] } }))
  await page.route('**/api/mounts/latents/entries?*', (route) => route.fulfill({ json: { entries: [], total: 0 } }))
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes[0]!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'latent')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  const editor = page.getByTestId('asset-editor')
  await expect(editor).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Edit latent asset' })).toBeVisible()
  await expect(editor.getByTestId('asset-schema-metadata')).toContainText('Single latent')
  await expect(editor.getByTestId('asset-schema-metadata')).toContainText('data/latent')
  await expect(editor.getByTestId('asset-schema-metadata')).toContainText('1 GiB per file')
  await expect(editor.getByRole('region', { name: 'Latents' })).toBeVisible()
  await expect(editor.getByTestId('collection-search')).toHaveAttribute('aria-label', 'Search latents')
  await expect(editor).toContainText('No latents yet')
  await page.screenshot({ path: `${PROOF}/load-latent-picker-1366x768-empty.png`, fullPage: true })
})

test('malformed latent and cancelled upload create neither an asset request nor a node', async ({ page }) => {
  await mkdir(PROOF, { recursive: true })
  await installLatentDropBackend(page)
  const malformed = latentBytes(); malformed[0] = 0xff; malformed[1] = 0xff
  await dropBytes(page, malformed, 'bad.latent', 'application/x-comfy-latent')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get().some((problem) => problem.code === 'fileDrop.invalidLatent'))).toBe(true)
  const surface = page.getByTestId('canvas-file-drop-surface')
  await expect(surface).toHaveAttribute('data-state', 'error')
  await expect(surface).toContainText('File could not be added')
  await expect(surface).toContainText('Latent header')
  await page.screenshot({ path: `${PROOF}/latent-refused-1440x900.png`, fullPage: true })
  expect(await page.evaluate(() => (window as unknown as { __latentUploads: number }).__latentUploads)).toBe(0)
  await dropBytes(page, exponentShapeLatentBytes(), 'numeric.latent', 'application/x-comfy-latent')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get().filter((problem) => problem.code === 'fileDrop.invalidLatent').length)).toBe(2)
  expect(await page.evaluate(() => (window as unknown as { __latentUploads: number }).__latentUploads)).toBe(0)
  expect(await page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(document.graphs[document.root]!.nodes).length
  })).toBe(0)

  await installLatentDropBackend(page, true, true)
  await dropBytes(page, latentBytes(), 'cancel.latent', 'application/x-comfy-latent')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __latentUploads: number }).__latentUploads)).toBe(1)
  await expect(surface).toHaveAttribute('data-state', 'uploading')
  await surface.getByRole('button', { name: 'Cancel' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __latentSignalAborted: boolean }).__latentSignalAborted)).toBe(true)
  await expect(surface).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { __resolveLatentUpload: () => void }).__resolveLatentUpload())
  await page.waitForTimeout(50)
  await expect(surface).toHaveCount(0)
  expect(await page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(document.graphs[document.root]!.nodes).length
  })).toBe(0)
})

test('pasted clipboard image inserts Load Image with the pasted asset name and undoes in one step', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const digest = `blake3:${'c'.repeat(64)}`
  await installImageDropBackend(page, digest)
  // Chromium sanitizes clipboard images by decoding them, so the blob must be
  // a genuinely decodable PNG; a canvas-rendered pixel satisfies that.
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    canvas.getContext('2d')!.fillRect(0, 0, 1, 1)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
    })
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })
  await page.mouse.move(420, 320)
  await page.keyboard.press('Control+v')
  await expect.poll(() => page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(document.graphs[document.root]!.nodes).length
  })).toBe(1)
  expect(await page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(document.graphs[document.root]!.nodes)[0]
  })).toMatchObject({ type: 'dinkster.load_image', values: { image: {
    digest, name: 'pasted-image.png', mediaType: 'image/png', virtualPath: '',
  } } })
  await expect(page.getByTestId('canvas-file-drop-surface')).toContainText('Image added')
  await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(document.graphs[document.root]!.nodes).length
  })).toBe(0)
})

test('a clipboard holding both external text and an image pastes the image, not the text', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const digest = `blake3:${'f'.repeat(64)}`
  await installImageDropBackend(page, digest)
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    canvas.getContext('2d')!.fillRect(0, 0, 1, 1)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
    })
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob(['external text, not a workflow envelope'], { type: 'text/plain' }),
      'image/png': blob,
    })])
  })
  await page.mouse.move(500, 300)
  await page.keyboard.press('Control+v')
  await expect.poll(() => page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(document.graphs[document.root]!.nodes).length
  })).toBe(1)
  expect(await page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(document.graphs[document.root]!.nodes)[0]
  })).toMatchObject({ type: 'dinkster.load_image', values: { image: { digest, name: 'pasted-image.png' } } })
})

test('a clipboard image read that resolves after a tab switch does not paste', async ({ page }) => {
  const digest = `blake3:${'d'.repeat(64)}`
  await installImageDropBackend(page, digest)
  await page.evaluate(() => {
    const w = window as unknown as { __resolveClipboardRead?: (items: unknown[]) => void }
    const deferred = new Promise<unknown[]>((resolve) => { w.__resolveClipboardRead = resolve })
    Object.defineProperty(navigator.clipboard, 'read', { configurable: true, value: () => deferred })
  })
  await page.mouse.move(420, 320)
  await page.keyboard.press('Control+v')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      createWorkflow(): { id: string }
      activeTabId: { set(id: string): void }
    }
    app.activeTabId.set(app.createWorkflow().id)
  })
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    canvas.getContext('2d')!.fillRect(0, 0, 1, 1)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
    })
    const w = window as unknown as { __resolveClipboardRead?: (items: unknown[]) => void }
    w.__resolveClipboardRead!([{ types: ['image/png'], getType: async () => blob }])
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await expect(page.getByTestId('canvas-file-drop-surface')).toHaveCount(0)
  expect(await page.evaluate(() =>
    window.__dinksterTest!.app.tabs.get().reduce((total, tab) => {
      const document = tab.store.doc
      return total + Object.values(document.graphs).reduce((count, graph) => count + Object.keys(graph!.nodes).length, 0)
    }, 0),
  )).toBe(0)
})

test('an undecodable pasted blob reports paste wording, not drop wording', async ({ page }) => {
  const digest = `blake3:${'e'.repeat(64)}`
  await installImageDropBackend(page, digest)
  await page.evaluate(() => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })
    const items = [{ types: ['image/png'], getType: async () => blob }]
    Object.defineProperty(navigator.clipboard, 'read', { configurable: true, value: async () => items })
  })
  await page.mouse.move(420, 320)
  await page.keyboard.press('Control+v')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.problems.get().some((problem) => problem.code === 'fileDrop.unsupported'),
  )).toBe(true)
  await expect(page.getByTestId('canvas-file-drop-surface')).toContainText('Unsupported pasted image type')
  expect(await page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(document.graphs[document.root]!.nodes).length
  })).toBe(0)
})

test('same-tab graph navigation aborts a pending latent upload immediately and idempotently', async ({ page }) => {
  await installLatentDropBackend(page, true)
  await dropBytes(page, latentBytes(), 'navigate.latent', 'application/x-comfy-latent')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __latentUploads: number }).__latentUploads)).toBe(1)
  await expect(page.getByTestId('canvas-file-drop-surface')).toHaveAttribute('data-state', 'uploading')
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.graphStack.set(['g0', 'other'])
    tab.graphStack.set(['g0', 'another'])
  })
  expect(await page.evaluate(() => (window as unknown as { __latentSignalAborted: boolean }).__latentSignalAborted)).toBe(true)
  await expect(page.getByTestId('canvas-file-drop-surface')).toHaveCount(0)
  expect(await page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(document.graphs[document.root]!.nodes).length
  })).toBe(0)
})

/**
 * Widget representation proof against the native backend. This imports
 * the Playwright base directly because the shared fixture supplies a legacy
 * catalog and cannot establish the deployed schema contract.
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

async function textRow(page: Page): Promise<{
  x: number
  y: number
  representationId?: string
  height: number
}> {
  return page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'text')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    const representationId = (row as typeof row & { representationId?: string }).representationId
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
      ...(representationId === undefined ? {} : { representationId }),
      height: row.height,
    }
  })
}

async function resizePoint(page: Page): Promise<{
  x: number
  y: number
  nodeX: number
  nodeY: number
  width: number
  height: number
}> {
  return page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: canvas.left + (node.x + node.layout.width) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + node.layout.height) * viewport.scale + viewport.y,
      nodeX: node.x,
      nodeY: node.y,
      width: node.layout.width,
      height: node.layout.height,
    }
  })
}

const revision = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

test.beforeEach(async ({ page, request }) => {
  test.skip(process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_NATIVE_BACKEND so the Vite same-origin proxy targets the native backend')
  const direct = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(3000) })
  test.skip(!direct.ok, `native backend is unavailable at ${NATIVE_BACKEND}`)
  const sameOrigin = await request.get('/api/nodes')
  expect(sameOrigin.ok()).toBe(true)
  const payload = await sameOrigin.json() as {
    dinkster?: { schemaWire?: number }
    nodes?: Record<string, { interface?: unknown[] }>
  }
  expect(payload.dinkster?.schemaWire).toBe(1)
  expect(JSON.stringify(payload.nodes)).toContain('"type":"REPRESENTATIONS"')

  await page.route('/system_stats', (route) => void route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => void route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText('connected')
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'wire17-representations', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { clip: { id: 'clip', type: 'dinkster.clip_text_encode', values: { text: 'canonical text' } } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      } },
      view: { graphs: { g0: { nodes: { clip: { position: { x: 100, y: 100 } } } } } },
    }, 'Wire 17 Representations')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
})

test('schema default and user switch persist as view state without changing the value', async ({ page }) => {
  const initial = await textRow(page)
  expect(initial.representationId).toBe('multiline')

  await page.mouse.click(initial.x, initial.y, { button: 'right' })
  const representation = page.locator('[data-item-id="core.widget.representation"]')
  await expect(representation).toBeVisible()
  await representation.hover()
  const singleLine = page.locator('[data-item-id="core.widget.representation.single-line"]')
  const multiline = page.locator('[data-item-id="core.widget.representation.multiline"]')
  await expect(singleLine).toBeVisible()
  await expect(multiline).toHaveClass(/checked/)
  await singleLine.click()

  await expect.poll(() => textRow(page).then((row) => row.representationId)).toBe('single-line')
  const singlePoint = await textRow(page)
  await page.mouse.click(singlePoint.x, singlePoint.y)
  await expect(page.getByTestId('widget-editor').locator('input')).toBeVisible()
  await expect(page.getByTestId('widget-editor').locator('textarea')).toHaveCount(0)
  await page.keyboard.press('Escape')
  let state = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const view = tab.store.doc.view.graphs.g0!.nodes.clip as { views?: Record<string, string> }
    return {
      value: tab.store.doc.graphs.g0!.nodes.clip!.values.text,
      views: view.views,
    }
  })
  expect(state).toEqual({ value: 'canonical text', views: { text: 'single-line' } })

  await page.keyboard.press('Control+z')
  await expect.poll(() => textRow(page).then((row) => row.representationId)).toBe('multiline')
  const multilinePoint = await textRow(page)
  await page.mouse.click(multilinePoint.x, multilinePoint.y)
  await expect(page.getByTestId('widget-editor').locator('textarea')).toBeVisible()
  await expect(page.getByTestId('widget-editor').locator('input')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+y')
  await expect.poll(() => textRow(page).then((row) => row.representationId)).toBe('single-line')

  await page.evaluate(() => {
    const current = structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc)
    window.__dinksterTest!.app.openDocument(current, 'Wire 17 Reopened')
  })
  await expect.poll(() => textRow(page).then((row) => row.representationId)).toBe('single-line')
  state = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const view = tab.store.doc.view.graphs.g0!.nodes.clip as { views?: Record<string, string> }
    return {
      value: tab.store.doc.graphs.g0!.nodes.clip!.values.text,
      views: view.views,
    }
  })
  expect(state).toEqual({ value: 'canonical text', views: { text: 'single-line' } })

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const registry = app.backends.get()[0]!.registry.get() as unknown as {
      resolve(type: string): {
        items: readonly {
          kind: string
          id: string
          widget?: {
            widgetType: string
            options: Readonly<Record<string, unknown>>
            representations?: {
              representations: readonly { id: string }[]
            }
          }
        }[]
      } | undefined
    }
    const original = registry.resolve('dinkster.clip_text_encode')!
    ;(window as typeof window & { __wire17OriginalSchema?: typeof original }).__wire17OriginalSchema = original
    app.registerSchemas([{
      ...original,
      items: original.items.map((item) => item.kind === 'input' && item.id === 'text'
        ? {
            ...item,
            widget: {
              ...item.widget!,
              representations: {
                default: 'multiline',
                userSwitchable: true,
                representations: [{
                  id: 'multiline',
                  displayName: 'Multiline',
                  widget: {
                    ...item.widget!,
                    options: { ...item.widget!.options, multiline: true },
                  },
                }],
              },
            },
          }
        : item),
    }])
  })
  await expect.poll(() => textRow(page).then((row) => row.representationId)).toBe('multiline')
  expect(await page.evaluate(() => {
    const view = window.__dinksterTest!.app.activeTab()!.store.doc.view.graphs.g0!.nodes.clip as { views?: Record<string, string> }
    return view.views
  })).toEqual({ text: 'single-line' })
  await page.evaluate(() => {
    const original = (window as typeof window & { __wire17OriginalSchema?: unknown }).__wire17OriginalSchema
    window.__dinksterTest!.app.registerSchemas([original])
  })
  await expect.poll(() => textRow(page).then((row) => row.representationId)).toBe('single-line')

  let submitted: Record<string, unknown> | undefined
  await page.route('**/api/jobs', async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 202, json: { jobRef: 'wire17-representation-proof' } })
  })
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const current = structuredClone(app.activeTab()!.store.doc)
    current.graphs.g0!.nodes.source = {
      id: 'source',
      type: 'dinkster.load_checkpoint',
      values: {
        checkpoint: {
          digest: `blake3:${'0'.repeat(64)}`,
          name: 'wire17-proof.safetensors',
          size: 1,
          mediaType: 'application/octet-stream',
          virtualPath: 'checkpoints/wire17-proof.safetensors',
        },
      },
    }
    current.graphs.g0!.nodes.sink = { id: 'sink', type: 'dinkster.preview_any', values: {} }
    const links = current.graphs.g0!.links as Record<string, unknown>
    links['l_clip'] = {
      id: 'l_clip', from: { node: 'source', port: 'clip' }, to: { node: 'clip', port: 'clip' },
    }
    links['l_conditioning'] = {
      id: 'l_conditioning', from: { node: 'clip', port: 'conditioning' }, to: { node: 'sink', port: 'source' },
    }
    app.openDocument(current, 'Wire 17 Submission')
    await app.queue(app.activeTab()!)
  })
  expect(submitted).toBeDefined()
  const graph = submitted!['graph'] as {
    nodes: Record<string, { nodeType: string; inputs: Record<string, unknown> }>
  }
  expect(graph.nodes['clip']).toEqual({
    nodeType: 'dinkster.clip_text_encode',
    inputs: {
      text: 'canonical text',
      clip: { $link: { node: 'source', output: 'clip' } },
    },
  })
  expect(JSON.stringify(graph)).not.toContain('single-line')
})

test('multiline preview expands with node height while representation, editor, and job keep one value', async ({ page }) => {
  const value = 'first line\nsecond line\n\nfourth line\nfifth line\nsixth line'
  await page.evaluate((text) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: tab.store.doc.root, nodeId: 'clip', inputId: 'text', value: text },
    })
  }, value)

  const paintAt = async (width: number, height: number, attachment: string) => {
    const proof = await page.evaluate(({ width, height }) => {
      const test = window.__dinksterTest!
      const tab = test.app.activeTab()!
      tab.store.dispatch({
        command: 'view.setNodeSize',
        params: { graphId: tab.store.doc.root, nodeId: 'clip', size: { width, height } },
      })
      const calls: Array<{ text: string; y: number }> = []
      const prototype = CanvasRenderingContext2D.prototype
      const original = prototype.fillText
      prototype.fillText = function (text, x, y, maxWidth) {
        calls.push({ text, y })
        if (maxWidth === undefined) return original.call(this, text, x, y)
        return original.call(this, text, x, y, maxWidth)
      }
      try {
        ;(test.renderer! as unknown as { renderNow(): void }).renderNow()
      } finally {
        prototype.fillText = original
      }
      const node = test.renderer!.getScene().nodes.find((candidate) => candidate.id === 'clip')!
      const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'text')!
      const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const viewport = test.renderer!.getViewport()
      return {
        calls,
        rowHeight: row.height,
        nodeHeight: node.layout.height,
        clip: {
          x: canvas.left + (node.x - 8) * viewport.scale + viewport.x,
          y: canvas.top + (node.y - 8) * viewport.scale + viewport.y,
          width: (node.layout.width + 16) * viewport.scale,
          height: (node.layout.height + 16) * viewport.scale,
        },
      }
    }, { width, height })
    await test.info().attach(attachment, {
      body: await page.screenshot({ clip: proof.clip, animations: 'disabled' }),
      contentType: 'image/png',
    })
    return proof
  }

  const natural = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'text')!
    return { width: node.layout.width, height: node.layout.height, rowHeight: row.height }
  })
  expect(natural.rowHeight).toBe(74)
  const compact = await paintAt(natural.width, natural.height, 'multiline-natural')
  expect(compact.calls.map((call) => call.text)).toContain('first line')
  expect(compact.calls.map((call) => call.text)).toContain('second line')
  expect(compact.calls.map((call) => call.text)).not.toContain('fourth line')

  const taller = await paintAt(natural.width, natural.height + 96, 'multiline-taller')
  expect(taller.rowHeight).toBe(compact.rowHeight + 96)
  expect(taller.calls.map((call) => call.text)).toEqual(expect.arrayContaining(['fourth line', 'fifth line', 'sixth line']))
  const secondLineY = taller.calls.find((call) => call.text === 'second line')!.y
  const fourthLineY = taller.calls.find((call) => call.text === 'fourth line')!.y
  expect(fourthLineY - secondLineY).toBe(40)
  const wider = await paintAt(natural.width + 240, natural.height + 96, 'multiline-wider')
  expect(wider.rowHeight).toBe(taller.rowHeight)
  expect(wider.calls.filter((call) => call.text === 'sixth line')).toHaveLength(1)

  const point = await textRow(page)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await page.locator('[data-item-id="core.widget.representation"]').hover()
  await page.locator('[data-item-id="core.widget.representation.single-line"]').click()
  await expect.poll(() => textRow(page).then((row) => row.representationId)).toBe('single-line')
  expect((await textRow(page)).height).toBe(24)

  const single = await textRow(page)
  await page.mouse.click(single.x, single.y, { button: 'right' })
  await page.locator('[data-item-id="core.widget.representation"]').hover()
  await page.locator('[data-item-id="core.widget.representation.multiline"]').click()
  await expect.poll(() => textRow(page).then((row) => row.representationId)).toBe('multiline')
  const multiline = await textRow(page)
  await page.mouse.click(multiline.x, multiline.y)
  await expect(page.getByTestId('widget-editor').locator('textarea')).toHaveValue(value)
  await page.keyboard.press('Escape')

  let submitted: Record<string, unknown> | undefined
  await page.route('**/api/jobs', async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 202, json: { jobRef: 'multiline-layout-proof' } })
  })
  const exportedValue = await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const exported = structuredClone(app.exportDocument(tab.id)!) as any
    const graph = exported.graphs.g0!
    graph.nodes.source = {
      id: 'source', type: 'dinkster.load_checkpoint', values: {
        checkpoint: {
          digest: `blake3:${'0'.repeat(64)}`, name: 'layout-proof.safetensors', size: 1,
          mediaType: 'application/octet-stream', virtualPath: 'checkpoints/layout-proof.safetensors',
        },
      },
    }
    graph.nodes.sink = { id: 'sink', type: 'dinkster.preview_any', values: {} }
    graph.links.l_clip = { id: 'l_clip', from: { node: 'source', port: 'clip' }, to: { node: 'clip', port: 'clip' } }
    graph.links.l_conditioning = {
      id: 'l_conditioning', from: { node: 'clip', port: 'conditioning' }, to: { node: 'sink', port: 'source' },
    }
    graph.nextOrdinal += 2
    exported.view.graphs.g0!.nodes.source = { position: { x: 40, y: 300 } }
    exported.view.graphs.g0!.nodes.sink = { position: { x: 500, y: 300 } }
    app.openDocument(exported, 'Multiline Layout Reopened')
    const reopened = app.activeTab()!
    const compiled = app.compileTab(reopened)
    if (!compiled?.ok) throw new Error('reopened multiline document did not compile')
    await app.queue(reopened)
    return reopened.store.doc.graphs.g0!.nodes.clip!.values.text
  })
  expect(exportedValue).toBe(value)
  const graph = submitted?.['graph'] as { nodes?: Record<string, { inputs?: Record<string, unknown> }> } | undefined
  expect(graph?.nodes?.['clip']?.inputs?.['text']).toBe(value)
  expect(JSON.stringify(graph?.nodes?.['clip'])).not.toContain('representation')
  expect(JSON.stringify(graph?.nodes?.['clip'])).not.toContain('single-line')
})

test('multiline live resize paints the text bottom at every pointer frame without a release snap', async ({ page }) => {
  const value = Array.from({ length: 16 }, (_, index) => `line ${index + 1} with enough text to stay visible`).join('\n')
  await page.evaluate((text) => {
    const test = window.__dinksterTest!
    const tab = test.app.activeTab()!
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: tab.store.doc.root, nodeId: 'clip', inputId: 'text', value: text },
    })
    const original = CanvasRenderingContext2D.prototype.roundRect
    ;(window as typeof window & { __multilineRoundRect?: typeof original; __multilinePaintOps?: unknown[][] }).__multilineRoundRect = original
    ;(window as typeof window & { __multilinePaintOps?: unknown[][] }).__multilinePaintOps = []
    CanvasRenderingContext2D.prototype.roundRect = function (...args: Parameters<typeof original>) {
      ;(window as typeof window & { __multilinePaintOps?: unknown[][] }).__multilinePaintOps!.push(args)
      return original.apply(this, args)
    }
  }, value)

  const corner = await resizePoint(page)
  const startRevision = await revision(page)
  await page.mouse.move(corner.x, corner.y)
  await expect(page.getByTestId('graph-canvas')).toHaveCSS('cursor', 'nwse-resize')
  await page.mouse.down()

  const frames: Array<{ expectedBottom: number; previewHeight: number }> = []
  for (const delta of [24, 48, 72]) {
    await page.evaluate(() => {
      ;(window as typeof window & { __multilinePaintOps?: unknown[][] }).__multilinePaintOps = []
    })
    await page.mouse.move(corner.x + delta, corner.y + delta)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const frame = await page.evaluate(() => {
      const renderer = window.__dinksterTest!.renderer!
      const preview = (renderer.getOverlay() as unknown as {
        resizePreview?: { nodeId: string; x: number; y: number; width: number; height: number }
      }).resizePreview!
      const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'clip')!
      const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'text')!
      const projectedRowHeight = row.height + preview.height - node.layout.height
      return {
        preview,
        row: { y: row.y, height: row.height, inset: row.inset! },
        projectedRowHeight,
        expectedBottom: preview.y + row.y + projectedRowHeight,
        ops: (window as typeof window & { __multilinePaintOps?: unknown[][] }).__multilinePaintOps!,
      }
    })
    expect(frame.preview).toBeDefined()
    expect(frame.ops.some((args) =>
      args[0] === frame.preview.x + frame.row.inset &&
      args[1] === frame.preview.y + frame.row.y + 2 &&
      args[2] === frame.preview.width - frame.row.inset * 2 &&
      args[3] === frame.projectedRowHeight - 4,
    )).toBe(true)
    expect(frame.ops.some((args) =>
      args[0] === frame.preview.x + frame.row.inset &&
      args[1] === frame.preview.y + frame.row.y + 2 &&
      args[3] === frame.row.height - 4,
    )).toBe(false)
    expect(await revision(page)).toBe(startRevision)
    frames.push({ expectedBottom: frame.expectedBottom, previewHeight: frame.preview.height })
  }

  expect(frames[1]!.expectedBottom).toBeGreaterThan(frames[0]!.expectedBottom)
  expect(frames[2]!.expectedBottom).toBeGreaterThan(frames[1]!.expectedBottom)
  await page.mouse.up()
  expect(await revision(page)).toBe(startRevision + 1)
  const committed = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'text')!
    return { nodeHeight: node.layout.height, rowBottom: node.y + row.y + row.height }
  })
  expect(committed.nodeHeight).toBe(Math.round(frames[2]!.previewHeight))
  expect(committed.rowBottom).toBeCloseTo(frames[2]!.expectedBottom, 5)
})

test('natural two-line editor fits the painted content strip without overflow', async ({ page }) => {
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: tab.store.doc.root, nodeId: 'clip', inputId: 'text', value: 'first line\nsecond line' },
    })
  })
  const point = await textRow(page)
  expect(point.height).toBe(74)
  await page.mouse.click(point.x, point.y)
  const fit = await page.getByTestId('widget-editor').evaluate((element) => {
    const editor = element.getBoundingClientRect()
    const textarea = element.querySelector<HTMLTextAreaElement>('textarea')!
    const field = textarea.getBoundingClientRect()
    return {
      editorBottom: editor.bottom,
      fieldBottom: field.bottom,
      clientHeight: textarea.clientHeight,
      scrollHeight: textarea.scrollHeight,
    }
  })
  expect(Math.abs(fit.editorBottom - fit.fieldBottom - 2)).toBeLessThan(0.02)
  expect(fit.scrollHeight).toBe(fit.clientHeight)
})

test('in-node multiline editor tracks camera and keeps commit, cancel, and blur semantics exact', async ({ page }) => {
  const value = Array.from({ length: 14 }, (_, index) => `editor line ${index + 1}`).join('\n')
  await page.evaluate((text) => {
    const test = window.__dinksterTest!
    const tab = test.app.activeTab()!
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: tab.store.doc.root, nodeId: 'clip', inputId: 'text', value: text },
    })
    const node = test.renderer!.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    tab.store.dispatch({
      command: 'view.setNodeSize',
      params: { graphId: tab.store.doc.root, nodeId: 'clip', size: { width: 300, height: node.layout.minHeight + 96 } },
    })
  }, value)

  const point = await textRow(page)
  await page.mouse.click(point.x, point.y)
  const editor = page.getByTestId('widget-editor')
  const textarea = editor.locator('textarea')
  await expect(editor).toHaveAttribute('data-editor-surface', 'in-node')
  await expect(textarea).toBeFocused()

  const geometry = async () => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'text')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    const actual = document.querySelector('[data-editor-surface="in-node"]')!.getBoundingClientRect()
    return {
      actual: { left: actual.left, top: actual.top, width: actual.width, height: actual.height },
      expected: {
        left: canvas.left + (node.x + row.inset!) * viewport.scale + viewport.x,
        top: canvas.top + (node.y + row.y) * viewport.scale + viewport.y,
        width: (node.layout.width - row.inset! * 2) * viewport.scale,
        height: row.height * viewport.scale,
      },
    }
  })
  const initialGeometry = await geometry()
  expect(initialGeometry.actual).toEqual(initialGeometry.expected)
  const styles = await textarea.evaluate((element) => {
    const style = getComputedStyle(element)
    const scrollbar = getComputedStyle(element, '::-webkit-scrollbar')
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      resize: style.resize,
      outlineStyle: style.outlineStyle,
      borderTopWidth: style.borderTopWidth,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      scrollbarWidth: style.scrollbarWidth,
      webkitScrollbarWidth: scrollbar.width,
    }
  })
  expect(styles.fontFamily).toContain('system-ui')
  expect(styles.fontSize).toBe('14px')
  expect(styles.lineHeight).toBe('20px')
  expect(styles.resize).toBe('none')
  expect(styles.outlineStyle).toBe('none')
  expect(styles.borderTopWidth).toBe('0px')
  expect(styles.overflowX).toBe('hidden')
  expect(styles.overflowY).toBe('auto')
  expect(styles.scrollbarWidth).toBe('auto')
  expect(styles.webkitScrollbarWidth).toBe('6px')

  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 55, y: -20, scale: 1.4 }))
  await expect.poll(geometry).not.toEqual(initialGeometry)
  const movedGeometry = await geometry()
  for (const key of ['left', 'top', 'width', 'height'] as const) {
    expect(Math.abs(movedGeometry.actual[key] - movedGeometry.expected[key])).toBeLessThan(0.02)
  }
  await expect(textarea).toHaveCSS('font-size', '19.6px')
  await expect(textarea).toHaveCSS('line-height', '28px')

  const baselineValue = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.text)
  // Look-don't-touch editing closes without changing the value.
  await page.mouse.click(movedGeometry.actual.left - 10, movedGeometry.actual.top - 10)
  await expect(editor).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.text)).toBe(baselineValue)

  const commitPoint = await textRow(page)
  await page.mouse.click(commitPoint.x, commitPoint.y)
  await textarea.fill('ctrl commit\nvalue')
  await textarea.press('Control+Enter')
  await expect(editor).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.text)).toBe('ctrl commit\nvalue')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.text)).toBe(baselineValue)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.redo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.text)).toBe('ctrl commit\nvalue')

  const cancelPoint = await textRow(page)
  await page.mouse.click(cancelPoint.x, cancelPoint.y)
  await editor.locator('textarea').fill('escape must cancel')
  await page.keyboard.press('Escape')
  await expect(editor).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.text)).toBe('ctrl commit\nvalue')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.text)).toBe(baselineValue)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.redo())).toBe(true)

  const blurPoint = await textRow(page)
  await page.mouse.click(blurPoint.x, blurPoint.y)
  await editor.locator('textarea').fill('blur commit\nvalue')
  await page.mouse.click(movedGeometry.actual.left - 10, movedGeometry.actual.top - 10)
  await expect(editor).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.text)).toBe('blur commit\nvalue')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.text)).toBe('ctrl commit\nvalue')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.redo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.text)).toBe('blur commit\nvalue')
  await test.info().attach('multiline-in-node-editor', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
})

test('multiline preview and editor wrap long canonical lines with themed overflow', async ({ page }) => {
  const longLine = 'wrap0alpha wrap0beta wrap0gamma wrap0delta wrap0epsilon wrap0zeta wrap0eta wrap0theta'
  const value = [longLine, ...Array.from({ length: 13 }, (_, index) => `overflow line ${index + 1}`)].join('\n')
  const proof = await page.evaluate(({ value }) => {
    const test = window.__dinksterTest!
    const tab = test.app.activeTab()!
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: tab.store.doc.root, nodeId: 'clip', inputId: 'text', value },
    })
    const nodeBefore = test.renderer!.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    tab.store.dispatch({
      command: 'view.setNodeSize',
      params: { graphId: tab.store.doc.root, nodeId: 'clip', size: { width: 240, height: nodeBefore.layout.minHeight } },
    })
    const calls: { text: string; y: number }[] = []
    const prototype = CanvasRenderingContext2D.prototype
    const original = prototype.fillText
    prototype.fillText = function (text, x, y, maxWidth) {
      calls.push({ text, y })
      if (maxWidth === undefined) return original.call(this, text, x, y)
      return original.call(this, text, x, y, maxWidth)
    }
    try {
      ;(test.renderer! as unknown as { renderNow(): void }).renderNow()
    } finally {
      prototype.fillText = original
    }
    const node = test.renderer!.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'text')!
    return { calls, rowHeight: row.height, nodeMinHeight: node.layout.minHeight }
  }, { value })

  const firstLineCalls = proof.calls.filter((call) => call.text.includes('wrap0'))
  expect(firstLineCalls.length).toBeGreaterThan(1)
  expect(new Set(firstLineCalls.map((call) => call.y)).size).toBeGreaterThan(1)
  expect(proof.rowHeight).toBe(74)

  const point = await textRow(page)
  await page.mouse.click(point.x, point.y)
  const textarea = page.getByTestId('widget-editor').locator('textarea')
  await expect(textarea).toHaveValue(value)
  await expect(page.getByTestId('widget-editor')).toHaveAttribute('data-editor-surface', 'in-node')
  const editor = await textarea.evaluate((element) => {
    const style = getComputedStyle(element)
    const scrollbar = getComputedStyle(element, '::-webkit-scrollbar')
    const track = getComputedStyle(element, '::-webkit-scrollbar-track')
    const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb')
    const corner = getComputedStyle(element, '::-webkit-scrollbar-corner')
    const button = getComputedStyle(element, '::-webkit-scrollbar-button')
    return {
      whiteSpace: style.whiteSpace,
      overflowWrap: style.overflowWrap,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      resize: style.resize,
      outlineStyle: style.outlineStyle,
      lineHeight: style.lineHeight,
      scrollbarWidth: style.scrollbarWidth,
      scrollbarColor: style.scrollbarColor,
      webkitScrollbarWidth: scrollbar.width,
      webkitTrackBackground: track.backgroundColor,
      webkitThumbBackground: thumb.backgroundColor,
      webkitThumbMinHeight: thumb.minHeight,
      webkitCornerBackground: corner.backgroundColor,
      webkitButtonDisplay: button.display,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }
  })
  expect(editor.whiteSpace).toBe('pre-wrap')
  expect(editor.overflowWrap).toBe('anywhere')
  expect(editor.overflowX).toBe('hidden')
  expect(editor.overflowY).toBe('auto')
  expect(editor.resize).toBe('none')
  expect(editor.outlineStyle).toBe('none')
  expect(editor.lineHeight).toBe('20px')
  expect(editor.scrollHeight).toBeGreaterThan(editor.clientHeight)
  expect(editor.scrollWidth).toBeLessThanOrEqual(editor.clientWidth)
  expect(editor.scrollbarWidth).toBe('auto')
  expect(editor.scrollbarColor).toBe('auto')
  expect(editor.webkitScrollbarWidth).toBe('6px')
  expect(editor.webkitTrackBackground).toBe('rgb(24, 24, 24)')
  expect(['rgb(68, 68, 68)', 'rgb(85, 85, 85)']).toContain(editor.webkitThumbBackground)
  expect(editor.webkitThumbMinHeight).toBe('12px')
  expect(editor.webkitCornerBackground).toBe('rgb(24, 24, 24)')
  expect(editor.webkitButtonDisplay).toBe('none')
  await test.info().attach('multiline-wrap-editor', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
})

test('multiline painted and focused geometry shares one gutter across zoom and resize', async ({ page }) => {
  const proofDir = '/tmp/audit-ch-multiline-proof'
  mkdirSync(proofDir, { recursive: true })
  const value = Array.from({ length: 18 }, (_, index) =>
    `overflow line ${index + 1} keeps enough words to wrap at narrow widths`,
  ).join('\n')
  await page.evaluate((text) => {
    const test = window.__dinksterTest!
    const tab = test.app.activeTab()!
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: tab.store.doc.root, nodeId: 'clip', inputId: 'text', value: text },
    })
    const node = test.renderer!.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    tab.store.dispatch({
      command: 'view.setNodeSize',
      params: { graphId: tab.store.doc.root, nodeId: 'clip', size: { width: 280, height: node.layout.minHeight } },
    })
  }, value)

  const rowGeometry = () => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'text')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    const fieldWidth = node.layout.width - row.inset! * 2
    return {
      left: canvas.left + (node.x + row.inset!) * viewport.scale + viewport.x,
      top: canvas.top + (node.y + row.y) * viewport.scale + viewport.y,
      width: fieldWidth * viewport.scale,
      height: row.height * viewport.scale,
      scale: viewport.scale,
      contentWidth: (fieldWidth - 20) * viewport.scale,
      contentLeft: canvas.left + (node.x + row.inset! + 6) * viewport.scale + viewport.x,
      contentTop: canvas.top + (node.y + row.y + 2 + 18 + 6) * viewport.scale + viewport.y,
      scrollbarTop: canvas.top + (node.y + row.y + 2 + 18) * viewport.scale + viewport.y,
      scrollbarWorld: {
        x: node.x + row.inset! + fieldWidth - 2 - 6,
        y: node.y + row.y + 2 + 18,
      },
    }
  })

  const scrollbarPaint = () => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer! as unknown as { renderNow(): void }
    const calls: number[][] = []
    const prototype = CanvasRenderingContext2D.prototype
    const original = prototype.roundRect
    prototype.roundRect = function (...args) {
      calls.push(args.slice(0, 5).map(Number))
      return original.apply(this, args)
    }
    try {
      renderer.renderNow()
    } finally {
      prototype.roundRect = original
    }
    return calls
  })

  for (const scale of [0.75, 1, 1.5]) {
    await page.evaluate((nextScale) =>
      window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 10, scale: nextScale }), scale)
    const canvas = await page.getByTestId('graph-canvas').boundingBox()
    await page.mouse.move(canvas!.x + canvas!.width - 5, canvas!.y + canvas!.height - 5)
    const geometry = await rowGeometry()
    const idleCalls = await scrollbarPaint()
    expect(idleCalls.some((call) => call[2] === 6 && call[4] === 3)).toBe(false)
    await page.screenshot({ path: `${proofDir}/zoom-${scale}-idle.png`, animations: 'disabled' })

    await page.mouse.move(geometry.left + geometry.width / 2, geometry.top + geometry.height / 2)
    const hoverCalls = await scrollbarPaint()
    expect(hoverCalls).toContainEqual([
      geometry.scrollbarWorld.x,
      geometry.scrollbarWorld.y,
      6,
      geometry.height / geometry.scale - 2 - 2 - 18,
      3,
    ])
    await page.screenshot({ path: `${proofDir}/zoom-${scale}-hover.png`, animations: 'disabled' })

    await page.mouse.click(geometry.left + geometry.width / 2, geometry.top + geometry.height / 2)
    const textarea = page.getByTestId('widget-editor').locator('textarea')
    await expect(textarea).toBeVisible()
    const focused = await textarea.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const scrollbar = getComputedStyle(element, '::-webkit-scrollbar')
      const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb')
      const paddingLeft = Number.parseFloat(style.paddingLeft)
      const paddingRight = Number.parseFloat(style.paddingRight)
      return {
        contentLeft: rect.left + paddingLeft,
        contentTop: rect.top + Number.parseFloat(style.paddingTop),
        contentWidth: element.clientWidth - paddingLeft - paddingRight,
        scrollbarTop: rect.top,
        fontSize: Number.parseFloat(style.fontSize),
        lineHeight: Number.parseFloat(style.lineHeight),
        paddingLeft,
        scrollbarWidth: Number.parseFloat(scrollbar.width),
        thumbMinHeight: Number.parseFloat(thumb.minHeight),
      }
    })
    expect(Math.abs(focused.contentLeft - geometry.contentLeft)).toBeLessThan(0.6)
    expect(Math.abs(focused.contentTop - geometry.contentTop)).toBeLessThan(0.6)
    expect(Math.abs(focused.contentWidth - geometry.contentWidth)).toBeLessThan(1.1)
    expect(Math.abs(focused.scrollbarTop - geometry.scrollbarTop)).toBeLessThan(0.6)
    expect(focused.fontSize).toBeCloseTo(14 * scale, 5)
    expect(focused.lineHeight).toBeCloseTo(20 * scale, 5)
    expect(focused.paddingLeft).toBeCloseTo(6 * scale, 5)
    expect(focused.scrollbarWidth).toBeCloseTo(6 * scale, 5)
    expect(focused.thumbMinHeight).toBeCloseTo(12 * scale, 5)
    await textarea.evaluate((element) => { element.scrollTop = 0 })
    await page.screenshot({ path: `${proofDir}/zoom-${scale}-focused.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
  }

  await page.evaluate(() => {
    const test = window.__dinksterTest!
    const tab = test.app.activeTab()!
    const node = test.renderer!.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    tab.store.dispatch({
      command: 'view.setNodeSize',
      params: {
        graphId: tab.store.doc.root,
        nodeId: 'clip',
        size: { width: node.layout.width + 180, height: node.layout.height + 100 },
      },
    })
    test.renderer!.setViewport({ x: 20, y: 10, scale: 1 })
  })
  const resized = await rowGeometry()
  await page.mouse.move(resized.left + resized.width / 2, resized.top + resized.height / 2)
  const resizedHoverCalls = await scrollbarPaint()
  expect(resizedHoverCalls).toContainEqual([
    resized.scrollbarWorld.x,
    resized.scrollbarWorld.y,
    6,
    resized.height / resized.scale - 2 - 2 - 18,
    3,
  ])
  await page.screenshot({ path: `${proofDir}/resized-hover.png`, animations: 'disabled' })
  await page.mouse.click(resized.left + resized.width / 2, resized.top + resized.height / 2)
  const resizedTextarea = page.getByTestId('widget-editor').locator('textarea')
  const resizedFocused = await resizedTextarea.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const paddingLeft = Number.parseFloat(style.paddingLeft)
    const paddingRight = Number.parseFloat(style.paddingRight)
    return {
      contentLeft: rect.left + paddingLeft,
      contentTop: rect.top + Number.parseFloat(style.paddingTop),
      contentWidth: element.clientWidth - paddingLeft - paddingRight,
      scrollbarTop: rect.top,
    }
  })
  expect(Math.abs(resizedFocused.contentLeft - resized.contentLeft)).toBeLessThan(0.6)
  expect(Math.abs(resizedFocused.contentTop - resized.contentTop)).toBeLessThan(0.6)
  expect(Math.abs(resizedFocused.contentWidth - resized.contentWidth)).toBeLessThan(1.1)
  expect(Math.abs(resizedFocused.scrollbarTop - resized.scrollbarTop)).toBeLessThan(0.6)
  await page.screenshot({ path: `${proofDir}/resized-focused.png`, animations: 'disabled' })
})

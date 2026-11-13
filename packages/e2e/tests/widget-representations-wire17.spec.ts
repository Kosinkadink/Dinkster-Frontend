/**
 * Widget representation proof against the native backend. This imports
 * the Playwright base directly to discover the deployed schema without
 * seeded editing documents.
 */
import { expect, test as base, type Page } from '@playwright/test'
import { waitForStartupOwnership } from './fixtures.js'
import { widgetDiagnostics } from './widget-diagnostics.js'

const test = base.extend(widgetDiagnostics)

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

async function textRow(page: Page): Promise<{
  x: number
  y: number
  representationId?: string
  height: number
}> {
  return page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'value')!
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

  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText('connected')
  await waitForStartupOwnership(page)
  // Menus snapshot the worker catalog and close when its initial request completes.
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()
    return tab === undefined ? undefined : app.backendForTab(tab).workerCatalog.get().status
  })).toBe('ready')
  await page.evaluate(async () => {
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'wire17-representations', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { clip: { id: 'clip', type: 'dinkster.utilities.primitive_string_multiline', values: { value: 'canonical text' } } },
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
      value: tab.store.doc.graphs.g0!.nodes.clip!.values.value,
      views: view.views,
    }
  })
  expect(state).toEqual({ value: 'canonical text', views: { value: 'single-line' } })

  await page.keyboard.press('Control+z')
  await expect.poll(() => textRow(page).then((row) => row.representationId)).toBe('multiline')
  const multilinePoint = await textRow(page)
  await page.mouse.click(multilinePoint.x, multilinePoint.y)
  await expect(page.getByTestId('widget-editor').locator('textarea')).toBeVisible()
  await expect(page.getByTestId('widget-editor').locator('input')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+y')
  await expect.poll(() => textRow(page).then((row) => row.representationId)).toBe('single-line')

  await page.evaluate(async () => {
    const current = structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc)
    await window.__dinksterTest!.app.openDocument(current, 'Wire 17 Reopened')
  })
  await expect.poll(() => textRow(page).then((row) => row.representationId)).toBe('single-line')
  state = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const view = tab.store.doc.view.graphs.g0!.nodes.clip as { views?: Record<string, string> }
    return {
      value: tab.store.doc.graphs.g0!.nodes.clip!.values.value,
      views: view.views,
    }
  })
  expect(state).toEqual({ value: 'canonical text', views: { value: 'single-line' } })

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
    const original = registry.resolve('dinkster.utilities.primitive_string_multiline')!
    ;(window as typeof window & { __wire17OriginalSchema?: typeof original }).__wire17OriginalSchema = original
    app.registerSchemas([{
      ...original,
      items: original.items.map((item) => item.kind === 'input' && item.id === 'value'
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
  })).toEqual({ value: 'single-line' })
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
    current.graphs.g0!.nodes.sink = { id: 'sink', type: 'dinkster.utilities.preview_any', values: {} }
    const links = current.graphs.g0!.links as Record<string, unknown>
    links['l_value'] = {
      id: 'l_value', from: { node: 'clip', port: 'STRING' }, to: { node: 'sink', port: 'source' },
    }
    await app.openDocument(current, 'Wire 17 Submission')
    await app.queue(app.activeTab()!)
  })
  expect(submitted).toBeDefined()
  const graph = submitted!['graph'] as {
    nodes: Record<string, { nodeType: string; inputs: Record<string, unknown> }>
  }
  expect(graph.nodes['clip']).toEqual({
    nodeType: 'dinkster.utilities.primitive_string_multiline',
    inputs: { value: 'canonical text' },
  })
  expect(graph.nodes['sink']?.inputs['source']).toEqual({ $link: { node: 'clip', output: 'STRING' } })
  expect(JSON.stringify(graph)).not.toContain('single-line')
})

test('multiline preview expands with node height while representation, editor, and job keep one value', async ({ page }) => {
  const value = 'first line\nsecond line\n\nfourth line\nfifth line\nsixth line'
  await page.evaluate((text) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: tab.store.doc.root, nodeId: 'clip', inputId: 'value', value: text },
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
      const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'value')!
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
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'value')!
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
    graph.nodes.sink = { id: 'sink', type: 'dinkster.utilities.preview_any', values: {} }
    graph.links.l_value = {
      id: 'l_value', from: { node: 'clip', port: 'STRING' }, to: { node: 'sink', port: 'source' },
    }
    graph.nextOrdinal += 1
    exported.view.graphs.g0!.nodes.sink = { position: { x: 500, y: 300 } }
    await app.openDocument(exported, 'Multiline Layout Reopened')
    const reopened = app.activeTab()!
    const compiled = app.compileTab(reopened)
    if (!compiled?.ok) throw new Error('reopened multiline document did not compile')
    await app.queue(reopened)
    return reopened.store.doc.graphs.g0!.nodes.clip!.values.value
  })
  expect(exportedValue).toBe(value)
  const graph = submitted?.['graph'] as { nodes?: Record<string, { inputs?: Record<string, unknown> }> } | undefined
  expect(graph?.nodes?.['clip']?.inputs?.['value']).toBe(value)
  expect(JSON.stringify(graph?.nodes?.['clip'])).not.toContain('representation')
  expect(JSON.stringify(graph?.nodes?.['clip'])).not.toContain('single-line')
})

test('in-node multiline editor tracks camera and keeps commit, cancel, and blur semantics exact', async ({ page }) => {
  const value = Array.from({ length: 14 }, (_, index) => `editor line ${index + 1}`).join('\n')
  await page.evaluate((text) => {
    const test = window.__dinksterTest!
    const tab = test.app.activeTab()!
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: tab.store.doc.root, nodeId: 'clip', inputId: 'value', value: text },
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
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'value')!
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
  expect(styles.fontFamily).toContain('Noto Sans')
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

  const baselineValue = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.value)
  // Look-don't-touch editing closes without changing the value.
  await page.mouse.click(movedGeometry.actual.left - 10, movedGeometry.actual.top - 10)
  await expect(editor).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.value)).toBe(baselineValue)

  const commitPoint = await textRow(page)
  await page.mouse.click(commitPoint.x, commitPoint.y)
  await textarea.fill('ctrl commit\nvalue')
  await textarea.press('Control+Enter')
  await expect(editor).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.value)).toBe('ctrl commit\nvalue')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.value)).toBe(baselineValue)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.redo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.value)).toBe('ctrl commit\nvalue')

  const cancelPoint = await textRow(page)
  await page.mouse.click(cancelPoint.x, cancelPoint.y)
  await editor.locator('textarea').fill('escape must cancel')
  await page.keyboard.press('Escape')
  await expect(editor).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.value)).toBe('ctrl commit\nvalue')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.value)).toBe(baselineValue)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.redo())).toBe(true)

  const blurPoint = await textRow(page)
  await page.mouse.click(blurPoint.x, blurPoint.y)
  await editor.locator('textarea').fill('blur commit\nvalue')
  await page.mouse.click(movedGeometry.actual.left - 10, movedGeometry.actual.top - 10)
  await expect(editor).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.value)).toBe('blur commit\nvalue')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.value)).toBe('ctrl commit\nvalue')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.redo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.clip!.values.value)).toBe('blur commit\nvalue')
  await test.info().attach('multiline-in-node-editor', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
})

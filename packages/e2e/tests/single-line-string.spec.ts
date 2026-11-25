import { expect, nativeTest as test, waitForWorkspaceReady } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.route('**/api/nodes*', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        epoch: 1,
        dinkster: { version: 'string-layout-fixture', schemaWire: 2 },
        nodes: {},
      },
    }),
  )
  await page.route('**/api/workflows/plan', (route) =>
    route.fulfill({
      json: {
        packs: [],
        assets: [],
        errors: [],
      },
    }),
  )
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await page.addStyleTag({
    content:
      '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
})

test.describe('single-line STRING device-pixel layout', () => {
  test.use({ deviceScaleFactor: 2 })

  test('CLIP Text Encode keeps a long single-line text value in its own zone', async ({
    page,
  }) => {
    const long = 'beautiful scenery nature glass bottle landscape, '.repeat(40)
    await page.evaluate(async (value) => {
      const string = { kind: 'concrete', name: 'STRING' }
      window.__dinksterTest!.app.registerSchemas([
        {
          type: 'CLIPTextEncodeLayoutProof',
          displayName: 'CLIP Text Encode',
          category: 'test',
          source: 'v3',
          isOutputNode: false,
          body: [
            {
              kind: 'input',
              id: 'text',
              type: string,
              optional: false,
              widget: { widgetType: 'STRING', options: {}, default: '' },
            },
            {
              kind: 'input',
              id: 'clip',
              type: { kind: 'concrete', name: 'CLIP' },
              optional: true,
            },
            {
              kind: 'output',
              id: 'conditioning',
              type: { kind: 'concrete', name: 'CONDITIONING' },
            },
          ],
        },
      ])
      await window.__dinksterTest!.app.openDocument(
        {
          format: 'dinkster-workflow',
          formatVersion: 1,
          lineage: 'clip-text-layout-proof',
          root: 'g0',
          graphs: {
            g0: {
              id: 'g0',
              name: 'root',
              nodes: {
                clip: {
                  id: 'clip',
                  type: 'CLIPTextEncodeLayoutProof',
                  values: { text: value },
                },
              },
              links: {},
              nets: {},
              reroutes: {},
              nextOrdinal: 2,
            },
          },
          view: {
            graphs: {
              g0: {
                nodes: {
                  clip: {
                    position: { x: 180, y: 120 },
                    size: { width: 448, height: 180 },
                  },
                },
              },
            },
          },
        },
        'CLIP Text Encode Layout Proof',
      )
      window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    }, long)

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window
              .__dinksterTest!.renderer!.getScene()
              .nodes.find((node) => node.id === 'clip')?.layout.width,
        ),
      )
      .toBe(448)

    const before = await page.evaluate(() => {
      const app = window.__dinksterTest!.app
      const compiled = app.compileTab(app.activeTab()!)
      if (!compiled?.ok)
        throw new Error('CLIP Text Encode layout fixture did not compile')
      const artifact = compiled.artifact as unknown as {
        prompt: unknown
        semanticHash: string
      }
      return { prompt: artifact.prompt, semanticHash: artifact.semanticHash }
    })
    expect(JSON.stringify(before.prompt)).toContain(long)

    for (const [width, scale] of [
      [300, 0.75],
      [448, 1],
      [720, 1.5],
    ] as const) {
      const proof = await page.evaluate(
        ({ width, scale }) => {
          const test = window.__dinksterTest!
          const tab = test.app.activeTab()!
          const node = test
            .renderer!.getScene()
            .nodes.find((item) => item.id === 'clip')!
          tab.store.dispatch({
            command: 'view.setNodeSize',
            params: {
              graphId: tab.store.doc.root,
              nodeId: 'clip',
              size: { width, height: node.layout.height },
            },
          })
          test.renderer!.setViewport({ x: 0, y: 0, scale })

          const calls: Array<{
            text: string
            x: number
            align: CanvasTextAlign
          }> = []
          const restore = [CanvasRenderingContext2D.prototype, OffscreenCanvasRenderingContext2D.prototype].map((prototype) => {
            const original = prototype.fillText
            prototype.fillText = function (text, x, y, maxWidth) {
              calls.push({ text, x, align: this.textAlign })
              if (maxWidth === undefined) return original.call(this, text, x, y)
              return original.call(this, text, x, y, maxWidth)
            }
            return () => { prototype.fillText = original }
          })
          try {
            const renderer = test.renderer! as unknown as { invalidate(): void; renderNow(): void }
            renderer.invalidate()
            renderer.renderNow()
          } finally {
            for (const reset of restore) reset()
          }

          const paintedNode = test
            .renderer!.getScene()
            .nodes.find((item) => item.id === 'clip')!
          const row = paintedNode.layout.rows.find(
            (item) => item.kind === 'widget' && item.inputId === 'text',
          )!
          const canvas = document
            .querySelector('[data-testid=graph-canvas]')!
            .getBoundingClientRect()
          const viewport = test.renderer!.getViewport()
          return {
            calls,
            devicePixelRatio: window.devicePixelRatio,
            rowHeight: row.height,
            nodeWidth: paintedNode.layout.width,
            clip: {
              x:
                canvas.left + (paintedNode.x - 8) * viewport.scale + viewport.x,
              y: canvas.top + (paintedNode.y - 8) * viewport.scale + viewport.y,
              width: (paintedNode.layout.width + 16) * viewport.scale,
              height: (paintedNode.layout.height + 16) * viewport.scale,
            },
          }
        },
        { width, scale },
      )

      expect(proof.devicePixelRatio).toBe(2)
      expect(proof.nodeWidth).toBe(width)
      expect(proof.rowHeight).toBeLessThan(60)
      expect(
        proof.calls.some(
          (call) => call.text === 'text' && call.align === 'left',
        ),
      ).toBe(true)
      expect(
        proof.calls.some(
          (call) =>
            call.text.startsWith('beautiful') &&
            call.text.endsWith('...') &&
            call.align === 'right',
        ),
      ).toBe(true)
      await test.info().attach(`clip-text-${width}px-zoom-${scale}`, {
        body: await page.screenshot({
          clip: proof.clip,
          animations: 'disabled',
          scale: 'device',
        }),
        contentType: 'image/png',
      })
    }

    const exported = await page.evaluate(async () => {
      const app = window.__dinksterTest!.app
      const tab = app.activeTab()!
      const document = app.exportDocument(tab.id)
      await app.openDocument(document, 'CLIP Text Encode Reopened')
      return document
    })
    expect(
      (
        exported as {
          graphs: { g0: { nodes: { clip: { values: { text: string } } } } }
        }
      ).graphs.g0.nodes.clip.values.text,
    ).toBe(long)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes
              .clip!.values.text,
        ),
      )
      .toBe(long)
    const after = await page.evaluate(() => {
      const app = window.__dinksterTest!.app
      const compiled = app.compileTab(app.activeTab()!)
      if (!compiled?.ok)
        throw new Error(
          'reopened CLIP Text Encode layout fixture did not compile',
        )
      const artifact = compiled.artifact as unknown as {
        prompt: unknown
        semanticHash: string
      }
      return { prompt: artifact.prompt, semanticHash: artifact.semanticHash }
    })
    expect(after).toEqual(before)

    const rowPoint = await page.evaluate(() => {
      const test = window.__dinksterTest!
      const node = test
        .renderer!.getScene()
        .nodes.find((item) => item.id === 'clip')!
      const row = node.layout.rows.find(
        (item) => item.kind === 'widget' && item.inputId === 'text',
      )!
      const canvas = document
        .querySelector('[data-testid=graph-canvas]')!
        .getBoundingClientRect()
      const viewport = test.renderer!.getViewport()
      return {
        x:
          canvas.left +
          (node.x + node.layout.width / 2) * viewport.scale +
          viewport.x,
        y:
          canvas.top +
          (node.y + row.y + row.height / 2) * viewport.scale +
          viewport.y,
      }
    })
    await page.mouse.move(rowPoint.x, rowPoint.y)
    await page.mouse.click(rowPoint.x, rowPoint.y)
    const editor = page.getByTestId('widget-editor')
    await expect(editor.locator('input')).toHaveValue(long)
    const editorBox = await editor.boundingBox()
    expect(editorBox).not.toBeNull()
    expect(editorBox!.x).toBeGreaterThanOrEqual(0)
    expect(editorBox!.x + editorBox!.width).toBeLessThanOrEqual(1440)
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes
              .clip!.values.text,
        ),
      )
      .toBe(long)
  })
})

test('opening a text and leaving it without typing stores nothing, whatever line breaks the field cannot show', async ({ page }) => {
  // A text box gives back "\n" for "\r\n", so the text the field shows
  // differs from the stored one.
  const windows = 'one\r\ntwo\r\nthree'
  await page.evaluate(async ({ windows }) => {
    const string = { kind: 'concrete', name: 'STRING' }
    window.__dinksterTest!.app.registerSchemas([{
      type: 'TextLeaveProof', displayName: 'Text', category: 'test', source: 'v3', isOutputNode: false,
      body: [
        { kind: 'input', id: 'text', type: string, optional: false, widget: { widgetType: 'STRING', options: { multiline: true }, default: '' } },
        { kind: 'input', id: 'other', type: string, optional: false, widget: { widgetType: 'STRING', options: {}, default: '' } },
      ],
    }])
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'text-leave-proof', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { n1: { id: 'n1', type: 'TextLeaveProof', values: { text: windows, other: 'x' } } },
        links: {}, nets: {}, reroutes: {},
        nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: { n1: { position: { x: 420, y: 120 } } } } } },
    }, 'Text Leave Proof')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    const app = window.__dinksterTest!.app as unknown as { queue: () => Promise<void> }
    app.queue = async () => {}
  }, { windows })

  const state = () => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graph = tab.store.doc.graphs.g0!
    return { revision: tab.store.revision, text: graph.nodes.n1!.values.text }
  })
  const point = () => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    const node = renderer.getScene().nodes.find((item) => item.id === 'n1')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'text')!
    const world = { x: node.x + node.layout.width / 2, y: node.y + row.y + row.height / 2 }
    return { x: rect.left + world.x * viewport.scale + viewport.x, y: rect.top + world.y * viewport.scale + viewport.y }
  })
  const editor = page.getByTestId('widget-editor')
  const open = async () => {
    const at = await point()
    await page.mouse.click(at.x, at.y)
    await expect(editor.locator('textarea')).toBeFocused()
  }
  const clickAway = () => page.mouse.click(1200, 760)
  const before = await state()
  expect(before).toMatchObject({ text: windows })

  const leaves: ReadonlyArray<readonly [string, () => Promise<void>]> = [
    ['click away', clickAway],
    ['Tab', () => page.keyboard.press('Tab')],
    ['Ctrl+Enter', () => page.keyboard.press('Control+Enter')],
  ]
  for (const [how, leave] of leaves) {
    const start = await state()
    await open()
    await leave()
    if (how === 'Tab') {
      await expect(page.locator('.widget-in-row-field input')).toBeFocused()
      await page.keyboard.press('Escape')
    }
    await expect(editor).toHaveCount(0)
    const after = await state()
    expect.soft(after, `text left by ${how}`).toEqual(start)
    // Put a lost text back so each way of leaving is judged on its own.
    if (after.revision !== start.revision) await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  }
  expect((await state()).text).toBe(windows)

  // A typed change is still stored.
  await open()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('!')
  await clickAway()
  await expect.poll(async () => (await state()).text).toBe('one\ntwo\nthree!')
})

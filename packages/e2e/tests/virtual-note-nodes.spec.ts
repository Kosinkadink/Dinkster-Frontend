import { mkdirSync } from 'node:fs'
import { expect, test } from './fixtures.js'

const proofDir = process.env['DINKSTER_VIRTUAL_NOTE_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

const nativeTable = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'virtual-note-e2e', schemaWire: 44 },
  packs: { test: { displayName: 'Test' } },
  nodes: {
    'test.Output': {
      schemaVersion: 44,
      nodeType: 'test.Output',
      displayName: 'Output',
      category: 'test',
      interface: [],
      isOutputNode: true,
      signature: 'virtual-note-output',
    },
  },
}

test('notes render, persist, copy atomically, and never reach the backend', async ({
  context,
  page,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  let submitted: Record<string, unknown> | undefined
  await page.route('/supervisor/status', (route) =>
    route.fulfill({ status: 502, body: 'no supervisor' }),
  )
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/api/nodes*', (route) =>
    route.fulfill({ json: nativeTable }),
  )
  await page.route('/api/assets', (route) =>
    route.fulfill({
      status: 200,
      json: { digest: `blake3:${'d'.repeat(64)}` },
    }),
  )
  await page.route('/api/jobs', (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({
      status: 202,
      json: {
        clientId: submitted['clientId'],
        jobId: submitted['jobId'],
        state: 'queued',
      },
    })
  })

  await page.goto('/')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__dinksterTest?.app.backends
            .get()[0]
            ?.registry.get()
            ?.schemas.has('test.Output') ?? false,
      ),
    )
    .toBe(true)

  await page.mouse.dblclick(700, 600)
  await page.getByTestId('palette-search').fill('Markdown Note')
  await expect(page.locator('[data-node-type="dinkster.markdown_note"]')).toBeVisible()
  await page.locator('[data-node-type="dinkster.markdown_note"]').click()
  await page.mouse.click(700, 600)
  await expect
    .poll(() =>
      page.evaluate(() =>
        (() => {
          const document = window.__dinksterTest!.app.activeTab()!.store.doc
          return Object.values(document.graphs[document.root]!.nodes).find(
            (node) => node.type === 'dinkster.markdown_note',
          )
        })(),
      ),
    )
    .toMatchObject({ virtual: true, values: { text: '' } })

  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'virtual-note-e2e',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'Workflow',
            links: {},
            nets: {},
            reroutes: {},
            nextOrdinal: 10,
            nodes: {
              output: { id: 'output', type: 'test.Output', values: {} },
              note: {
                id: 'note',
                type: 'dinkster.note',
                virtual: true,
                title: 'Plain note',
                values: { text: 'Remember to review the final image.' },
              },
              markdown: {
                id: 'markdown',
                type: 'dinkster.markdown_note',
                virtual: true,
                title: 'Release checklist',
                values: {
                  text: '# Ready\n\n- Inspect details\n- Publish result',
                },
              },
            },
          },
        },
        view: {
          graphs: {
            g0: {
              nodes: {
                output: { position: { x: 980, y: 240 } },
                note: {
                  position: { x: 100, y: 150 },
                  size: { width: 340, height: 220 },
                  color: '#713f12',
                },
                markdown: {
                  position: { x: 500, y: 150 },
                  size: { width: 390, height: 270 },
                  color: '#164e63',
                },
              },
            },
          },
        },
      },
      'Virtual note proof',
    )
    window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 30, scale: 1 })
  })

  await expect
    .poll(() =>
      page.evaluate(() =>
        window
          .__dinksterTest!.renderer!.getScene()
          .nodes.filter((node) => node.id === 'note' || node.id === 'markdown')
          .map((node) => ({
            id: node.id,
            text: node.virtual?.text,
            pins: node.layout.pins.length,
            color: node.color,
          })),
      ),
    )
    .toEqual([
      {
        id: 'note',
        text: 'Remember to review the final image.',
        pins: 0,
        color: '#713f12',
      },
      {
        id: 'markdown',
        text: '# Ready\n\n- Inspect details\n- Publish result',
        pins: 0,
        color: '#164e63',
      },
    ])

  const saved = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.exportDocument(app.activeTab()!.id)
  })
  await page.evaluate((document) => {
    window.__dinksterTest!.app.openDocument(
      document,
      'Reopened virtual notes',
      undefined,
      true,
    )
  }, saved)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const graph =
          window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
        return {
          note: graph.nodes.note,
          markdown: graph.nodes.markdown,
          noteView:
            window.__dinksterTest!.app.activeTab()!.store.doc.view.graphs.g0!
              .nodes.note,
          markdownView:
            window.__dinksterTest!.app.activeTab()!.store.doc.view.graphs.g0!
              .nodes.markdown,
        }
      }),
    )
    .toMatchObject({
      note: {
        virtual: true,
        title: 'Plain note',
        values: { text: 'Remember to review the final image.' },
      },
      markdown: {
        virtual: true,
        title: 'Release checklist',
        values: { text: '# Ready\n\n- Inspect details\n- Publish result' },
      },
      noteView: {
        position: { x: 100, y: 150 },
        size: { width: 340, height: 220 },
        color: '#713f12',
      },
      markdownView: {
        position: { x: 500, y: 150 },
        size: { width: 390, height: 270 },
        color: '#164e63',
      },
    })

  const noteTextPoint = await page.evaluate(() => {
    const node = window
      .__dinksterTest!.renderer!.getScene()
      .nodes.find((candidate) => candidate.id === 'note')!
    const row = node.layout.rows.find(
      (candidate) => candidate.kind === 'widget' && candidate.inputId === 'text',
    )!
    const rect = document
      .querySelector('[data-testid=graph-canvas]')!
      .getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  })
  await page.mouse.click(noteTextPoint.x, noteTextPoint.y)
  const noteEditor = page.getByTestId('widget-editor').locator('textarea')
  await noteEditor.fill('Edited through the normal widget path.')
  await noteEditor.blur()
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.note!
          .values['text'],
      ),
    )
    .toBe('Edited through the normal widget path.')
  await page.keyboard.press('Control+z')
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.note!
          .values['text'],
      ),
    )
    .toBe('Remember to review the final image.')

  await page.evaluate(() =>
    window.__dinksterTest!.controller!.setSelection(['note']),
  )
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.values(
            window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes,
          ).filter((node) => node.virtual === true).length,
      ),
    )
    .toBe(3)
  await page.keyboard.press('Control+z')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.values(
            window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes,
          ).filter((node) => node.virtual === true).length,
      ),
    )
    .toBe(2)

  const compile = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.compileTab(app.activeTab()!)
  })
  expect(compile, JSON.stringify(compile)).toMatchObject({ ok: true })
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, ['output'])
  })
  expect(
    await page.evaluate(() => window.__dinksterTest!.app.problems.get()),
  ).toEqual([])
  await expect.poll(() => submitted).toBeDefined()
  const graph = submitted!['graph'] as {
    nodes: Record<string, { nodeType: string }>
  }
  expect(Object.keys(graph.nodes)).toEqual(['output'])
  expect(
    Object.values(graph.nodes).every((node) => !node.nodeType.includes('note')),
  ).toBe(true)

  if (proofDir) {
    await page.screenshot({
      path: `${proofDir}/virtual-notes.png`,
      animations: 'disabled',
      fullPage: true,
    })
  }
})

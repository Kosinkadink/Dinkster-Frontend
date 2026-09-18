import { expect, test, type Page } from '@playwright/test'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

interface Point {
  readonly x: number
  readonly y: number
}

interface BrowserErrors {
  readonly page: string[]
  readonly console: string[]
  readonly responses: string[]
}

const browserErrors = new WeakMap<Page, BrowserErrors>()

const firstLink = {
  from: { node: 'split', port: 'parts.parts', members: ['m0'] },
  to: { node: 'concat', port: 'a' },
}

const secondLink = {
  from: { node: 'split', port: 'parts.parts', members: ['m1'] },
  to: { node: 'concat', port: 'b' },
}

async function pinPoint(
  page: Page,
  nodeId: string,
  direction: 'in' | 'out',
  match: { readonly port?: string; readonly member?: string },
): Promise<Point> {
  return page.evaluate(({ nodeId, direction, match }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)
    if (node === undefined) throw new Error(`missing scene node '${nodeId}'`)
    const pin = node.layout.pins.find((candidate) =>
      candidate.direction === direction
      && (match.port === undefined || candidate.address.port === match.port)
      && (match.member === undefined || candidate.address.members?.[0] === match.member))
    if (pin === undefined) throw new Error(`missing ${direction} pin on '${nodeId}'`)
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + (node.x + (direction === 'out' ? node.layout.width : 0)) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + pin.y) * viewport.scale + viewport.y,
    }
  }, { nodeId, direction, match })
}

async function headerPoint(page: Page, nodeId: string): Promise<Point> {
  return page.evaluate((nodeId) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)
    if (node === undefined) throw new Error(`missing scene node '${nodeId}'`)
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  }, nodeId)
}

async function drag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

const splitState = (page: Page) => page.evaluate(() => {
  const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
  const split = graph.nodes.split as unknown as {
    dynamic?: { parts?: { members?: readonly string[]; seq?: number } }
  }
  return {
    members: split.dynamic?.parts?.members ?? [],
    seq: split.dynamic?.parts?.seq,
    links: Object.values(graph.links).map((link) => ({ from: link.from, to: link.to })),
  }
})

test.beforeEach(async ({ page }) => {
  test.skip(process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_NATIVE_BACKEND to an isolated Dinkster backend started with --dev')
  const errors: BrowserErrors = { page: [], console: [], responses: [] }
  browserErrors.set(page, errors)
  page.on('pageerror', (error) => errors.page.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(`${message.text()} @ ${message.location().url}`)
  })
  page.on('response', (response) => {
    if (response.status() >= 400) {
      errors.responses.push(`${response.request().method()} ${response.status()} ${response.url()}`)
    }
  })
  let nodes: Record<string, unknown> | undefined
  try {
    const response = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2_000) })
    if (response.ok) nodes = (await response.json() as { nodes: Record<string, unknown> }).nodes
  } catch { /* handled by the skip below */ }
  test.skip(nodes === undefined, `no native Dinkster backend reachable at ${NATIVE_BACKEND}`)
  test.skip(!('std.string.split' in nodes! && 'std.string.concat' in nodes!),
    'native backend lacks the string output-family scaffolding nodes')

  await page.goto('/')
  await expect.poll(() => {
    return page.evaluate(() => {
      const schemas = window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas
      return schemas?.has('std.string.split') === true && schemas.has('std.string.concat')
    })
  }, { timeout: 15_000 }).toBe(true)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'string-split-output-lifecycle', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: {
            split: {
              id: 'split', type: 'std.string.split',
              values: { text: 'alpha beta gamma', separator: ' ' },
            },
            concat: {
              id: 'concat', type: 'std.string.concat', values: { separator: '|' },
            },
          },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        },
      },
      view: {
        graphs: {
          g0: {
            nodes: {
              split: { position: { x: 120, y: 140 } },
              concat: { position: { x: 620, y: 140 } },
            },
          },
        },
      },
    } as never, 'String split output lifecycle')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
})

test('grows, executes, reloads, shrinks, and restores string split outputs', async ({ page }) => {
  await drag(
    page,
    await pinPoint(page, 'split', 'out', { member: 'm0' }),
    await pinPoint(page, 'concat', 'in', { port: 'a' }),
  )
  await drag(
    page,
    await pinPoint(page, 'split', 'out', { member: 'm1' }),
    await pinPoint(page, 'concat', 'in', { port: 'b' }),
  )

  await expect.poll(() => splitState(page)).toEqual({
    members: ['m0', 'm1'],
    seq: 2,
    links: [firstLink, secondLink],
  })

  let submitted: {
    readonly graph: {
      readonly nodes: Record<string, {
        readonly nodeType: string
        readonly outputMembers?: Readonly<Record<string, readonly string[]>>
      }>
    }
  } | undefined
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') {
      submitted = request.postDataJSON() as typeof submitted
    }
  })
  const before = await page.evaluate(() =>
    [...window.__dinksterTest!.app.store.executions.get().values()].map((execution) => execution.ref.prompt))
  const concatHeader = await headerPoint(page, 'concat')
  await page.mouse.click(concatHeader.x, concatHeader.y, { button: 'right' })
  await page.getByTestId('context-menu-item').filter({ hasText: 'Execute up to Selection' }).click()
  const newPrompt = (existing: readonly unknown[]) =>
    [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((execution) => !existing.includes(execution.ref.prompt))?.ref.prompt
  await expect.poll(() => page.evaluate(newPrompt, before), { timeout: 10_000 }).not.toBe(undefined)
  const prompt = (await page.evaluate(newPrompt, before))!
  await expect.poll(() => page.evaluate((target) =>
    [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((execution) => execution.ref.prompt === target)?.status, prompt),
  { timeout: 30_000 }).toBe('completed')
  expect(submitted?.graph.nodes.split?.nodeType).toBe('std.string.split')
  expect(submitted?.graph.nodes.split?.outputMembers).toEqual({
    parts: ['m0', 'm1'],
  })
  await expect.poll(() => page.evaluate((target) => {
    const execution = [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((candidate) => candidate.ref.prompt === target) as unknown as {
      nodes?: Record<string, { outputs?: Record<string, { value?: string | number | boolean }> }>
    }
    return execution?.nodes?.concat?.outputs?.text?.value
  }, prompt)).toBe('alpha|beta gamma')

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const exported = app.exportDocument(app.activeTab()!.id)
    if (exported === undefined) throw new Error('string split export failed')
    app.openDocument(JSON.parse(JSON.stringify(exported)), 'String split reopened')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => splitState(page)).toEqual({
    members: ['m0', 'm1'], seq: 2, links: [firstLink, secondLink],
  })

  const canvas = await page.getByTestId('graph-canvas').boundingBox()
  if (canvas === null) throw new Error('graph canvas is not visible')
  await drag(
    page,
    await pinPoint(page, 'concat', 'in', { port: 'b' }),
    { x: canvas.x + canvas.width - 40, y: canvas.y + canvas.height - 40 },
  )
  await expect.poll(() => splitState(page)).toEqual({
    members: ['m0', 'm1'], seq: 2, links: [firstLink],
  })

  const splitHeader = await headerPoint(page, 'split')
  await page.mouse.click(splitHeader.x, splitHeader.y, { button: 'right' })
  await page.locator('[data-testid=context-menu-item][data-item-id="core.node.compactDynamic"]').click()
  await expect.poll(() => splitState(page)).toEqual({ members: ['m0'], seq: 2, links: [firstLink] })

  await page.keyboard.press('Control+z')
  await expect.poll(() => splitState(page)).toEqual({
    members: ['m0', 'm1'], seq: 2, links: [firstLink],
  })
  await page.keyboard.press('Control+z')
  await expect.poll(() => splitState(page)).toEqual({
    members: ['m0', 'm1'], seq: 2, links: [firstLink, secondLink],
  })
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((problem) => problem.severity === 'error')
    .map((problem) => `${problem.code}: ${problem.message}`))).toEqual([])
  const errors = browserErrors.get(page)
  if (errors === undefined) throw new Error('browser error collector was not installed')
  const origin = new URL(page.url()).origin
  const expectedConsoleErrors = [
    `Failed to load resource: the server responded with a status of 404 (Not Found) @ ${origin}/supervisor/status`,
    `Failed to load resource: the server responded with a status of 404 (Not Found) @ ${origin}/supervisor/status`,
  ]
  const expectedFailedResponses = [
    `GET 404 ${origin}/supervisor/status`,
    `GET 404 ${origin}/supervisor/status`,
  ]
  expect(errors.page).toEqual([])
  expect([...errors.console].sort()).toEqual(expectedConsoleErrors.sort())
  expect([...errors.responses].sort()).toEqual(expectedFailedResponses.sort())
})

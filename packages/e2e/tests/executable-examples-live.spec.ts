import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const EXAMPLES_ROOT = fileURLToPath(new URL('../../../docs/examples/loops-and-subgraphs/', import.meta.url))

type CompletedExpectation = {
  readonly state: 'completed'
  readonly output: string
  readonly value: unknown
}
type FailedExpectation = {
  readonly state: 'failed'
  readonly nodeType: string
  readonly message: string
}
type ExampleExpectation = CompletedExpectation | FailedExpectation

const expectedResults = JSON.parse(
  await readFile(`${EXAMPLES_ROOT}expected-results.json`, 'utf8'),
) as Record<string, ExampleExpectation>

async function importExample(page: Page, file: string): Promise<void> {
  const document = JSON.parse(await readFile(`${EXAMPLES_ROOT}${file}`, 'utf8')) as {
    readonly lineage: string
    readonly graphs: Readonly<Record<string, unknown>>
  }
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('dinkster-menu-button').click()
  await page.locator('[data-item-id="workflow.importFile"]').click()
  const chooser = await chooserPromise
  await chooser.setFiles(`${EXAMPLES_ROOT}${file}`)

  await expect(page.getByTestId('status-bar')).toContainText(`Imported ${file}`)
  await expect.poll(() => page.evaluate((lineage) => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()
    return tab?.store.doc.lineage === lineage && app.tabs.get().includes(tab)
  }, document.lineage)).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.some((node) => node.id === 'region'),
  )).toBe(true)
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const selectionExecutionScopes = (app as unknown as {
      selectionExecutionScopes(tab: unknown, ids: readonly string[]): { readonly upTo?: unknown } | undefined
    }).selectionExecutionScopes.bind(app)
    return selectionExecutionScopes(app.activeTab()!, ['region'])?.upTo !== undefined
  })).toBe(true)
  expect(Object.keys(document.graphs).length).toBeGreaterThan(1)
}

async function executeRegion(page: Page): Promise<{
  readonly status: string
  readonly outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly errors: readonly unknown[]
}> {
  const before = await page.evaluate(() =>
    [...window.__dinksterTest!.app.store.executions.get().values()].map((execution) => execution.ref.prompt))
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    if (!app.tabs.get().includes(tab)) throw new Error('active imported tab is not live')
    await app.queueSelection(tab, ['region'])
  })
  const newPrompt = (existing: readonly unknown[]) =>
    [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((execution) => !existing.includes(execution.ref.prompt))?.ref.prompt
  await expect.poll(() => page.evaluate(newPrompt, before), { timeout: 15_000 }).not.toBe(undefined)
  const prompt = (await page.evaluate(newPrompt, before))!
  await expect.poll(() => page.evaluate((target) =>
    [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((execution) => execution.ref.prompt === target)?.status, prompt,
  ), { timeout: 45_000 }).toMatch(/^(completed|failed)$/)
  await expect.poll(() => page.evaluate((target) => {
    const execution = [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((candidate) => candidate.ref.prompt === target)!
    return Object.keys(execution.outputs).length > 0 || execution.errors.length > 0
  }, prompt), { timeout: 15_000 }).toBe(true)
  return page.evaluate((target) => {
    const execution = [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((candidate) => candidate.ref.prompt === target)!
    return { status: execution.status, outputs: execution.outputs, errors: execution.errors }
  }, prompt)
}

test.beforeEach(async ({ page }) => {
  test.skip(process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_NATIVE_BACKEND so the Vite same-origin proxy targets this native backend')
  let graphFeatures: readonly string[] | undefined
  let nodes: Record<string, unknown> | undefined
  try {
    const response = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2000) })
    if (response.ok) {
      const payload = await response.json() as {
        readonly dinkster?: { readonly graphFeatures?: readonly string[] }
        readonly nodes?: Record<string, unknown>
      }
      graphFeatures = payload.dinkster?.graphFeatures
      nodes = payload.nodes
    }
  } catch { /* unreachable backend stays unavailable */ }
  test.skip(!graphFeatures?.includes('regions'),
    `native backend at ${NATIVE_BACKEND} does not advertise region graphs`)
  for (const nodeType of ['std.math.add_ints', 'std.list.length', 'dinkster.value.compare', 'dinkster.int', 'dinkster.route.gate']) {
    test.skip(nodes?.[nodeType] === undefined,
      `native backend at ${NATIVE_BACKEND} lacks example node ${nodeType}`)
  }

  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText('connected')
})

for (const [file, expected] of Object.entries(expectedResults)) {
  test(`${file} imports and reaches its documented CPU result`, async ({ page }, testInfo) => {
    await importExample(page, file)
    const execution = await executeRegion(page)
    expect(execution.status).toBe(expected.state)
    if (expected.state === 'failed') {
      expect(execution.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ nodeType: expected.nodeType, message: expect.stringContaining(expected.message) }),
      ]))
      return
    }

    const descriptor = execution.outputs['region']?.[expected.output] as {
      readonly value?: unknown
      readonly elements?: ReadonlyArray<{ readonly value?: unknown }>
    } | undefined
    expect(descriptor).toBeDefined()
    const value = descriptor?.elements === undefined
      ? descriptor?.value
      : descriptor.elements.map((element) => element.value)
    expect(value).toEqual(expected.value)
    if (file === 'map-gather.json') {
      await testInfo.attach('map-gather-completed.png', {
        body: await page.screenshot({ animations: 'disabled' }),
        contentType: 'image/png',
      })
    }
  })
}

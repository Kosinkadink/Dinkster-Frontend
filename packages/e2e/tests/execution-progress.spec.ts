import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_EXECUTION_PROGRESS_PROOF_DIR']
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })
const indicatorProofDir = process.env['DINKSTER_EXECUTING_NODE_PROOF_DIR']
if (indicatorProofDir !== undefined) mkdirSync(indicatorProofDir, { recursive: true })

const settlePaint = (page: Page): Promise<void> => page.evaluate(() =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))

test('whole-workflow and executing-node progress update from the same execution events', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })

  const seed = await page.evaluate(async () => {
    const bridge = window.__dinksterTest!
    const diagnostics = bridge.app.openDocument(
      bridge.syntheticWorkflow({ chains: 1, chainLength: 4, reroutes: false }),
      'Progress proof',
    )
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    const tab = bridge.app.activeTab()!
    const nodeIds = Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes)
    const connection = bridge.app.backends.get()[0]!.id
    const execution = { connection, prompt: 'progress-proof-run' }
    type Artifact = Parameters<typeof bridge.app.store.register>[1]
    const app = bridge.app as typeof bridge.app & {
      compileTabCached(candidate: typeof tab): { ok: true; artifact: Artifact } | { ok: false } | undefined
    }
    const compiled = app.compileTabCached(tab)
    if (compiled === undefined || !compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled)}`)
    app.store.register(execution as never, compiled.artifact, Date.now())
    bridge.app.store.apply({ kind: 'started', execution, timestamp: Date.now() + 1 } as never)
    bridge.app.store.apply({
      kind: 'nodeStates', execution, timestamp: Date.now() + 2, snapshot: false,
      nodes: {
        [nodeIds[0]!]: { state: 'done' },
        [nodeIds[1]!]: { state: 'cached' },
        [nodeIds[2]!]: { state: 'running', value: 0.5, max: 20 },
      },
    } as never)
    bridge.renderer!.fitToScene()
    return { execution, runningNode: nodeIds[2]! }
  })
  await settlePaint(page)

  const workflowProgress = page.getByTestId('workflow-progress')
  await expect(workflowProgress).toContainText('Workflow 63%')
  await expect(workflowProgress).toContainText('2 of 4 nodes')
  await expect(workflowProgress.locator('progress')).toHaveAttribute('value', '0.625')
  const firstBitmap = await page.getByTestId('graph-canvas').evaluate((canvas) =>
    (canvas as HTMLCanvasElement).toDataURL())

  await page.evaluate(({ execution, runningNode }) => {
    window.__dinksterTest!.app.store.apply({
      kind: 'nodeStates', execution, timestamp: Date.now(), snapshot: false,
      nodes: { [runningNode]: { state: 'running', value: 0.25, max: 20 } },
    } as never)
  }, seed)
  await settlePaint(page)
  await expect(workflowProgress.locator('progress')).toHaveAttribute('value', '0.5625')
  const changedBitmap = await page.getByTestId('graph-canvas').evaluate((canvas) =>
    (canvas as HTMLCanvasElement).toDataURL())
  expect(changedBitmap).not.toBe(firstBitmap)

  await page.evaluate(({ execution, runningNode }) => {
    window.__dinksterTest!.app.store.apply({
      kind: 'nodeStates', execution, timestamp: Date.now(), snapshot: false,
      nodes: { [runningNode]: { state: 'running', value: 0.63, max: 20 } },
    } as never)
  }, seed)
  await settlePaint(page)
  await expect(workflowProgress.locator('progress')).toHaveAttribute('value', '0.6575')
  if (proofDir !== undefined) {
    await page.screenshot({
      path: join(proofDir, 'workflow-and-node-progress.png'),
      animations: 'disabled',
      fullPage: true,
    })
  }

  const animatedFrame = await page.getByTestId('graph-canvas').evaluate((canvas) =>
    (canvas as HTMLCanvasElement).toDataURL())
  await page.waitForTimeout(160)
  const nextAnimatedFrame = await page.getByTestId('graph-canvas').evaluate((canvas) =>
    (canvas as HTMLCanvasElement).toDataURL())
  expect(nextAnimatedFrame).not.toBe(animatedFrame)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await settlePaint(page)
  const reducedMotionFrame = await page.getByTestId('graph-canvas').evaluate((canvas) =>
    (canvas as HTMLCanvasElement).toDataURL())
  await page.waitForTimeout(160)
  const nextReducedMotionFrame = await page.getByTestId('graph-canvas').evaluate((canvas) =>
    (canvas as HTMLCanvasElement).toDataURL())
  expect(nextReducedMotionFrame).toBe(reducedMotionFrame)
  if (indicatorProofDir !== undefined) {
    await page.screenshot({
      path: join(indicatorProofDir, 'executing-node-static-glow-reduced-motion.png'),
      fullPage: true,
    })
  }

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await settlePaint(page)
  if (indicatorProofDir !== undefined) {
    await page.screenshot({
      path: join(indicatorProofDir, 'executing-node-flowing-glow.png'),
      fullPage: true,
    })
  }
})

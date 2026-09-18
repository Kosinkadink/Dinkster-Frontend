import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from './fixtures.js'

const proofDir = '/tmp/audit-v19-proof'

async function rowPoint(page: Page, inputId: string) {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n0')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + node.x + node.layout.width / 2,
      y: canvas.top + node.y + row.y + row.height / 2,
    }
  }, inputId)
}

test('proves all five wire 19 widget facts through the current live wire', async ({ page }) => {
  await mkdir(proofDir, { recursive: true })
  let submitted: Record<string, any> | undefined
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'wire19-proof', schemaWire: 21 },
    packs: { test: { displayName: 'Test' } },
    nodes: { Wire19Proof: {
      schemaVersion: 21,
      nodeType: 'Wire19Proof',
      displayName: 'Wire 19 Adoption',
      category: 'test',
      outputNode: true,
      signature: 'wire19-proof-node',
      interface: [
        { role: 'input', id: 'rounded', required: true, type: { kind: 'concrete', types: ['core.float'] },
          widget: { type: 'NUMBER', round: 0.25 } },
        { role: 'input', id: 'prompt', required: true, type: { kind: 'concrete', types: ['core.string'] },
          widget: { type: 'STRING', multiline: false, placeholder: 'Describe a scene', dynamicPrompts: true } },
        { role: 'input', id: 'mode', required: true, type: { kind: 'concrete', types: ['core.combo'] },
          widget: { type: 'COMBO', options: ['alpha', 'beta', 'gamma'], controlAfterGenerate: 'increment' } },
        { role: 'input', id: 'tint', required: true, type: { kind: 'concrete', types: ['core.string'] },
          widget: { type: 'COLOR' } },
      ],
    } },
  } }))
  await page.route('/api/assets', (route) => route.fulfill({ status: 404, json: { error: 'no library' } }))
  await page.route('/api/jobs', async (route) => {
    submitted = route.request().postDataJSON() as Record<string, any>
    await route.fulfill({ status: 202, json: {
      clientId: submitted.clientId, jobId: submitted.jobId, jobRef: 'wire19-proof', state: 'queued',
    } })
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(1)
  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'wire19-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n0: { id: 'n0', type: 'Wire19Proof', values: {
          rounded: 1.12, prompt: '', mode: 'alpha', tint: 'Not-A-Normalized-Color',
        }, controllers: { mode: 'increment' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 160, y: 120 }, size: { width: 420, height: 180 } } } } } },
    }, 'Wire 19 Adoption')
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'n0')?.layout.rows.filter((row) => row.kind === 'widget').length)).toBe(4)

  const promptPoint = await rowPoint(page, 'prompt')
  await page.mouse.click(promptPoint.x, promptPoint.y)
  const promptEditor = page.getByTestId('widget-editor').locator('textarea, input')
  await expect(promptEditor).toHaveAttribute('placeholder', 'Describe a scene')
  await page.screenshot({ path: `${proofDir}/01-placeholder-color-rows.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'prompt', value: '{sunrise|sunset} over water',
    } })
  })

  const roundPoint = await rowPoint(page, 'rounded')
  await page.mouse.click(roundPoint.x, roundPoint.y)
  const numberEditor = page.getByTestId('widget-editor').locator('input')
  await numberEditor.fill('1.12')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values.rounded)).toBe(1)

  const beforeRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queue(app.activeTab()!)
  })
  const proof = await page.evaluate((beforeRevision) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return {
      beforeRevision,
      afterRevision: tab.store.revision,
      documentPrompt: tab.store.doc.graphs.g0!.nodes.n0!.values.prompt,
      modeAfterQueue: tab.store.doc.graphs.g0!.nodes.n0!.values.mode,
      color: tab.store.doc.graphs.g0!.nodes.n0!.values.tint,
    }
  }, beforeRevision)
  expect(proof).toEqual({
    beforeRevision, afterRevision: beforeRevision,
    documentPrompt: '{sunrise|sunset} over water', modeAfterQueue: 'alpha', color: 'Not-A-Normalized-Color',
  })
  expect(submitted).toBeDefined()
  const submittedNode = submitted!.graph.nodes.n0
  expect(['sunrise over water', 'sunset over water']).toContain(submittedNode.inputs.prompt)
  expect(submittedNode.inputs.tint).toBe('Not-A-Normalized-Color')
  const completedRevision = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const execution = [...app.store.executions.get().values()].at(-1)!.ref
    app.store.apply({ kind: 'completed', execution, timestamp: Date.now() })
    return app.activeTab()!.store.revision
  })
  expect(completedRevision).toBe(beforeRevision + 1)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values.mode)).toBe('beta')
  await page.evaluate(({ submittedPrompt, beforeRevision, afterRevision, completedRevision }) => {
    const banner = document.createElement('pre')
    banner.setAttribute('data-testid', 'wire19-proof-banner')
    banner.style.cssText = 'position:fixed;right:24px;top:80px;z-index:10000;background:#102030;color:#e8f4ff;padding:16px;border:2px solid #60a5fa'
    banner.textContent = `round commit: 1.12 -> 1\ncombo completion: alpha -> beta\nPOST prompt: ${submittedPrompt}\ndocument prompt unchanged\nsubmission revision: ${beforeRevision} -> ${afterRevision}\ncompletion revision: ${completedRevision}`
    document.body.appendChild(banner)
  }, { submittedPrompt: submittedNode.inputs.prompt, beforeRevision, afterRevision: proof.afterRevision, completedRevision })
  await page.screenshot({ path: `${proofDir}/02-round-combo-dynamic-post.png`, animations: 'disabled' })
})

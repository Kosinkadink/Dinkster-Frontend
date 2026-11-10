import { expect, openRailPanel, test, waitForStartupOwnership } from './fixtures.js'

for (const mode of ['system', 'fallback', 'refused'] as const) {
  test(`clipboard consumer outlives its source tab: ${mode}`, async ({ page }, info) => {
    const owners = new Map<string, { digests: string[]; revision: number }>()
    let releases = 0
    let copying = false
    let pendingCopies = 0
    let acknowledge!: () => void
    const acknowledgment = new Promise<void>((resolve) => { acknowledge = resolve })
    await page.route('**/api/library/retentions/document/*?scope=local', async (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
      if (route.request().method() === 'DELETE') releases++
      if (route.request().method() === 'GET') return route.fulfill({ status: 404 })
      const declaration = route.request().postDataJSON()
      if (copying) {
        pendingCopies++
        await acknowledgment
        if (mode === 'refused') return route.fulfill({ status: 409, json: { error: 'Clipboard ownership refused' } })
      }
      owners.set(id, { ...declaration, revision: declaration.revision + 1 })
      await route.fulfill({ json: { ...declaration, scope: 'local', ownerKind: 'document', ownerId: id, revision: 1 } })
    })
    await page.route('/supervisor/status', (route) => route.fulfill({ status: 502 }))
    await page.goto('/')
    await waitForStartupOwnership(page)
    await page.evaluate((denied) => {
      let copied: string | undefined
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => { copied = text; if (denied) throw new Error('denied') },
        readText: async () => { if (denied) throw new Error('denied'); return copied },
        read: async () => [],
      } })
      Object.assign(window, { copiedGraphText: () => copied })
      const app = window.__dinksterTest!.app
      const schema = {
        type: 'ClipboardAsset', displayName: 'Clipboard Asset', category: 'test', source: 'v3' as const, isOutputNode: false,
        items: [{ kind: 'input' as const, id: 'file', optional: false,
          type: { kind: 'asset' as const, element: { kind: 'concrete' as const, name: 'DATA' } } },
        { kind: 'input' as const, id: 'input', optional: true, type: { kind: 'concrete' as const, name: 'FLOAT' } },
        { kind: 'output' as const, id: 'out', type: { kind: 'concrete' as const, name: 'FLOAT' } }],
      }
      app.registerSchemas([schema])
      const asset = (letter: string) => ({ digest: `blake3:${letter.repeat(64)}`, name: `${letter}.bin`,
        size: 7, mediaType: 'application/octet-stream', virtualPath: '' })
      app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'clipboard-source', root: 'g0',
        graphs: { g0: { id: 'g0', name: 'Root', nodes: {
          n0: { id: 'n0', type: schema.type, values: { file: asset('a') } },
          n1: { id: 'n1', type: schema.type, values: { file: asset('b') } },
        }, links: { l0: { id: 'l0', from: { node: 'n0', port: 'out' }, to: { node: 'n1', port: 'input' } } },
        nets: {}, reroutes: {}, nextOrdinal: 2 } },
        view: { graphs: { g0: { nodes: {
          n0: { position: { x: 60, y: 80 } }, n1: { position: { x: 400, y: 80 } },
        } } } },
      }, 'Clipboard source')
    }, mode === 'fallback')
    await page.waitForFunction(() => {
      const tab = window.__dinksterTest!.app.activeTab()!
      return tab.id === 'clipboard-source' && 'status' in tab.store
    })
    await expect.poll(() => [...owners.values()].some((owner) => owner.digests.includes(`blake3:${'a'.repeat(64)}`) &&
      owner.digests.includes(`blake3:${'b'.repeat(64)}`))).toBe(true)
    await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['n1']))
    copying = true
    await page.keyboard.press('Control+c')
    await expect.poll(() => pendingCopies).toBeGreaterThan(0)
    expect(await page.evaluate(() => (window as unknown as { copiedGraphText(): string | undefined }).copiedGraphText())).toBeUndefined()
    await page.screenshot({ path: info.outputPath(`clipboard-pending-${mode}.png`) })
    acknowledge()
    if (mode === 'refused') {
      await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get().some(
        (problem) => problem.message.includes('Clipboard ownership could not be confirmed')))).toBe(true)
      expect(await page.evaluate(() => (window as unknown as { copiedGraphText(): string | undefined }).copiedGraphText())).toBeUndefined()
      await openRailPanel(page, 'Problems')
      await expect(page.getByTestId('problems-panel')).toContainText('Clipboard ownership could not be confirmed')
      await page.screenshot({ path: info.outputPath('clipboard-refused.png') })
      return
    }
    await page.waitForFunction(() => (window as unknown as { copiedGraphText(): string | undefined }).copiedGraphText() !== undefined)
    const text = await page.evaluate(() => (window as unknown as { copiedGraphText(): string }).copiedGraphText())
    const envelope = JSON.parse(text)
    expect(envelope.nodes.map((node: { data: { values: unknown } }) => node.data.values)).toEqual([{
      file: { digest: `blake3:${'b'.repeat(64)}`, name: 'b.bin', size: 7, mediaType: 'application/octet-stream', virtualPath: '' },
    }])
    expect(envelope.externalIncoming[0].source.node).toBe('n0')
    expect(text).not.toContain(`blake3:${'a'.repeat(64)}`)
    await page.evaluate(() => {
      const app = window.__dinksterTest!.app
      app.closeTab(app.activeTab()!.id)
      ;(app as unknown as { createWorkflow(): unknown }).createWorkflow()
    })
    await page.waitForFunction(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)
    await page.keyboard.press('Control+Shift+v')
    await expect.poll(() => page.evaluate(() => {
      const document = window.__dinksterTest!.app.activeTab()!.store.doc
      return Object.values(document.graphs[document.root]!.nodes).map((node) => node.values.file).filter(Boolean)
    })).toEqual([{
      digest: `blake3:${'b'.repeat(64)}`, name: 'b.bin', size: 7, mediaType: 'application/octet-stream', virtualPath: '',
    }])
    expect(await page.evaluate(() => {
      const document = window.__dinksterTest!.app.activeTab()!.store.doc
      return Object.values(document.graphs[document.root]!.links)
    })).toEqual([])
    expect(releases).toBe(0)
    const sourceJournals = await page.evaluate((text) => Object.keys(localStorage).filter((key) => key.includes('workflow-retentions.'))
      .map((key) => JSON.parse(localStorage.getItem(key)!)).filter((entry) => entry.clipboardText === text), text)
    expect(sourceJournals.some((entry: { acknowledgedRevision?: number; digests: string[] }) => entry.acknowledgedRevision === 1 &&
      entry.digests.includes(`blake3:${'a'.repeat(64)}`) && entry.digests.includes(`blake3:${'b'.repeat(64)}`))).toBe(true)
    await page.screenshot({ path: info.outputPath(`clipboard-after-source-close-${mode}.png`) })
  })
}

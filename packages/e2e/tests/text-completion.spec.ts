import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const PROOF_DIR = process.env['DINKSTER_COMPLETION_PROOF_DIR'] ?? '/tmp/dinkster-31-after'
const TEXT_WIDGET_PROOF_DIR = process.env['DINKSTER_TEXT_WIDGET_PROOF_DIR'] ?? '/tmp/dinkster-361-after'
let choiceRequests: string[]

interface BrowserCompletionRequest {
  readonly text: string
  readonly signal: AbortSignal
}

interface BrowserCompletionRegistry {
  register(extension: {
    readonly id: string
    supports(): boolean
    complete(request: BrowserCompletionRequest): unknown
  }): unknown
}

async function textRow(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'text')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  })
}

async function widgetRow(page: Page, nodeId: string, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, inputId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === nodeId)!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, { nodeId, inputId })
}

async function placeNode(page: Page, edge: boolean): Promise<void> {
  await page.evaluate(async (edge) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'clip')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    renderer.setViewport(edge
      ? {
          x: Math.max(8, canvas.width - node.layout.width - 12) - node.x,
          y: Math.max(8, canvas.height - node.layout.height - 12) - node.y,
          scale: 1,
        }
      : { x: 80 - node.x, y: 80 - node.y, scale: 1 })
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }, edge)
}

async function openEditor(page: Page): Promise<Locator> {
  await placeNode(page, false)
  const point = await textRow(page)
  await page.mouse.click(point.x, point.y)
  const field = page.getByTestId('widget-editor').locator('input, textarea')
  await expect(field).toBeVisible()
  return field
}

const revision = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

test.beforeEach(async ({ page }) => {
  mkdirSync(PROOF_DIR, { recursive: true })
  mkdirSync(TEXT_WIDGET_PROOF_DIR, { recursive: true })
  choiceRequests = []
  await page.route('**/api/choices/comfy.files.embeddings', (route) => {
    choiceRequests.push(new URL(route.request().url()).pathname)
    return route.fulfill({ json: ['easynegative', 'cinematic-lighting'] })
  })
  await page.route('**/api/choices/comfy.files.loras', (route) => {
    choiceRequests.push(new URL(route.request().url()).pathname)
    return route.fulfill({ json: ['detail-tweaker', 'portrait-style'] })
  })
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'text-completion-proof', schemaWire: 22 },
    packs: {},
    nodes: {},
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ status: 502, body: 'no v1 backend' }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    const textRepresentations = (defaultView: 'single-line' | 'multiline') => ({
      default: defaultView,
      userSwitchable: true,
      representations: [
        {
          id: 'single-line', displayName: 'Single line',
          widget: { widgetType: 'STRING' as const, options: { multiline: false } },
        },
        {
          id: 'multiline', displayName: 'Multiline',
          widget: { widgetType: 'STRING' as const, options: { multiline: true } },
        },
      ],
    })
    const textInput = (multiline: boolean) => ({
      kind: 'input' as const,
      id: 'text',
      type: { kind: 'concrete' as const, name: 'STRING' },
      optional: false,
      widget: {
        widgetType: 'STRING' as const,
        options: { multiline },
        default: '',
        representations: textRepresentations(multiline ? 'multiline' : 'single-line'),
      },
    })
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'dinkster.string',
        displayName: 'Text',
        category: 'utilities/primitive',
        source: 'v3',
        isOutputNode: false,
        items: [textInput(false)],
      },
      {
        type: 'dinkster.string_multiline',
        displayName: 'Text (Multiline)',
        category: 'utilities/primitive',
        source: 'v3',
        isOutputNode: false,
        searchVisibility: 'hidden',
        items: [textInput(true)],
      },
    ])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'text-completion-proof',
      root: 'g0',
      graphs: { g0: {
        id: 'g0',
        name: 'root',
        nodes: { clip: { id: 'clip', type: 'dinkster.string', values: { text: '' } } },
        links: {},
        nets: {},
        reroutes: {},
        nextOrdinal: 1,
      } },
      view: { graphs: { g0: { nodes: { clip: { position: { x: 100, y: 100 } } } } } },
    }, 'Text Completion Proof')
  })
})

test('ordinary Text uses a compact editor and switches views only from its context menu', async ({ page }) => {
  const initial = await page.evaluate(() => {
    const test = window.__dinksterTest!
    const row = test.renderer!.getScene().nodes[0]!.layout.rows.find((candidate) => candidate.kind === 'widget')!
    return { viewId: row.kind === 'widget' ? row.viewId : '', representationId: row.kind === 'widget' ? row.representationId : undefined }
  })
  expect(initial).toEqual({ viewId: 'core.line', representationId: 'single-line' })

  await page.mouse.dblclick(700, 600)
  const palette = page.getByTestId('node-palette')
  await expect(palette).toBeVisible()
  await page.getByTestId('palette-search').fill('Text')
  await expect(palette.locator('[data-node-type="dinkster.string"]')).toHaveCount(1)
  await expect(palette.locator('[data-node-type="dinkster.string_multiline"]')).toHaveCount(0)
  await page.screenshot({
    path: `${TEXT_WIDGET_PROOF_DIR}/01-consolidated-text-picker.png`,
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')

  const singlePoint = await textRow(page)
  await page.mouse.click(singlePoint.x, singlePoint.y)
  const compactEditor = page.getByTestId('widget-editor')
  await expect(compactEditor).toHaveAttribute('data-editor-surface', 'popover')
  await expect(compactEditor.locator('input')).toBeVisible()
  await expect(compactEditor.locator('textarea')).toHaveCount(0)
  await page.screenshot({
    path: `${TEXT_WIDGET_PROOF_DIR}/02-single-line-compact-popover.png`,
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')

  const switcher = page.getByTestId('canvas-exposure-a11y').filter({ hasText: 'Switch text to Multiline' })
  await expect(switcher).toHaveCount(0)
  const point = await textRow(page)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  const representation = page.locator('[data-item-id="core.widget.representation"]')
  await expect(representation).toBeVisible()
  await representation.hover()
  const multiline = page.locator('[data-item-id="core.widget.representation.multiline"]')
  await expect(multiline).toBeVisible()
  await page.screenshot({
    path: `${TEXT_WIDGET_PROOF_DIR}/03-text-context-menu-representation.png`,
    animations: 'disabled',
  })
  await multiline.click()
  await expect.poll(() => page.evaluate(() => {
    const row = window.__dinksterTest!.renderer!.getScene().nodes[0]!.layout.rows.find((candidate) => candidate.kind === 'widget')!
    return row.kind === 'widget' ? [row.viewId, row.representationId] : []
  })).toEqual(['core.text', 'multiline'])
  expect(await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return {
      value: tab.store.doc.graphs.g0!.nodes.clip!.values.text,
      view: tab.store.doc.view.graphs.g0!.nodes.clip!.views?.text,
    }
  })).toEqual({ value: '', view: 'multiline' })

  await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(() => {
    const row = window.__dinksterTest!.renderer!.getScene().nodes[0]!.layout.rows.find((candidate) => candidate.kind === 'widget')!
    return row.kind === 'widget' ? row.representationId : undefined
  })).toBe('single-line')
  await page.keyboard.press('Control+y')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.openDocument(structuredClone(app.activeTab()!.store.doc), 'Reopened Text')
  })
  await expect.poll(() => page.evaluate(() => {
    const row = window.__dinksterTest!.renderer!.getScene().nodes[0]!.layout.rows.find((candidate) => candidate.kind === 'widget')!
    return row.kind === 'widget' ? row.representationId : undefined
  })).toBe('multiline')
})

test('Math Expression saves invalid text and reports the error in its accessible preview', async ({ page }) => {
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'dinkster.math.expression',
      displayName: 'Math Expression',
      category: 'math',
      source: 'v3',
      isOutputNode: false,
      mirror: {
        kind: 'expression', precision: 'bounded',
        tolerance: { relative: 1e-12 }, grammarVersion: 1,
      },
      items: [
        {
          kind: 'input', id: 'expression',
          type: { kind: 'concrete', name: 'STRING' }, optional: false,
          widget: {
            widgetType: 'STRING', options: { multiline: true }, default: 'a + b',
            textCompletions: {
              items: [
                { value: 'sin', label: 'sin()', insertText: 'sin(', detail: 'Function', kind: 'identifier' },
                { value: '+', label: '+', insertText: '+', detail: 'Operator', kind: 'operator' },
              ],
              inputFamilies: ['values'],
            },
          },
        },
        {
          kind: 'input', id: 'values', type: { kind: 'wildcard' }, optional: false,
          dynamic: {
            kind: 'autogrow',
            template: [{ kind: 'input', id: 'value', type: { kind: 'wildcard' }, optional: false }],
            naming: { kind: 'names', names: 'abcdefghijklmnopqrstuvwxyz'.split(''), min: 1 },
          },
        },
        { kind: 'output', id: 'float', type: { kind: 'concrete', name: 'FLOAT' } },
        { kind: 'output', id: 'int', type: { kind: 'concrete', name: 'INT' } },
        { kind: 'output', id: 'boolean', type: { kind: 'concrete', name: 'BOOLEAN' } },
      ],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'math-text-completion', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          math: {
            id: 'math', type: 'dinkster.math.expression', values: { expression: 'a + b' },
            dynamic: { values: { members: ['a', 'b'] } },
          },
        },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      } },
      view: { graphs: { g0: { nodes: { math: { position: { x: 100, y: 100 } } } } } },
    }, 'Math Expression Text')
  })
  const point = await widgetRow(page, 'math', 'expression')
  await page.mouse.click(point.x, point.y)
  const editor = page.getByTestId('widget-editor')
  const textarea = editor.locator('textarea')
  const suggestions = page.getByTestId('suggestion-surface')

  await textarea.fill('s')
  await expect(suggestions.getByRole('option')).toContainText('sin()')
  await expect(suggestions.getByRole('option')).toContainText('Function')
  await page.screenshot({
    path: `${TEXT_WIDGET_PROOF_DIR}/04-math-expression-schema-completion.png`,
    animations: 'disabled',
  })
  await textarea.press('Enter')
  await expect(textarea).toHaveValue('sin(')
  await expect(page.getByRole('alert')).toHaveCount(0)

  await textarea.fill('b')
  await expect(suggestions.getByRole('option')).toContainText('b')
  await expect(suggestions.getByRole('option')).toContainText('Input')
  await suggestions.getByRole('option').click()
  await expect(textarea).toHaveValue('b')

  await textarea.fill('a +')
  await expect(textarea).not.toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('alert')).toHaveCount(0)
  const before = await revision(page)
  await textarea.press('Control+Enter')
  expect(await revision(page)).toBe(before + 1)
  await expect(editor).toHaveCount(0)
  expect(await page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.math!.values.expression)).toBe('a +')
  await expect.poll(() => page.evaluate(() => structuredClone(
    window.__dinksterTest!.renderer!.getNodeOutputTexts().math ?? null,
  ))).toEqual({ text: 'Preview error\nInvalid expression: unexpected token', error: true })
  await page.screenshot({
    path: `${TEXT_WIDGET_PROOF_DIR}/05-math-expression-invalid-preview.png`,
    animations: 'disabled',
  })

  const navigator = page.getByRole('listbox', { name: 'Canvas scene navigator' })
  await navigator.focus()
  await expect(navigator).toBeFocused()
  await expect(navigator.locator('[data-active="true"]'))
    .toContainText('preview error: Invalid expression: unexpected token')
})

test('embedding and LoRA suggestions stay local until one-command commits', async ({ page }) => {
  const textarea = await openEditor(page)
  const surface = page.getByTestId('suggestion-surface')
  const before = await revision(page)

  await textarea.fill('embedding:e')
  await expect(surface).toBeVisible()
  await expect(surface).toContainText('embedding:easynegative')
  await expect(textarea).toHaveAttribute('aria-expanded', 'true')
  expect(choiceRequests).toContain('/api/choices/comfy.files.embeddings')
  await page.screenshot({
    path: `${PROOF_DIR}/issue-16-live-embedding-completions.png`,
    animations: 'disabled',
  })

  await page.keyboard.press('Enter')
  await expect(textarea).toHaveValue('embedding:easynegative')
  expect(await textarea.evaluate((element) => {
    const field = element as HTMLTextAreaElement
    return [field.selectionStart, field.selectionEnd]
  })).toEqual([22, 22])
  expect(await revision(page)).toBe(before)
  await page.keyboard.press('Control+Enter')
  expect(await revision(page)).toBe(before + 1)

  const reopened = await openEditor(page)
  await reopened.fill('<lora:po')
  await expect(surface).toContainText('<lora:portrait-style:1.0>')
  expect(choiceRequests).toContain('/api/choices/comfy.files.loras')
  await page.keyboard.press('Enter')
  await expect(reopened).toHaveValue('<lora:portrait-style:1.0>')
  expect(await reopened.evaluate((element) => {
    const field = element as HTMLTextAreaElement
    return [field.selectionStart, field.selectionEnd]
  })).toEqual([25, 25])
  expect(await revision(page)).toBe(before + 1)
  await page.keyboard.press('Control+Enter')
  expect(await revision(page)).toBe(before + 2)

  const escaped = await openEditor(page)
  await escaped.fill('keep embedding:e unchanged')
  await escaped.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(16, 16))
  await escaped.dispatchEvent('input', { data: '' })
  await expect(surface).toBeVisible()
  const unchanged = await escaped.inputValue()
  const escapeRevision = await revision(page)
  await page.keyboard.press('Escape')
  await expect(surface).toBeHidden()
  await expect(escaped).toBeFocused()
  await expect(escaped).toHaveValue(unchanged)
  expect(await revision(page)).toBe(escapeRevision)
})

test('suggestion surface contains long results, tracks its text field, and exposes a reachable scroll tail', async ({ page }) => {
  await page.evaluate(() => {
    const registry = (window.__dinksterTest!.app as unknown as {
      textEditorExtensionRegistry: BrowserCompletionRegistry
    }).textEditorExtensionRegistry
    registry.register({
      id: 'issue31.visual',
      supports: () => true,
      complete: (request) => request.text === 'proof'
        ? Array.from({ length: 14 }, (_, index) => ({
            id: `long-${index}`,
            label: index === 0
              ? '<lora:pokemon-style-sd15.safetensors:1.0>'
              : `embedding:long-provider-label-${index}-with-a-name-that-must-remain-inside-the-suggestion-surface`,
            detail: index === 0 ? 'LoRA' : `Provider detail ${index} with overflow pressure`,
            replacement: { start: 0, end: 5, text: `accepted-${index}` },
          }))
        : [],
    })
  })

  for (const [width, height, name] of [
    [1600, 950, '01-after-1600x950-open-active-long-edge'],
    [1366, 768, '02-after-1366x768-open-active-long-edge'],
    [360, 640, '03-after-360x640-open-active-long-edge'],
  ] as const) {
    await page.setViewportSize(width < 500 ? { width: 1366, height: 768 } : { width, height })
    if (width < 500) await page.getByRole('button', { name: 'Toggle right rail' }).click()
    const textarea = await openEditor(page)
    await textarea.fill('proof')
    const surface = page.getByTestId('suggestion-surface')
    await expect(surface).toBeVisible()
    await textarea.press('ArrowDown')
    await expect(page.getByTestId('suggestion-option').nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(textarea).toHaveAttribute('aria-activedescendant', await page.getByTestId('suggestion-option').nth(1).getAttribute('id') ?? '')

    await page.setViewportSize({ width, height })
    await placeNode(page, true)
    await expect.poll(() => page.evaluate(() => {
      const anchor = document.querySelector('[data-testid="widget-editor"] input, [data-testid="widget-editor"] textarea')!.getBoundingClientRect()
      const popup = document.querySelector('[data-testid="suggestion-surface"]')!.getBoundingClientRect()
      const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
      return {
        contained: popup.left >= canvas.left + 8 && popup.top >= canvas.top + 8 &&
          popup.right <= canvas.right - 8 && popup.bottom <= canvas.bottom - 8,
        separated: popup.bottom <= anchor.top || popup.top >= anchor.bottom,
        overflow: document.querySelector<HTMLElement>('[data-testid="suggestion-surface"]')!.scrollWidth <= popup.width + 1,
      }
    })).toEqual({ contained: true, separated: true, overflow: true })
    await page.screenshot({ path: `${PROOF_DIR}/${name}.png`, animations: 'disabled' })

    for (let index = 0; index < 12; index += 1) await textarea.press('ArrowDown')
    const last = page.getByTestId('suggestion-option').last()
    await expect(last).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => last.evaluate((element) => {
      const option = element.getBoundingClientRect()
      const listbox = element.parentElement!.getBoundingClientRect()
      return option.top >= listbox.top - 1 && option.bottom <= listbox.bottom + 1
    })).toBe(true)
    if (width === 1600) {
      await page.screenshot({
        path: `${PROOF_DIR}/07-after-1600x950-scroll-tail-active.png`,
        animations: 'disabled',
      })
    }

    if (width < 500) break
    await textarea.press('Escape')
    await textarea.press('Escape')
    await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  }
})

test('live inventory loading, cancellation, empty, and error states stay bounded and stale-free', async ({ page }) => {
  let releaseFirst!: () => void
  let embeddingCalls = 0
  const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve })
  await page.route('**/api/choices/comfy.files.embeddings', async (route) => {
    embeddingCalls += 1
    if (embeddingCalls === 1) {
      await firstResponse
      await route.fulfill({ json: ['stale-result'] }).catch(() => {})
      return
    }
    await route.fulfill({ json: [] })
  })
  await page.route('**/api/choices/comfy.files.loras', (route) =>
    route.fulfill({ status: 503, body: 'inventory unavailable' }))
  const textarea = await openEditor(page)
  const before = await revision(page)

  await textarea.fill('embedding:load')
  const surface = page.getByTestId('suggestion-surface')
  await expect(surface).toBeVisible()
  await expect(surface.getByRole('listbox')).toHaveAttribute('aria-busy', 'true')
  await expect(surface.getByRole('status')).toContainText('Loading suggestions...')
  await expect(surface.getByRole('option')).toHaveCount(0)
  await expect(textarea).toHaveAttribute('aria-expanded', 'true')
  await page.screenshot({ path: `${PROOF_DIR}/04-after-loading-state-is-bounded.png`, animations: 'disabled' })

  await textarea.fill('ordinary text')
  await expect(surface).toHaveCount(0)
  releaseFirst()

  await textarea.fill('embedding:none')
  await expect(surface.getByRole('status')).toContainText('No suggestions.')
  await page.screenshot({ path: `${PROOF_DIR}/05-after-empty-keeps-editor-unobstructed.png`, animations: 'disabled' })

  await textarea.fill('<lora:failure')
  await expect(surface.getByRole('status')).toContainText('Suggestions unavailable:')
  await page.screenshot({ path: `${PROOF_DIR}/06-after-provider-failure-is-contained.png`, animations: 'disabled' })
  expect(await revision(page)).toBe(before)
  await expect(textarea).toHaveValue('<lora:failure')
})

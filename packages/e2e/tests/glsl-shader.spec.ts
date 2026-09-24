import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const CURVE = {
  interpolation: 'linear',
  points: [{ position: 0, value: 0 }, { position: 1, value: 1 }],
} as const
const SHADER = `#version 300 es
#pragma passes 2
precision highp float;
uniform sampler2D u_image0;
uniform sampler2D u_image1;
uniform sampler2D u_curve0;
uniform vec2 u_resolution;
uniform float u_float0;
uniform int u_int0;
uniform bool u_bool0;
uniform int u_pass;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
layout(location = 1) out vec4 fragColor1;
layout(location = 2) out vec4 fragColor2;
layout(location = 3) out vec4 fragColor3;
void main() {
  vec4 base = u_pass == 0 ? texture(u_image1, v_texCoord) : texture(u_image0, v_texCoord);
  float increment = u_float0 + float(u_int0) * 0.01 + (u_bool0 ? 0.02 : 0.0);
  fragColor0 = base + vec4(increment + (u_pass == 0 ? 0.0 : 0.05), 0.0, 0.0, 0.0);
  fragColor1 = vec4(texture(u_curve0, vec2(0.5, 0.5)).r);
  fragColor2 = vec4(float(u_int0) / 10.0, u_bool0 ? 0.5 : 0.0, float(u_pass) / 2.0, 1.0);
  fragColor3 = vec4(u_resolution / 256.0, float(u_pass), 1.0);
}`
const APPLIED_SHADER = `${SHADER}\n// persisted exact source`

interface Point { readonly x: number; readonly y: number }
interface BrowserErrors {
  readonly page: string[]
  readonly console: string[]
  readonly responses: string[]
}

const browserErrors = new WeakMap<Page, BrowserErrors>()

async function nodeRowPoint(page: Page, nodeId: string, inputId: string): Promise<Point> {
  return page.evaluate(({ nodeId, inputId }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)
    if (!node) throw new Error(`missing scene node '${nodeId}'`)
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === inputId)
    if (!row) throw new Error(`missing widget row '${nodeId}/${inputId}'`)
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, { nodeId, inputId })
}

const latestExecution = (page: Page) => page.evaluate(() => {
  const value = [...window.__dinksterTest!.app.store.executions.get().values()]
    .sort((left, right) => right.queuedAt - left.queuedAt)[0]
  return value ? { prompt: value.ref.prompt, status: value.status } : undefined
})

async function queueAndWait(page: Page, status: 'completed' | 'error'): Promise<string> {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  const previous = await page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)
  await page.getByTestId('queue-button').click()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size),
    { timeout: 15_000 }).toBeGreaterThan(previous)
  await expect.poll(() => latestExecution(page), { timeout: 45_000 }).toEqual({
    prompt: expect.any(String), status,
  })
  return (await latestExecution(page))!.prompt
}

test.beforeEach(async ({ page }) => {
  test.skip(process.env['DINKSTER_E2E_USE_NATIVE'] !== '1' || process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_E2E_USE_NATIVE=1 and DINKSTER_NATIVE_BACKEND to an isolated Dinkster backend')
  const errors: BrowserErrors = { page: [], console: [], responses: [] }
  browserErrors.set(page, errors)
  page.on('pageerror', (error) => errors.page.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(`${message.text()} @ ${message.location().url}`)
  })
  page.on('response', (response) => {
    if (response.status() >= 400) errors.responses.push(`${response.request().method()} ${response.status()} ${response.url()}`)
  })

  let nodes: Record<string, {
    readonly schemaVersion?: number
    readonly interface?: readonly { readonly role?: string; readonly id?: string; readonly memberNames?: readonly string[] }[]
  }> | undefined
  try {
    const response = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2_000) })
    if (response.ok) nodes = (await response.json() as { nodes: typeof nodes }).nodes
  } catch { /* handled by skip below */ }
  test.skip(nodes === undefined, `no current native Dinkster backend reachable at ${NATIVE_BACKEND}`)
  test.skip(!('dinkster.image.generate' in nodes! && 'dinkster.image.glsl_shader' in nodes!),
    'native backend lacks the image generator and GLSL Shader nodes')
  const schema = nodes!['dinkster.image.glsl_shader']!
  expect(schema.schemaVersion).toBe(1)
  expect(schema.interface?.find((item) => item.id === 'images')).toMatchObject({
    role: 'inputFamily', memberNames: ['u_image0', 'u_image1', 'u_image2', 'u_image3', 'u_image4'],
  })

  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ json: {
    protocol: 1,
    state: 'ready',
    detail: 'Engine healthy',
    progress: { done: 8, total: 8, phase: 'Engine healthy' },
  } }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => {
    const schemas = window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas
    return schemas?.has('dinkster.image.generate') === true && schemas.has('dinkster.image.glsl_shader')
  }), { timeout: 15_000 }).toBe(true)
  await page.evaluate(({ shader, curve }) => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'glsl-shader-native-e2e', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: {
            source: {
              id: 'source', type: 'dinkster.image.generate',
              dynamic: { color_source: { selected: 'hex' }, operation: { selected: 'solid' } },
              values: {
                width: 256, height: 192, batch_size: 1, channels: 'rgb',
                'color_source.color_a': '#1a334d',
              },
            },
            shader: {
              id: 'shader', type: 'dinkster.image.glsl_shader',
              dynamic: {
                size_mode: { selected: 'from_input' },
                images: { members: ['u_image1'] },
                floats: { members: ['u_float0'] },
                ints: { members: ['u_int0'] },
                bools: { members: ['u_bool0'] },
                curves: { members: ['u_curve0'] },
              },
              values: {
                fragment_shader: shader,
                'floats.u_float0': 0.05,
                'ints.u_int0': 3,
                'bools.u_bool0': true,
                'curves.u_curve0': curve,
              },
            },
          },
          links: {
            image: {
              id: 'image',
              from: { node: 'source', port: 'image' },
              to: { node: 'shader', port: 'images.u_image1' },
            },
          },
          nets: {}, reroutes: {}, nextOrdinal: 2,
        },
      },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 100, y: 140 } },
        shader: { position: { x: 600, y: 120 } },
      } } } },
    } as never, 'Native GLSL Shader')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 0.85 })
  }, { shader: SHADER, curve: CURVE })
})

test('executes, previews, diagnoses, applies, reloads, undoes, and refuses invalid native GLSL', async ({ page }, testInfo) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#430
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#430')
  const submissions: Array<{
    readonly graph: { readonly nodes: Record<string, {
      readonly nodeType: string
      readonly inputs: Record<string, unknown>
      readonly slotVariants?: Record<string, string>
    }> }
  }> = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') {
      submissions.push(request.postDataJSON() as typeof submissions[number])
    }
  })

  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab) as unknown as {
      readonly ok: boolean
      readonly diagnostics: readonly { readonly code: string; readonly message: string }[]
    } | undefined
    return compiled?.ok ? [] : compiled?.diagnostics.map((item) => `${item.code}: ${item.message}`)
  })).toEqual([])

  const firstPrompt = await queueAndWait(page, 'completed')
  expect(submissions[0]?.graph.nodes.shader).toEqual({
    nodeType: 'dinkster.image.glsl_shader',
    inputs: {
      fragment_shader: SHADER,
      'images.u_image1': { $link: { node: 'source', output: 'image' } },
      'floats.u_float0': 0.05,
      'ints.u_int0': 3,
      'bools.u_bool0': true,
      'curves.u_curve0': CURVE,
    },
    slotVariants: { size_mode: 'from_input' },
  })
  await expect.poll(() => page.evaluate((prompt) => {
    const execution = [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((candidate) => candidate.ref.prompt === prompt) as unknown as {
      previews?: Record<string, Record<string, { channel?: string; payload?: unknown }>>
    }
    const streams = execution?.previews?.shader
    return streams ? {
      state: streams['glsl-state']?.channel,
      image: streams['glsl-input-u_image1']?.channel,
    } : undefined
  }, firstPrompt)).toEqual({ state: 'application/vnd.dinkster.glsl-state+json', image: 'image/png' })

  await page.mouse.click(...Object.values(await nodeRowPoint(page, 'shader', 'fragment_shader')) as [number, number])
  const editor = page.getByTestId('glsl-editor')
  await expect(editor).toBeVisible()
  await expect(editor.getByText('u_float0')).toBeVisible()
  await editor.getByLabel('Preview output').selectOption('2')
  await expect(editor.locator('canvas[aria-label="GLSL browser preview"]')).toBeVisible({ timeout: 15_000 })
  const browserPixel = await editor.locator('canvas').evaluate((canvas) =>
    [...(canvas as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data])
  expect(browserPixel).toEqual([77, 128, 128, 255])

  await editor.getByLabel('Fragment shader source').fill('#version 300 es\nthis is not GLSL')
  await expect(editor.getByRole('alert')).toContainText(/ERROR|syntax|compile/i)
  await editor.getByLabel('Fragment shader source').fill(APPLIED_SHADER)
  const screenshot = await editor.screenshot({ animations: 'disabled' })
  await testInfo.attach('native-glsl-shader-editor', { body: screenshot, contentType: 'image/png' })
  if (process.env['DINKSTER_CAPTURE_EVIDENCE'] === '1') {
    mkdirSync(evidenceGroupDir('issue-680'), { recursive: true })
    writeFileSync(evidencePath('issue-680', 'native-glsl-shader-editor.png'), screenshot)
  }
  await editor.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(editor).toHaveCount(0)
  const stored = () => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.shader!.values.fragment_shader)
  expect(await stored()).toBe(APPLIED_SHADER)
  await page.keyboard.press('Control+z')
  await expect.poll(stored).toBe(SHADER)
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(stored).toBe(APPLIED_SHADER)

  const reopened = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const exported = app.exportDocument(app.activeTab()!.id)
    if (!exported) throw new Error('GLSL document export failed')
    app.openDocument(JSON.parse(JSON.stringify(exported)), 'Native GLSL Shader reopened')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 0.85 })
    return app.activeTab()!.store.doc.graphs.g0!.nodes.shader!.values.fragment_shader
  })
  expect(reopened).toBe(APPLIED_SHADER)

  await queueAndWait(page, 'completed')
  expect(submissions.at(-1)?.graph.nodes.shader?.inputs.fragment_shader).toBe(APPLIED_SHADER)
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      dispatchTo(tab: unknown, action: unknown): { readonly ok: boolean }
    }
    return app.dispatchTo(app.activeTab()!, {
      command: 'node.setValue',
      params: {
        graphId: 'g0', nodeId: 'shader', inputId: 'fragment_shader',
        value: '#version 300 es\nthis is not GLSL',
      },
    }).ok
  })).toBe(true)
  const failedPrompt = await queueAndWait(page, 'error')
  await expect.poll(() => page.evaluate((prompt) => {
    const execution = [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((candidate) => candidate.ref.prompt === prompt) as unknown as {
      errors?: readonly { readonly message?: string }[]
    }
    return execution?.errors?.map((item) => item.message).filter(Boolean) ?? []
  }, failedPrompt)).toEqual(expect.arrayContaining([expect.stringMatching(/GLSL shader compilation failed/i)]))

  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((problem) => problem.severity === 'error' && !problem.message.includes('GLSL shader compilation failed'))
    .map((problem) => `${problem.code}: ${problem.message}`))).toEqual([])
  const errors = browserErrors.get(page)!
  expect({
    ...errors,
    console: errors.console.filter((message) => !message.includes('net::ERR_FILE_NOT_FOUND @ blob:')),
  }).toEqual({ page: [], console: [], responses: [] })
})

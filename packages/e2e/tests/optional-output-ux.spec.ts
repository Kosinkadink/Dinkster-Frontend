import { expect, test } from './fixtures.js'

test('optional and maybe-absent pins keep their hollow identity when connected', async ({ page }, testInfo) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'optional-output-proof', schemaWire: 1 },
    packs: {},
    nodes: {},
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const scalar = { kind: 'concrete', name: 'core.float' }
    app.registerSchemas([
      {
        type: 'OptionalOutputProof',
        displayName: 'Optional output proof',
        category: 'proof',
        source: 'v3',
        isOutputNode: false,
        items: [
          { kind: 'output', id: 'always', displayName: 'Always produces', type: scalar },
          { kind: 'output', id: 'maybe', displayName: 'May be absent', type: scalar, optional: true },
        ],
      },
      {
        type: 'OptionalInputProof',
        displayName: 'Optional input proof',
        category: 'proof',
        source: 'v3',
        isOutputNode: false,
        items: [{ kind: 'input', id: 'value', displayName: 'Optional value', type: scalar, optional: true }],
      },
      {
        type: 'AutogrowInputProof',
        displayName: 'Autogrow input proof',
        category: 'proof',
        source: 'v3',
        isOutputNode: false,
        items: [{
          kind: 'input', id: 'values', type: scalar, optional: false,
          dynamic: {
            kind: 'autogrow',
            template: [{ kind: 'input', id: 'value', type: scalar, optional: false }],
            naming: { kind: 'prefix', prefix: 'value', min: 1, max: 3 },
          },
        }],
      },
    ] as never)
    const diagnostics = app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'optional-output-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'root',
          nodes: {
            proof: { id: 'proof', type: 'OptionalOutputProof', values: {} },
            optional: { id: 'optional', type: 'OptionalInputProof', values: {} },
            dynamic: {
              id: 'dynamic', type: 'AutogrowInputProof', values: {},
              dynamic: { values: { members: ['m0'], seq: 1 } },
            },
          },
          links: {
            l0: { id: 'l0', from: { node: 'proof', port: 'always' }, to: { node: 'optional', port: 'value' } },
            l1: {
              id: 'l1', from: { node: 'proof', port: 'always' },
              to: { node: 'dynamic', port: 'values.value', members: ['m0'] },
            },
          },
          nets: {},
          reroutes: {},
          nextOrdinal: 4,
        },
      },
      view: { graphs: { g0: { nodes: {
        proof: { position: { x: 100, y: 100 } },
        optional: { position: { x: 480, y: 80 } },
        dynamic: { position: { x: 480, y: 250 } },
      } } } },
    }, 'Optional output proof')
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 60, scale: 1.25 })
  })
  await page.waitForFunction(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'proof')
    return node?.layout.pins.some((pin) => pin.portId === 'maybe') === true
  })

  const target = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'proof')!
    const pins = node.layout.pins.filter((pin) => pin.direction === 'out')
    const always = pins.find((pin) => pin.portId === 'always')!
    const maybe = pins.find((pin) => pin.portId === 'maybe')!
    const optional = renderer.getScene().nodes.find((candidate) => candidate.id === 'optional')!
      .layout.pins.find((pin) => pin.portId === 'value')!
    const dynamic = renderer.getScene().nodes.find((candidate) => candidate.id === 'dynamic')!
    const member = dynamic.layout.pins.find((pin) => !pin.ghost && pin.address.members?.[0] === 'm0')!
    const ghost = dynamic.layout.pins.find((pin) => pin.ghost)!
    const canvas = document.querySelector<HTMLElement>('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      flags: {
        always: always.maybeAbsent === true,
        maybe: maybe.maybeAbsent === true,
        optionalConnected: optional.optional === true,
        dynamicConnected: member.familyMember === true,
        dynamicOptional: member.optional === true,
        trailingGhost: ghost.ghost === true,
      },
      point: {
        x: canvas.left + (node.x + node.layout.width) * viewport.scale + viewport.x,
        y: canvas.top + (node.y + maybe.y) * viewport.scale + viewport.y,
      },
    }
  })
  expect(target.flags).toEqual({
    always: false,
    maybe: true,
    optionalConnected: true,
    dynamicConnected: true,
    dynamicOptional: false,
    trailingGhost: true,
  })

  await page.mouse.move(target.point.x, target.point.y)
  const tooltip = page.getByTestId('app-tooltip')
  await expect(tooltip).toContainText('Output: May be absent', { timeout: 1_500 })
  await expect(tooltip).toContainText('May produce no value.')

  const path = testInfo.outputPath('optional-output-ux.png')
  await page.screenshot({ path, animations: 'disabled' })
  await testInfo.attach('optional output UX', { path, contentType: 'image/png' })
})

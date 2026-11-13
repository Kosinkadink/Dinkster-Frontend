import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('auth-off principals retain permission toggles through the production decoder', async ({ page, request }, testInfo) => {
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: 1, dinkster: { version: 'fixture', schemaWire: 1 }, nodes: {} } }))
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: { sessions: [] } }))
  await page.route('**/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('**/api/principals', (route) => route.fulfill({ json: [
    { principalId: 'local', kind: 'human', local: true, self: true, scopes: ['local'], categories: { edit: true, execute: true, read: true } },
    { principalId: 'local-agent', kind: 'agent', local: true, categories: { edit: true, execute: false, read: true } },
  ] }))
  let delegationRequests = 0
  await page.route('**/api/auth/delegations', (route) => {
    delegationRequests += 1
    return route.fulfill({ status: 403, json: { error: 'authenticated-human-session-required' } })
  })
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
  const main = await (await request.get('/src/main.tsx')).text()
  const renderModule = main.match(/from "([^"]*solid-js_web[^"]*)"/)?.[1]
  expect(renderModule).toBeDefined()
  await page.evaluate(async ({ renderModule, clientModule }) => {
    const { render } = await import(renderModule)
    const { DinksterConnection } = await import(clientModule)
    const panelModule = '/src/AgentPermissionsPanel.tsx'
    const { AgentPermissionsPanel } = await import(panelModule)
    const host = document.createElement('section')
    host.id = 'local-controls'
    host.style.cssText = 'position:fixed;inset:40px auto auto 40px;width:620px;padding:24px;background:var(--surface-panel,#202329);z-index:10000'
    document.body.append(host)
    const connection = new DinksterConnection({ id: 'native', baseUrl: '', clientId: 'human' })
    render(() => AgentPermissionsPanel({ connection, backendLabel: 'Local (authentication off)' }), host)
  }, {
    renderModule: new URL(renderModule!, page.url()).href,
    clientModule: `/@fs${new URL('../../client/src/dinkster-connection.ts', import.meta.url).pathname}`,
  })
  const controls = page.locator('#local-controls')
  await expect(controls.getByTestId('agent-permission-toggle')).toHaveCount(6)
  await expect(controls.getByText('local-agent', { exact: true })).toBeVisible()
  await expect(controls.getByTestId('connect-agent')).toHaveCount(0)
  expect(delegationRequests).toBe(0)
  const evidence = process.env['DINKSTER_DELEGATION_EVIDENCE_DIR'] ?? testInfo.outputPath('screenshots')
  await mkdir(evidence, { recursive: true })
  await controls.screenshot({ path: `${evidence}/auth-off-permissions.png` })
})

import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('auth-off principals retain permission toggles through the production decoder', async ({ page, request }, testInfo) => {
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: 1, dinkster: { version: 'fixture', schemaWire: 22 }, nodes: {} } }))
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

test('user delegation controls and agent activity remain visible and actionable', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: 1, dinkster: { version: 'fixture', schemaWire: 22 }, nodes: {} } }))
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: { sessions: [] } }))
  await page.route('**/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
  const main = await (await request.get('/src/main.tsx')).text()
  const renderModule = main.match(/from "([^"]*solid-js_web[^"]*)"/)?.[1]
  expect(renderModule).toBeDefined()
  await page.evaluate(async (renderModule) => {
    const { render } = await import(renderModule)
    const module = '/src/AgentPermissionsPanel.tsx'
    const { AgentPermissionsPanel } = await import(module)
    const host = document.createElement('section')
    host.id = 'delegation-controls'
    host.style.cssText = 'position:fixed;inset:40px auto auto 40px;width:620px;max-height:85vh;overflow:auto;padding:24px;background:var(--surface-panel,#202329);z-index:10000'
    document.body.append(host)
    let active = false
    const connection = {
      fetchPrincipals: async () => [{ principalId: 'alice', kind: 'human', self: true, scopes: ['shared'], categories: { edit: true, execute: true, read: true, assets: true, settings: false, queue: false } }],
      updatePrincipalPermissions: async (_id: string, values: object) => ({ edit: true, execute: true, read: true, assets: true, settings: false, queue: false, ...values }),
      mintDelegation: async () => { active = true; return { token: 'fixture-only-not-a-credential', id: 'one', expiresAt: 4102444800 } },
      fetchDelegations: async () => active ? [{ id: 'one', displayName: 'Workflow assistant', scope: 'shared', expiresAt: 4102444800, kind: 'agent', sessionId: null }] : [],
      revokeDelegation: async () => { active = false },
    }
    render(() => AgentPermissionsPanel({ connection, backendLabel: 'Dinkster' }), host)
  }, new URL(renderModule!, page.url()).href)
  const controls = page.locator('#delegation-controls')
  await expect(controls.getByText('Connect agent', { exact: true })).toBeVisible()
  await controls.getByRole('textbox', { name: 'Agent name', exact: true }).fill('Workflow assistant')
  await expect(controls.getByText('Active while you are signed in. Keep the same token when you return.')).toBeVisible()
  await controls.getByRole('button', { name: 'Create delegation' }).click()
  await expect(controls.getByTestId('delegation')).toContainText('Workflow assistant')
  await expect(controls.getByRole('button', { name: 'Copy delegation token' })).toBeVisible()
  await expect(controls).not.toContainText('fixture-only-not-a-credential')
  const evidence = process.env['DINKSTER_DELEGATION_EVIDENCE_DIR'] ?? testInfo.outputPath('screenshots')
  await mkdir(evidence, { recursive: true })
  await controls.screenshot({ path: `${evidence}/permissions.png` })
  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async (module) => {
    const { registerCatalog, setLocale } = await import(module)
    registerCatalog('de-DE', {
      'agentPermissions.title': '[Agentenrechte]',
      'agentPermissions.connect': '[Agent verbinden]',
      'agentPermissions.name': '[Agentenname]',
      'agentPermissions.mint': '[Delegation erstellen]',
      'agentPermissions.copy': '[Token kopieren]',
      'agentPermissions.revoke': '[Widerrufen]',
      'collab.agentActivity.ask': '[Frage: {prompt}]',
      'collab.agentActivity.status': '[{status} - {tool}]',
    })
    setLocale('de-DE')
  }, i18nModule!)
  await expect(controls.getByRole('heading', { name: '[Agentenrechte]', exact: true })).toBeVisible()
  await expect(controls.getByRole('textbox', { name: '[Agentenname]', exact: true })).toHaveValue('Workflow assistant')
  await expect(controls.getByRole('button', { name: '[Token kopieren]', exact: true })).toBeVisible()
  await expect(controls.getByRole('button', { name: '[Widerrufen]', exact: true })).toBeVisible()
  await controls.screenshot({ path: `${evidence}/permissions-localized.png` })
  await page.evaluate(async (module) => { (await import(module)).setLocale('en') }, i18nModule!)
  await controls.getByRole('button', { name: 'Revoke', exact: true }).click()
  await expect(controls.getByTestId('delegation')).toHaveCount(0)
  await page.evaluate(() => document.getElementById('delegation-controls')!.remove())

  await page.evaluate(() => {
    const signal = <T>(value: T) => ({ get: () => value, subscribe: () => () => {} })
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): { id: string; store: { doc: { root: string } } }
      collabTabs: { set(value: ReadonlyMap<string, unknown>): void }
    }
    const tab = app.activeTab()!
    app.collabTabs.set(new Map([[tab.id, {
      descriptor: { protocolVersion: 1, sessionId: 'shared-workflow', scope: 'shared', documentId: 'Agent workspace', revision: 1, snapshotRevision: 0 },
      baseUrl: '',
      session: { status: signal('live'), doc: tab.store.doc },
      presence: { remotes: signal(new Map([['agent-assistant', {
        actorId: 'agent-assistant', graph: tab.store.doc.root, selection: [], reroutes: [],
        identity: { kind: 'agent', owner: 'alice', displayName: 'Workflow assistant' },
        activity: { v: 1, type: 'agent_tool_call', tool: 'node.add', status: 'running', pendingAsks: [{ id: 'ask', prompt: 'May I change the canvas grid?' }] },
      }]])), setLocal: () => {}, blur: () => {}, dispose: () => {} },
    }]]))
  })
  await page.getByTestId('collab-button').click()
  const panel = page.getByTestId('collab-panel')
  await expect(panel.getByTestId('agent-activity')).toContainText('node.add: running')
  await expect(panel.getByTestId('agent-activity')).toContainText('May I change the canvas grid?')
  await expect(panel.getByTestId('collab-participant')).toContainText('run by alice')
  await panel.screenshot({ path: `${evidence}/activity.png` })
  await page.evaluate(async (module) => { (await import(module)).setLocale('de-DE') }, i18nModule!)
  await expect(panel.getByTestId('agent-activity')).toContainText('[running - node.add]')
  await expect(panel.getByTestId('agent-activity')).toContainText('[Frage: May I change the canvas grid?]')
  await panel.screenshot({ path: `${evidence}/activity-localized.png` })
})

import type { Page } from '@playwright/test'
import { expect, nativeTest as test } from './fixtures.js'

const accountId = '48bb018e-5b17-4e68-bd81-c6412c4bcd72'
const issuer = 'https://identity.example.test'

async function accountFixture(page: Page) {
  const state = { available: true, signedIn: true, revision: 7, uid: '7b42c8d9-2f8b-4ce9-9d87-82fc78a31457',
    link: null as { issuer: string; id: string } | null, refuse: false, writes: 0, wait: undefined as Promise<void> | undefined }
  const project = () => ({ id: 'default', uid: state.uid, name: 'Film', created: '2026-01-01T00:00:00Z', revision: state.revision,
    deleted: false, environment: null, accountProject: state.link })
  const sibling = { ...project(), id: 'sibling', name: 'Other project', accountProject: null }
  await page.route(/\/api\/(?!library\/retention(?:s\/|-clients(?:\?|$)))/, (route) => route.fulfill({ status: 404 }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.route('/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: 1, packs: {}, nodes: {} } }))
  await page.route('/api/environment', (route) => route.fulfill({ json: { environment: null } }))
  await page.route('/api/projects?*', (route) => route.fulfill({ json: { items: [project(), sibling], cursor: null } }))
  await page.route('/api/projects/default', (route) => route.fulfill({ json: { project: project() } }))
  await page.route('/api/projects/default/needs', (route) => route.fulfill({ json: { packs: [], installed: [], extra: [], unknown: [] } }))
  await page.route('/api/account', (route) => route.fulfill({ json: { available: state.available, signedIn: state.signedIn,
    canStartSignIn: true, signInUnavailableReason: null, profile: null, signIn: { state: 'idle' } } }))
  await page.route('/api/account/projects', (route) => route.fulfill({ json: { issuer, projects: [{ id: accountId, displayName: 'Film cloud' }] } }))
  await page.route('/api/account/projects/default', async (route) => {
    expect(route.request().method()).toBe('PUT')
    state.writes++
    await state.wait
    if (state.refuse) return route.fulfill({ status: 409, json: { error: 'project-changed', privateDetail: 'do-not-show-private-detail' } })
    const body = route.request().postDataJSON() as { revision: number; accountProject: string | null }
    expect(body.revision).toBe(state.revision)
    expect(Object.keys(body).sort()).toEqual(['accountProject', 'revision'])
    state.link = body.accountProject === null ? null : { issuer, id: body.accountProject }
    state.revision++
    return route.fulfill({ json: { project: project() } })
  })
  const open = async () => {
    if (!await page.getByTestId('projects-dialog').isVisible()) await page.getByTestId('projects-button').click()
    await page.getByTestId('projects-dialog').locator('li[data-project-id="default"]').getByRole('button', { name: 'Account link', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Account link', exact: true })
    await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible()
    return dialog
  }
  return { state, sibling, open }
}

test('links one library project, keeps unchanged Save disabled and confirms signed-out unlink', async ({ page }, info) => {
  const { state, sibling, open } = await accountFixture(page)
  await page.goto('/?dinksterProject=default')
  await page.getByTestId('projects-button').click()
  await expect(page.getByTestId('projects-dialog')).toContainText('Other project')
  await page.screenshot({ path: info.outputPath('configured-list.png') })
  let dialog = await open()
  await expect(dialog.getByRole('button', { name: 'Save link', exact: true })).toBeDisabled()
  await page.screenshot({ path: info.outputPath('unlinked.png') })
  await dialog.getByRole('combobox', { name: 'Account project', exact: true }).selectOption(accountId)
  await dialog.getByRole('button', { name: 'Save link', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(state.link).toEqual({ issuer, id: accountId })
  expect(sibling.accountProject).toBeNull()
  const projects = page.getByTestId('projects-dialog')
  await expect(projects).toContainText('Account link saved.')
  await projects.locator('li[data-project-id="default"]').getByRole('button', { name: 'Account link', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Account link', exact: true })
  await expect(dialog.getByRole('button', { name: 'Save link', exact: true })).toBeDisabled()
  await expect(dialog).toContainText(accountId)
  await page.screenshot({ path: info.outputPath('linked.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('linked-narrow.png') })
  state.signedIn = false
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(dialog).toContainText('Sign in using the account control')
  await expect(dialog.getByRole('combobox')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('signed-out.png') })
  await dialog.getByRole('button', { name: 'Remove link', exact: true }).click()
  expect(state.writes).toBe(1)
  await expect(dialog).toContainText('New runs from this project')
  await page.screenshot({ path: info.outputPath('unlink-confirmation.png') })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(state.writes).toBe(1)
  await dialog.getByRole('button', { name: 'Remove link', exact: true }).click()
  await dialog.getByRole('button', { name: 'Remove link', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(state.link).toBeNull()
  expect(state.writes).toBe(2)
  expect(sibling.accountProject).toBeNull()
})

test('refuses a replaced project and requires fresh review after a save refusal', async ({ page }, info) => {
  const { state, open } = await accountFixture(page)
  await page.goto('/?dinksterProject=default')
  const dialog = await open()
  await dialog.getByRole('combobox').selectOption(accountId)
  state.uid = 'ffffffff-ffff-4fff-bfff-ffffffffffff'
  await dialog.getByRole('button', { name: 'Save link', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Refresh to review its current state')
  expect(state.writes).toBe(0)
  await expect(dialog.getByRole('button', { name: 'Save link', exact: true })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('refused.png') })
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await dialog.getByRole('combobox').selectOption(accountId)
  state.refuse = true
  await dialog.getByRole('button', { name: 'Save link', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Refresh to review its current state')
  expect(state.writes).toBe(1)
  await expect(dialog).not.toContainText('do-not-show-private-detail')
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Save link', exact: true })).toBeDisabled()
})

test('retains the editor and prevents duplicate writes while a save is pending', async ({ page }, info) => {
  const { state, open } = await accountFixture(page)
  let finish!: () => void
  state.wait = new Promise<void>((resolve) => { finish = resolve })
  await page.goto('/?dinksterProject=default')
  const dialog = await open()
  await dialog.getByRole('combobox').selectOption(accountId)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.backendsTick.update((value) => value + 1)
  })
  await expect(dialog.getByRole('combobox')).toHaveValue(accountId)
  await dialog.getByRole('button', { name: 'Save link', exact: true }).click()
  await expect.poll(() => state.writes).toBe(1)
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled()
  await page.screenshot({ path: info.outputPath('pending.png') })
  finish()
  await expect(dialog).toHaveCount(0)
  expect(state.writes).toBe(1)
})

test('offers no default link for an empty account list and Escape returns to Projects', async ({ page }, info) => {
  const { state, open } = await accountFixture(page)
  await page.route('/api/account/projects', (route) => route.fulfill({ json: { issuer, projects: [] } }))
  await page.goto('/?dinksterProject=default')
  const dialog = await open()
  await expect(dialog).toContainText('No account projects are available to link.')
  await expect(dialog.getByRole('button', { name: 'Save link', exact: true })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('empty-choices.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('projects-dialog')).toBeVisible()
  expect(state.writes).toBe(0)
})

test('hides account controls when account services are unconfigured', async ({ page }, info) => {
  const { state } = await accountFixture(page)
  state.available = false
  await page.goto('/?dinksterProject=default')
  await page.getByTestId('projects-button').click()
  const projects = page.getByTestId('projects-dialog')
  await expect(projects).toContainText('Other project')
  await expect(projects.getByRole('button', { name: 'Account link', exact: true })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('unconfigured.png') })
})

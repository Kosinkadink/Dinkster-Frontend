import { expect, test, type Page } from '@playwright/test'
import axe from 'axe-core'
import type { AccountModel } from '../src/account.js'

const profile: AccountModel = {
  screen: {
    id: 'account.profile',
    layout: 'account',
    nav: 'profile',
    blocks: [
      { t: 'h1', text: 'Profile' },
      {
        t: 'facts',
        items: [
          { label: 'Username', value: 'alice' },
          { label: 'Email', value: 'alice@example.test', chip: 'Verified' },
        ],
      },
      { t: 'field', id: 'display-name', label: 'Display name', value: 'Alice' },
      {
        t: 'button',
        text: 'Save',
        role: 'neutral',
        press: 'commits',
        disabled: true,
        changed_fields: ['display-name'],
      },
    ],
  },
  state: { flags: {}, flash: null },
  navigation: [
    {
      id: 'profile',
      text: 'Profile',
      go: 'account.profile',
      href: '/account/profile',
    },
    {
      id: 'api-keys',
      text: 'API Keys',
      go: 'account.api-keys',
      href: '/account/api-keys',
    },
  ],
  username: 'Alice',
  email: 'alice@example.test',
  signOut: { text: 'Sign out', role: 'remove', press: 'aside' },
}

async function open(
  page: Page,
  model: AccountModel = structuredClone(profile),
) {
  await page.route('**/fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Account test</title><link rel="stylesheet" href="/assets/style.css"></head><body class="dinkster-root" data-density="site" data-theme="dark"><div id="root"></div><script type="module">
    import { accountView } from '/account-view.js';
    window.model = ${JSON.stringify(model)};
    window.actions = [];
    window.view = accountView({root:document.getElementById('root'), config:{providers:['google']},
      onAction: async control => { window.actions.push(control.text); await new Promise(resolve => { window.finish = resolve }); },
      onNavigate: id => { window.navigated = id; window.model.state.loading = true; window.model.screen.id = id; window.model.screen.nav = 'api-keys'; window.view.render(window.model); },
      onChange: (id, value) => { window.changed = {id, value}; }
    }); window.view.render(window.model);
  </script></body></html>`,
    }),
  )
  await page.goto('/fixture')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}

for (const width of [1280, 390]) {
  test(`profile shared shell and keyboard labels at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await open(page)
    await expect(page.getByLabel('Display name')).toHaveValue('Alice')
    await expect(
      page.getByRole('button', { name: 'Save', exact: true }),
    ).toBeDisabled()
    await page.getByLabel('Display name').fill('Alice Example')
    await expect(
      page.getByRole('button', { name: 'Save', exact: true }),
    ).toBeEnabled()
    await page.addScriptTag({ content: axe.source })
    expect(
      await page.evaluate(
        async () =>
          (await (window as unknown as { axe: typeof axe }).axe.run())
            .violations,
      ),
    ).toEqual([])
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await page.screenshot({
      path: `test-results/captures/profile-${width}.png`,
      fullPage: true,
    })
  })
}

test('pending actions keep focus and cannot repeat; service refusal keeps entered text', async ({
  page,
}) => {
  await open(page)
  await page.getByLabel('Display name').fill('Rejected name')
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await save.click()
  await expect(save).toHaveAttribute('aria-busy', 'true')
  await expect(save).toBeFocused()
  await save.press('Enter')
  expect(
    await page.evaluate(
      () => (window as unknown as { actions: string[] }).actions,
    ),
  ).toEqual(['Save'])
  await page.evaluate(() => {
    const app = window as unknown as {
      model: AccountModel
      view: { render: (model: AccountModel) => void }
      finish: () => void
    }
    app.model.screen.blocks = app.model.screen.blocks.map((block) =>
      block.t === 'field'
        ? { ...block, value: 'Rejected name', error: 'Use another name.' }
        : block,
    )
    app.model.screen.blocks = app.model.screen.blocks.map((block) =>
      block.t === 'button' ? { ...block, disabled: false } : block,
    )
    app.model.state.flash = { tone: 'error', text: 'Save was refused.' }
    app.view.render(app.model)
    app.finish()
  })
  await expect(save).toBeFocused()
  await expect(page.getByLabel('Display name')).toHaveValue('Rejected name')
  await expect(page.getByText('Use another name.')).toBeVisible()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Save was refused.' }),
  ).toBeVisible()
  await page.screenshot({
    path: 'test-results/captures/profile-refused.png',
    fullPage: true,
  })
  await expect(save).toBeEnabled()
  await page.getByLabel('Display name').fill('Alice')
  await expect(save).toBeDisabled()
  await page.getByLabel('Display name').fill('Corrected name')
  await expect(save).toBeEnabled()
  await page.getByRole('button', { name: 'Dismiss error' }).click()
  expect(
    await page.evaluate(
      () => (window as unknown as { model: AccountModel }).model.state.flash,
    ),
  ).toBeNull()
  await save.focus()
  await save.press('Enter')
  await expect(save).toBeFocused()
  await page.evaluate(() => {
    const app = window as unknown as {
      model: AccountModel
      view: { render: (model: AccountModel) => void }
      finish: () => void
    }
    app.model.screen.blocks = app.model.screen.blocks.map((block) =>
      block.t === 'field'
        ? { ...block, value: 'Corrected name', error: '' }
        : block.t === 'button'
          ? { ...block, disabled: true }
          : block,
    )
    app.model.state.flash = { tone: 'success', text: 'Saved.' }
    app.view.render(app.model)
    app.finish()
  })
  await expect(save).toBeFocused()
  await expect(save).toHaveAttribute('aria-disabled', 'true')
  await page.screenshot({
    path: 'test-results/captures/profile-saved.png',
    fullPage: true,
  })
  await save.press('Enter')
  expect(
    await page.evaluate(
      () => (window as unknown as { actions: string[] }).actions,
    ),
  ).toEqual(['Save', 'Save'])
  await page.getByLabel('Display name').focus()
  await expect(save).toBeDisabled()
  await expect(page.getByRole('status')).toContainText('Saved.')
  await page.getByRole('button', { name: 'Dismiss notification' }).click()
  expect(
    await page.evaluate(
      () => (window as unknown as { model: AccountModel }).model.state.flash,
    ),
  ).toBeNull()
  await page.getByLabel('Display name').fill('Another name')
  await expect(save).toBeEnabled()
  await page.getByLabel('Display name').fill('Corrected name')
  await expect(save).toBeDisabled()
})

test('service updates move tokens to history and refresh conditional controls', async ({
  page,
}) => {
  const model = structuredClone(profile)
  model.screen = {
    id: 'account.publishing',
    layout: 'account',
    nav: 'publishing',
    blocks: [
      { t: 'h1', text: 'Publishing' },
      {
        t: 'rows',
        history_label: 'Inactive tokens',
        items: [
          { label: 'Release token', detail: 'Active', actions: [] },
          {
            label: 'Old token',
            detail: 'Expired',
            inactive: true,
            actions: [],
          },
        ],
      },
      { t: 'p', text: 'Confirm identity before changes.', when: 'stale' },
      { t: 'field', id: 'code', label: 'Verification code', when: 'stale' },
    ],
  }
  await open(page, model)
  await expect(page.getByRole('list', { name: 'Active tokens' })).toContainText(
    'Release token',
  )
  await expect(page.getByText('Old token', { exact: true })).toBeHidden()
  await expect(page.getByLabel('Verification code')).toHaveCount(0)
  await page.evaluate(() => {
    const app = window as unknown as {
      model: AccountModel
      view: { render: (model: AccountModel) => void }
    }
    app.model.screen.blocks[1]!.items = [
      {
        label: 'Release token',
        detail: 'Revoked',
        inactive: true,
        actions: [],
      },
      { label: 'Old token', detail: 'Expired', inactive: true, actions: [] },
    ]
    app.model.state.flags.stale = true
    app.view.render(app.model)
  })
  await expect(page.getByText('No active tokens.')).toBeVisible()
  await expect(page.getByLabel('Verification code')).toBeVisible()
  await expect(page.getByText('Confirm identity before changes.')).toBeVisible()
  await page.getByText('Inactive tokens (2)', { exact: true }).click()
  const history = page.getByRole('list', {
    name: 'Inactive tokens',
    exact: true,
  })
  await expect(history).toContainText('Release tokenRevoked')
  await expect(history).toContainText('Old tokenExpired')
  await page.setViewportSize({ width: 390, height: 900 })
  await page.screenshot({
    path: 'test-results/captures/publishing-history-390.png',
    fullPage: true,
  })
})

test('navigation marks current immediately during loading', async ({
  page,
}) => {
  await open(page)
  await page.getByRole('link', { name: 'API keys' }).click()
  await expect(page.getByRole('link', { name: 'API keys' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(
    page.getByRole('status').filter({ hasText: 'Loading...' }),
  ).toBeVisible()
  await expect(page.getByLabel('Display name')).toHaveCount(0)
})

test('account menu has name and email; sign out acts without confirmation', async ({
  page,
}) => {
  await open(page)
  await page.getByRole('button', { name: 'Account menu: Alice' }).click()
  await expect(page.getByRole('menu')).toContainText('alice@example.test')
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  expect(
    await page.evaluate(
      () => (window as unknown as { actions: string[] }).actions,
    ),
  ).toEqual(['Sign out'])
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('clearing a show-once page removes secret DOM and permits a clean restored page', async ({
  page,
}) => {
  const model = structuredClone(profile)
  model.screen = {
    id: 'account.api-keys.created',
    layout: 'task',
    blocks: [
      { t: 'h1', text: 'API key created' },
      {
        t: 'key',
        label: 'Copy this key now',
        value: 'test-only-show-once-secret',
        copy: 'Copy',
      },
      { t: 'codes', items: ['test-only-recovery-code'] },
      { t: 'qr', src: '/favicon.svg', alt: 'Setup QR' },
    ],
  }
  await open(page, model)
  await expect(
    page.getByText('test-only-show-once-secret', { exact: true }),
  ).toBeVisible()
  await page.evaluate(() =>
    (window as unknown as { view: { clear: () => void } }).view.clear(),
  )
  await expect(page.getByRole('main')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(
    'test-only-show-once-secret',
  )
  await expect(page.locator('body')).not.toContainText(
    'test-only-recovery-code',
  )
  await expect(page.getByAltText('Setup QR')).toHaveCount(0)
  await page.evaluate(
    (restored) =>
      (
        window as unknown as { view: { render: (model: AccountModel) => void } }
      ).view.render(restored),
    profile,
  )
  await expect(
    page.getByRole('heading', { name: 'Profile', exact: true }),
  ).toBeVisible()
  await expect(page.locator('body')).not.toContainText(
    'test-only-show-once-secret',
  )
})

for (const choice of ['Allow', 'Deny'])
  test(`authorization preserves POST form fields and escapes client labels for ${choice}`, async ({
    page,
  }) => {
    await page.route('**/fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization test</title><link rel="stylesheet" href="/assets/style.css"></head><body class="dinkster-root" data-density="site" data-theme="dark"><div id="root"></div><script type="module">import {authorizationView} from '/authorization.js'; authorizationView(document.getElementById('root'), {clientName:'Example <script> app',scopes:['api:read','api:execute'],consentToken:'test-consent-only'});</script></body></html>`,
      }),
    )
    await page.goto('/fixture')
    await expect(
      page.getByRole('heading', { name: 'Authorize Example <script> app' }),
    ).toBeVisible()
    await expect(page.locator('form')).toHaveAttribute('method', 'post')
    await expect(page.locator('input[name="consent_token"]')).toHaveValue(
      'test-consent-only',
    )
    const requests: string[] = []
    await page.route('**/authorize', async (route) => {
      requests.push(route.request().postData() ?? '')
      await route.fulfill({ body: 'Authorized' })
    })
    await page.screenshot({
      path: 'test-results/captures/authorization-1280.png',
      fullPage: true,
    })
    await page.getByRole('button', { name: choice, exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toBe(
      `consent_token=test-consent-only&action=${choice === 'Allow' ? 'approve' : 'deny'}`,
    )
  })

import { expect, test, type Page } from '../../e2e/visual.js'
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
    window.view = accountView({root:document.getElementById('root'), config:{providers:['github','google']},
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

test('captures reject missing product fonts rather than saving fallback pixels', async ({
  page,
}) => {
  await page.route('**/missing.woff2', (route) =>
    route.fulfill({ status: 404 }),
  )
  await page.goto('/account.html')
  await page.setContent(
    '<style>@font-face {font-family:"Noto Sans Missing";src:url("/missing.woff2")}body {font-family:"Noto Sans Missing"}</style><p>Product text</p>',
  )
  await expect(page.screenshot()).rejects.toThrow()
  await expect(page.getByText('Product text').screenshot()).rejects.toThrow()
})

test('templates fetch renderer dependencies before service controllers run', async ({
  page,
}) => {
  await page.route('**/site/**', (route) =>
    route.continue({ url: route.request().url().replace('/site/', '/') }),
  )
  await page.route('**/account.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' }),
  )
  await page.route('**/site/authorization.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' }),
  )
  for (const [template, renderer] of [
    ['account', 'account-view.js'],
    ['authorization', 'authorization.js'],
  ]) {
    await page.goto(`/${template}.html`)
    await expect
      .poll(() =>
        page.evaluate(() =>
          performance
            .getEntriesByType('resource')
            .map((entry) => new URL(entry.name).pathname),
        ),
      )
      .toEqual(
        expect.arrayContaining([
          `/site/${renderer}`,
          expect.stringMatching(/^\/site\/assets\/[^/]+\.js$/),
        ]),
      )
  }
})

for (const width of [1280, 1440, 1920, 390]) {
  test(`profile shared shell and keyboard labels at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const grouped = structuredClone(profile)
    const [title, facts, field, save] = grouped.screen.blocks
    grouped.screen.blocks = [
      title!,
      { t: 'panel', blocks: [field!] },
      save!,
      { t: 'panel', blocks: [facts!] },
    ]
    await open(page, grouped)
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

for (const width of [1280, 1440, 1920, 390]) {
  test(`service card adopts the approved sign-in layout at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 })
    await open(page, {
      ...structuredClone(profile),
      screen: {
        id: 'sign-in',
        layout: 'card',
        blocks: [
          { t: 'h1', text: 'Sign in' },
          { t: 'field', id: 'username', label: 'Username or email' },
          { t: 'field', id: 'password', kind: 'password', label: 'Password' },
          { t: 'button', text: 'Sign in', press: 'commits' },
          { t: 'or', text: 'or' },
          {
            t: 'provider',
            text: 'Continue with GitHub',
            provider: 'github',
            press: 'opens',
          },
          {
            t: 'provider',
            text: 'Continue with Google',
            provider: 'google',
            press: 'opens',
          },
        ],
        footer: {
          text: 'New to Dinkster?',
          action: { text: 'Create an account', go: 'sign-up', press: 'opens' },
        },
      },
    })
    await page.screenshot({
      path: `test-results/captures/sign-in-${width}.png`,
      fullPage: true,
    })
    await expect(page.locator('.dinkster-topbar')).toHaveCount(0)
    const card = page.locator('.dinkster-auth-card')
    await expect(card).toBeVisible()
    expect(
      await card.evaluate((element) => element.getBoundingClientRect().width),
    ).toBe(Math.min(440, width - 32))
    await expect(page.locator('.dinkster-auth-footer')).toContainText(
      'New to Dinkster?',
    )
    await expect(card.getByRole('button')).toHaveText([
      'Sign in',
      'Continue with GitHub',
      'Continue with Google',
    ])
    for (const button of await card
      .locator('.dinkster-provider button')
      .all()) {
      expect(
        await button
          .locator('img')
          .evaluate(
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 0,
          ),
      ).toBe(true)
      expect(
        await button.evaluate(
          (element) => element.getBoundingClientRect().width,
        ),
      ).toBe(220)
    }
    await page
      .getByLabel('Password', { exact: true })
      .fill('test-only-password')
    await page.getByLabel('Password', { exact: true }).press('Enter')
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { actions: string[] }).actions,
        ),
      )
      .toEqual(['Sign in'])
    await expect(
      page.getByRole('button', { name: 'Sign in', exact: true }),
    ).toBeDisabled()
  })
}

for (const width of [1280, 1440, 1920, 390]) {
  test(`service Security adopts approved sections and row geometry at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const security = structuredClone(profile)
    security.username = 'alice'
    security.screen = {
      id: 'account.security',
      layout: 'account',
      nav: 'security',
      blocks: [
        { t: 'h1', text: 'Security' },
        {
          t: 'section',
          text: 'Sign-in methods',
          blocks: [
            {
              t: 'rows',
              items: ['Password', 'Google', 'GitHub'].map((label) => ({
                label,
                detail: label === 'Password' ? 'Not set' : 'Not linked',
                actions: [
                  {
                    text: label === 'Password' ? 'Set by email' : 'Link',
                    role:
                      label === 'Password'
                        ? ('neutral' as const)
                        : ('add' as const),
                    press: 'opens' as const,
                  },
                ],
              })),
            },
          ],
        },
        {
          t: 'section',
          text: 'Two-step sign-in',
          blocks: [
            {
              t: 'rows',
              items: [
                {
                  label: 'Authenticator app',
                  detail: 'Off',
                  actions: [{ text: 'Turn on', role: 'add', press: 'opens' }],
                },
              ],
            },
            {
              t: 'p',
              text: 'Asks for a code from an app on your phone each time you sign in.',
              muted: true,
            },
          ],
        },
      ],
    }
    await open(page, security)
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect()
      const style = (selector: string) =>
        getComputedStyle(document.querySelector(selector)!)
      return {
        titleToHeading:
          rect('section .dinkster-heading').top -
          rect('.dinkster-title').bottom,
        headingToPanel:
          rect('.dinkster-list').top - rect('section .dinkster-heading').bottom,
        rowButton: rect('.dinkster-row .dinkster-button').height,
        rowButtonInset:
          rect('.dinkster-row .dinkster-button').top -
          rect('.dinkster-row').top,
        panelRadius: style('.dinkster-list').borderRadius,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }
    })
    expect(geometry).toEqual({
      titleToHeading: 32,
      headingToPanel: 12,
      rowButton: width < 768 ? 32 : 28,
      rowButtonInset: 16,
      panelRadius: '8px',
      overflow: false,
    })
    await page.screenshot({
      path: `test-results/captures/security-${width}.png`,
      fullPage: true,
    })
  })
}

test('nested fields keep their baseline and focus; submitting ignores a hidden parent group', async ({
  page,
}) => {
  const grouped = structuredClone(profile)
  grouped.screen.blocks = [
    { t: 'h1', text: 'Profile' },
    {
      t: 'section',
      text: 'Hidden section',
      when: 'hidden',
      blocks: [{ t: 'button', text: 'Wrong action', press: 'commits' }],
    },
    {
      t: 'panel',
      blocks: [
        {
          t: 'field',
          id: 'display-name',
          label: 'Display name',
          value: 'Alice',
        },
      ],
    },
    {
      t: 'button',
      text: 'Save',
      press: 'commits',
      disabled: true,
      changed_fields: ['display-name'],
    },
  ]
  await open(page, grouped)
  const field = page.getByLabel('Display name')
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await expect(save).toBeDisabled()
  await field.fill('Changed name')
  await save.focus()
  await page
    .locator('form')
    .evaluate((form: HTMLFormElement) => form.requestSubmit())
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { actions: string[] }).actions),
    )
    .toEqual(['Save'])
  await page.evaluate(() => {
    const current = window as unknown as {
      model: AccountModel
      view: { render(model: AccountModel): void }
      finish(): void
    }
    Object.assign(current.model.screen.blocks[2]!.blocks![0]!, {
      value: 'Changed name',
      error: 'Try another name.',
    })
    current.model.screen.blocks[3]!.disabled = false
    current.view.render(current.model)
    current.finish()
  })
  await expect(save).toBeFocused()
  await expect(field).toHaveValue('Changed name')
  await expect(page.getByRole('alert')).toContainText('Try another name.')
  await field.fill('Alice')
  await expect(save).toBeDisabled()
})

test('account caller forwards guarded pictures and resets to the initial on failed or absent images', async ({
  page,
}) => {
  await page.route('**/avatar.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>',
    }),
  )
  await page.route('**/missing-avatar', (route) =>
    route.fulfill({ status: 404, body: '' }),
  )
  await open(page, { ...structuredClone(profile), pictureSrc: '/avatar.svg' })
  const avatar = page.locator('.dinkster-avatar')
  await expect(avatar.locator('img')).toBeVisible()
  await expect(avatar).toHaveAttribute('data-picture', 'true')
  await page.screenshot({
    path: 'test-results/captures/profile-picture.png',
    fullPage: true,
  })
  for (const pictureSrc of [
    '/missing-avatar',
    null,
    'https://untrusted.invalid/avatar.svg',
  ]) {
    await page.evaluate((pictureSrc) => {
      const current = window as unknown as {
        model: AccountModel
        view: { render(model: AccountModel): void }
      }
      current.model.pictureSrc = pictureSrc
      current.view.render(current.model)
    }, pictureSrc)
    await expect(avatar.locator('img')).toHaveCount(0)
    await expect(avatar).toHaveAttribute('data-picture', 'false')
    await expect(avatar).toHaveAttribute('data-initial', 'A')
  }
})

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

for (const width of [1280, 1440, 1920, 390])
  for (const choice of ['Allow', 'Deny'])
    test(`authorization preserves POST form fields and escapes client labels for ${choice} at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
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
      await expect(page.locator('.dinkster-topbar')).toHaveCount(0)
      await expect(page.locator('.dinkster-auth-card')).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
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
        path: `test-results/captures/authorization-${width}.png`,
        fullPage: true,
      })
      await page.getByRole('button', { name: choice, exact: true }).click()
      await expect.poll(() => requests.length).toBe(1)
      expect(requests[0]).toBe(
        `consent_token=test-consent-only&action=${choice === 'Allow' ? 'approve' : 'deny'}`,
      )
    })

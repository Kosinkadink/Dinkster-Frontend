import { expect, test } from '../../e2e/visual.js'
import type {
  DesktopEnvironment,
  EnvironmentBridge,
  EnvironmentRequest,
} from '../src/desktop-environments-bridge.js'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const environment: DesktopEnvironment = {
      id: 'studio',
      name: 'Local studio',
      root: '/environments/studio',
      channel: 'nightly',
      sandboxPacks: true,
      engines: [
        {
          id: 'render',
          name: 'Render',
          kind: 'local',
          gpus: ['GPU-second'],
          port: 18272,
        },
        {
          id: 'preview',
          name: 'Preview',
          kind: 'local',
          gpus: [],
          port: 18273,
        },
      ],
    }
    const calls: {
      kind: string
      environment?: DesktopEnvironment
      request?: EnvironmentRequest
      token?: string
    }[] = []
    let selected = environment
    let request: EnvironmentRequest
    let failApply = false
    const host: EnvironmentBridge = {
      list: async () => ({ projects: [selected] }),
      save: async (value) => {
        calls.push({ kind: 'save', environment: value })
        selected = value
      },
      remove: async () => {
        calls.push({ kind: 'remove' })
      },
      open: async () => {
        calls.push({ kind: 'open' })
      },
      sandbox: async () => ({
        available: false,
        detail: 'Saved sandbox unavailable; no fallback.',
      }),
      inspect: async (input) => {
        calls.push({ kind: 'inspect', request: input })
        return {
          result: {
            operation: 'catalog',
            status: 'clean',
            plan: [],
            variants: [
              { variant: 'cpu', downloadBytes: 17003 },
              { variant: 'cuda', downloadBytes: 900001 },
            ],
          },
          hardware: { gpus: [], diagnostic: 'No NVIDIA GPUs detected.' },
          plan: {
            reason: 'CPU remains explicit.',
            choices: [
              {
                variant: 'cpu',
                supported: true,
                reason: 'Choose CPU explicitly.',
              },
              {
                variant: 'cuda',
                supported: false,
                reason: 'Driver unavailable; explicit override.',
              },
            ],
          },
        }
      },
      plan: async (value, input) => {
        calls.push({ kind: 'plan', environment: value, request: input })
        request = input
        const readOnly =
          ['space', 'status', 'doctor'].includes(input.operation) ||
          input.sourceAction === 'refs'
        return {
          ...(readOnly ? {} : { token: 'native-retained-token' }),
          result: {
            operation: input.operation,
            status: readOnly ? 'clean' : 'planned',
            plan: ['Keep snapshot 9; replace snapshot 4.'],
          },
        }
      },
      apply: async (token) => {
        calls.push({ kind: 'apply', token })
        if (failApply) throw new Error('Activation refused. Review again.')
        const reviewed = calls
          .filter((call) => call.kind === 'plan')
          .at(-1)!.environment!
        selected = reviewed
        return {
          operation: request.operation,
          status: 'applied',
          plan: ['Environment applied.'],
        }
      },
      wslStatus: async () => ({ detail: 'Private disk ready.' }),
      prepareWsl: async () => ({ detail: 'Private distribution prepared.' }),
      wslProjectRoot: async () =>
        '//wsl.localhost/Dinkster-Desktop-123456abcdef/home/studio',
      copyWslModels: async () => undefined,
    }
    Object.assign(window, {
      dinksterProjects: host,
      environmentCalls: calls,
      failEnvironmentApply: () => {
        failApply = true
      },
    })
  })
})

test('advanced controls stay collapsed, preserve saved device choices and invalidate approval', async ({
  page,
}) => {
  await page.goto('/desktop-environments.html')
  await page.getByRole('button', { name: 'Manage Render', exact: true }).click()
  await expect(
    page.getByLabel('Install location', { exact: true }),
  ).toBeHidden()
  await expect(
    page.getByRole('button', { name: 'Save existing binding', exact: true }),
  ).toBeDisabled()
  await page.screenshot({
    path: 'test-results/captures/environment-default.png',
    fullPage: true,
  })
  await page.getByText('Advanced settings', { exact: true }).click()
  await expect(
    page.getByLabel('Install location', { exact: true }),
  ).toHaveValue('/environments/studio')
  await expect(
    page.getByLabel('Assigned NVIDIA devices', { exact: true }),
  ).toHaveValue('GPU-second')
  await expect(page.getByLabel('Supervisor port', { exact: true })).toHaveValue(
    '18272',
  )
  await expect(page.getByLabel('Sandbox local pack workers')).toBeChecked()
  await expect(page.getByLabel('Sandbox local pack workers')).toBeEnabled()
  await expect(
    page.getByText('Saved sandbox unavailable; no fallback.'),
  ).toBeVisible()
  await page.getByLabel('Operation', { exact: true }).selectOption('cleanup')
  await page
    .getByLabel('Automatic cleanup', { exact: false })
    .selectOption('off')
  await page
    .getByLabel('Previous snapshots to keep', { exact: false })
    .fill('7')
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  const calls = await page.evaluate(
    () =>
      (window as unknown as { environmentCalls: unknown[] }).environmentCalls,
  )
  expect(calls).toEqual([
    {
      kind: 'plan',
      environment: expect.objectContaining({
        id: 'studio',
        channel: 'nightly',
        sandboxPacks: true,
        engines: [
          expect.objectContaining({ id: 'preview', port: 18273 }),
          expect.objectContaining({
            id: 'render',
            port: 18272,
            gpus: ['GPU-second'],
          }),
        ],
      }),
      request: {
        root: '/environments/studio',
        operation: 'cleanup',
        automaticCleanup: false,
        keepPreviousGenerations: 7,
      },
    },
  ])
  await expect(
    page.getByRole('button', { name: 'Confirm and apply' }),
  ).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: 'test-results/captures/environment-advanced.png',
    fullPage: true,
  })
  await page
    .getByLabel('Previous snapshots to keep', { exact: false })
    .fill('8')
  await expect(
    page.getByRole('button', { name: 'Confirm and apply' }),
  ).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  await page.getByRole('button', { name: 'Confirm and apply' }).click()
  await expect(
    page.getByText('Environment applied.', { exact: false }),
  ).toBeVisible()
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (
          window as unknown as {
            environmentCalls: { kind: string; token?: string }[]
          }
        ).environmentCalls.filter((call) => call.kind === 'apply'),
      ),
    )
    .toEqual([{ kind: 'apply', token: 'native-retained-token' }])
})

test('install requires explicit variant and shows field errors without a native request', async ({
  page,
}) => {
  await page.goto('/desktop-environments.html')
  await page
    .getByLabel('Environment name', { exact: true })
    .fill('New environment')
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  await expect(
    page.getByLabel('Install location', { exact: true }),
  ).toHaveAttribute('aria-invalid', 'true')
  await page
    .getByLabel('Install location', { exact: true })
    .fill('/environments/new')
  await page
    .getByRole('button', { name: 'Inspect hardware and variants' })
    .click()
  await expect(
    page.getByLabel('Hardware variant', { exact: true }),
  ).toHaveValue('')
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  await expect(
    page.getByLabel('Hardware variant', { exact: true }),
  ).toHaveAttribute('aria-invalid', 'true')
  await page.getByLabel('Hardware variant', { exact: true }).selectOption('cpu')
  await page.getByLabel('Supervisor port', { exact: true }).fill('65536')
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  await expect(
    page.getByLabel('Supervisor port', { exact: true }),
  ).toHaveAttribute('aria-invalid', 'true')
  await page.getByLabel('Supervisor port', { exact: true }).fill('18274')
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Confirm and apply' }),
  ).toBeVisible()
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          environmentCalls: { kind: string; request?: EnvironmentRequest }[]
        }
      ).environmentCalls,
  )
  expect(calls.filter((call) => call.kind === 'plan')).toHaveLength(1)
  expect(calls.at(-1)?.request).toEqual({
    root: '/environments/new',
    operation: 'setup',
    channel: 'stable',
    variant: 'cpu',
    mirrors: [],
    port: 18274,
    engine: 'main',
  })
  await page.evaluate(() =>
    (
      window as unknown as { failEnvironmentApply: () => void }
    ).failEnvironmentApply(),
  )
  await page.getByRole('button', { name: 'Confirm and apply' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Activation refused. Review again.',
  )
  await expect(
    page.getByRole('button', { name: 'Confirm and apply' }),
  ).toHaveCount(0)
})

test('read-only source review never offers Apply and source/development intent stays explicit', async ({
  page,
}) => {
  await page.goto('/desktop-environments.html')
  await page.getByRole('button', { name: 'Manage Render', exact: true }).click()
  await page.getByLabel('Operation', { exact: true }).selectOption('source')
  await page.getByLabel('Source action', { exact: true }).selectOption('refs')
  await page
    .getByLabel('Public HTTPS repository URL', { exact: false })
    .fill('https://github.com/Kosinkadink/Dinkster')
  await page.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(
    page.getByRole('button', { name: 'Confirm and apply' }),
  ).toHaveCount(0)
  await page
    .getByLabel('Source kind', { exact: true })
    .selectOption('development')
  await page
    .getByLabel('Engine source', { exact: true })
    .fill('/sources/engine')
  await page
    .getByRole('textbox', { name: 'Frontend dev server', exact: false })
    .fill('http://localhost:5173')
  await page.getByText('Advanced settings', { exact: true }).click()
  await page
    .getByRole('button', { name: 'Inspect hardware and variants' })
    .click()
  await page
    .getByLabel('Hardware variant', { exact: true })
    .selectOption('cuda')
  await page.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(
    page.getByRole('button', { name: 'Confirm and apply' }),
  ).toBeVisible()
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          environmentCalls: { kind: string; request?: EnvironmentRequest }[]
        }
      ).environmentCalls,
  )
  expect(
    calls.filter((call) => call.kind === 'plan').map((call) => call.request),
  ).toEqual([
    {
      root: '/environments/studio',
      operation: 'source',
      sourceAction: 'refs',
      sourceUrl: 'https://github.com/Kosinkadink/Dinkster',
    },
    {
      root: '/environments/studio',
      operation: 'develop',
      channel: 'nightly',
      variant: 'cuda',
      mirrors: [],
      port: 18272,
      engine: 'render',
      development: {
        engine: '/sources/engine',
        packs: [],
        frontendDev: 'http://localhost:5173',
        allowFrontendDevRemote: false,
      },
    },
  ])
})

test('narrow advanced settings remain reachable and removal requires confirmation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/desktop-environments.html')
  await page.getByRole('button', { name: 'Manage Render', exact: true }).click()
  await page.getByText('Advanced settings', { exact: true }).click()
  await expect(
    page.getByLabel('Install location', { exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: 'test-results/captures/environment-advanced-narrow.png',
    fullPage: true,
  })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page
    .getByRole('button', { name: 'Remove binding', exact: true })
    .click()
  await expect(
    page.getByRole('dialog', { name: 'Remove environment binding' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  const calls = await page.evaluate(
    () =>
      (window as unknown as { environmentCalls: unknown[] }).environmentCalls,
  )
  expect(calls).toEqual([])
})

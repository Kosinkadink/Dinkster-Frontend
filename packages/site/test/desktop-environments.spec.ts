import { expect, test } from '../../e2e/visual.js'
import type {
  DesktopEnvironment,
  EnvironmentBridge,
  EnvironmentRequest,
  EnvironmentResult,
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
    let projects = [environment]
    let request: EnvironmentRequest
    let failApply = false
    let applyWait: Promise<void> | undefined
    let releaseApply: (() => void) | undefined
    let reviewDetails: Partial<EnvironmentResult> = {}
    const host: EnvironmentBridge = {
      list: async () => ({ projects }),
      save: async (value) => {
        calls.push({ kind: 'save', environment: value })
        projects = [...projects.filter((entry) => entry.id !== value.id), value]
      },
      remove: async (id) => {
        calls.push({ kind: 'remove' })
        projects = projects.filter((entry) => entry.id !== id)
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
            ...reviewDetails,
          },
        }
      },
      apply: async (token) => {
        calls.push({ kind: 'apply', token })
        await applyWait
        if (failApply) throw new Error('Activation refused. Review again.')
        const reviewed = calls
          .filter((call) => call.kind === 'plan')
          .at(-1)!.environment!
        projects = [
          ...projects.filter((entry) => entry.id !== reviewed.id),
          reviewed,
        ]
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
      holdEnvironmentApply: () => {
        applyWait = new Promise<void>((resolve) => {
          releaseApply = resolve
        })
      },
      finishEnvironmentApply: () => releaseApply?.(),
      setEnvironmentReviewDetails: (details: Partial<EnvironmentResult>) => {
        reviewDetails = details
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

test('remote saves remain remote-only and WSL selection requires a matching private Linux root', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/desktop-environments.html')
  await page.getByText('Connect a remote environment', { exact: true }).click()
  await page
    .getByLabel('Remote environment name', { exact: true })
    .fill(' Remote studio ')
  await page
    .getByLabel('Server URL', { exact: true })
    .fill('https://studio.example.test:8443')
  await page
    .getByLabel('Remote channel', { exact: true })
    .selectOption('nightly')
  await page
    .getByRole('button', { name: 'Save remote binding', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Open Remote engine', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByLabel('Remote environment name', { exact: true }),
  ).toHaveValue('')
  await page.getByRole('button', { name: 'Manage Render', exact: true }).click()
  await page.getByText('Advanced settings', { exact: true }).click()
  await page.getByLabel('Engine host', { exact: true }).selectOption('wsl2')
  await expect(
    page.getByLabel('Install location', { exact: true }),
  ).toHaveValue('')
  await page
    .getByLabel('Install location', { exact: true })
    .fill('/environments/studio')
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  await expect(
    page.getByLabel('Install location', { exact: true }),
  ).toHaveAttribute('aria-invalid', 'true')
  await page
    .getByRole('button', { name: 'Use Linux environment folder', exact: true })
    .click()
  await expect(
    page.getByLabel('Install location', { exact: true }),
  ).toHaveValue('//wsl.localhost/Dinkster-Desktop-123456abcdef/home/studio')
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Confirm and apply', exact: true }),
  ).toBeVisible()
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          environmentCalls: {
            kind: string
            environment?: DesktopEnvironment
            request?: EnvironmentRequest
          }[]
        }
      ).environmentCalls,
  )
  expect(calls.map((call) => call.kind)).toEqual(['save', 'plan'])
  expect(calls[0]!.environment).toEqual({
    id: expect.stringMatching(/^project-/),
    name: 'Remote studio',
    channel: 'nightly',
    engines: [
      {
        id: 'remote',
        name: 'Remote engine',
        kind: 'remote',
        url: 'https://studio.example.test:8443',
      },
    ],
  })
  expect(calls[1]!.request).toEqual({
    root: '//wsl.localhost/Dinkster-Desktop-123456abcdef/home/studio',
    operation: 'update',
    channel: 'nightly',
  })
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({
    path: 'test-results/captures/environment-wsl-remote-narrow.png',
    fullPage: true,
  })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
})

test('pending Apply locks edits and dismissal and consumes the retained token once', async ({
  page,
}) => {
  await page.goto('/desktop-environments.html')
  await page.getByRole('button', { name: 'Manage Render', exact: true }).click()
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Confirm and apply', exact: true }),
  ).toBeVisible()
  await page.evaluate(() =>
    (
      window as unknown as { holdEnvironmentApply: () => void }
    ).holdEnvironmentApply(),
  )
  await page
    .getByRole('button', { name: 'Confirm and apply', exact: true })
    .click()
  await expect(
    page.getByLabel('Environment name', { exact: true }),
  ).toBeDisabled()
  await expect(page.getByLabel('Operation', { exact: true })).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Manage Preview', exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Review environment plan', exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Dismiss', exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Confirm and apply', exact: true }),
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(
    page.getByLabel('Reviewed environment details', { exact: true }),
  ).toContainText('Keep snapshot 9')
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({
    path: 'test-results/captures/environment-pending.png',
    fullPage: true,
  })
  await page.evaluate(() =>
    (
      window as unknown as { finishEnvironmentApply: () => void }
    ).finishEnvironmentApply(),
  )
  await expect(
    page.getByLabel('Environment name', { exact: true }),
  ).toBeEnabled()
  await expect(
    page.getByLabel('Reviewed environment details', { exact: true }),
  ).toContainText('Environment applied.')
  await expect(
    page.getByRole('button', { name: 'Confirm and apply', exact: true }),
  ).toHaveCount(0)
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          environmentCalls: { kind: string; token?: string }[]
        }
      ).environmentCalls,
  )
  expect(calls.filter((call) => call.kind === 'apply')).toEqual([
    { kind: 'apply', token: 'native-retained-token' },
  ])
})

test('cleanup bounds and engine identifiers validate before review while read-only accounting preserves unknown sizes', async ({
  page,
}) => {
  await page.goto('/desktop-environments.html')
  await page.getByRole('button', { name: 'Manage Render', exact: true }).click()
  await page.getByText('Advanced settings', { exact: true }).click()
  await page.getByLabel('Operation', { exact: true }).selectOption('cleanup')
  for (const invalid of ['0', '101', '1.5']) {
    await page
      .getByLabel('Previous snapshots to keep', { exact: false })
      .fill(invalid)
    await page
      .getByRole('button', { name: 'Review environment plan', exact: true })
      .click()
    await expect(
      page.getByLabel('Previous snapshots to keep', { exact: false }),
    ).toHaveAttribute('aria-invalid', 'true')
  }
  await page
    .getByLabel('Previous snapshots to keep', { exact: false })
    .fill('100')
  await page.getByLabel('Engine name', { exact: true }).fill('Upper_case')
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  await expect(page.getByLabel('Engine name', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  )
  await page.getByLabel('Engine name', { exact: true }).fill('render')
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Confirm and apply', exact: true }),
  ).toBeVisible()
  await page.evaluate(() =>
    (
      window as unknown as {
        setEnvironmentReviewDetails: (
          details: Partial<EnvironmentResult>,
        ) => void
      }
    ).setEnvironmentReviewDetails({
      cleanup: {
        policy: {
          automatic: false,
          previousSuccessfulActivations: 3,
          minimumAgeSeconds: 86400,
        },
        generations: [
          { generation: 9, status: 'retained', reasons: ['Current snapshot'] },
          { generation: 4, status: 'deferred', reasons: ['Running engine'] },
        ],
        quarantine: [
          { journal: 'cleanup-42', stage: 'retry', generations: [2] },
        ],
        warnings: ['Snapshot 4 remains in use.'],
      },
      space: {
        project: '/environments/studio',
        store: null,
        scope: 'Environment and shared store',
        sharing: 'Shared allocation is counted once.',
        complete: false,
        allocatedBytes: null,
        observedAllocatedBytes: 17003,
        sharedAllocatedBytes: 4000,
        automaticReclaimableBytes: null,
        eligibleGenerationReclaimableBytes: 7000,
        additionalExplicitReclaimableBytes: null,
        policy: {
          automatic: false,
          previousSuccessfulActivations: 3,
          minimumAgeSeconds: 86400,
        },
        settingsCommand: 'dinkster-env cleanup',
        settingsHelp: 'Review cleanup before applying.',
        generations: [
          {
            generation: 9,
            status: 'retained',
            reasons: ['Current snapshot'],
            allocationGroup: 'current',
          },
        ],
        stores: [],
        groups: {
          current: {
            exclusiveAllocatedBytes: 13003,
            sharedAllocatedBytes: 4000,
          },
        },
        warnings: ['Store measurement unavailable.'],
        cleanupWarnings: [],
        eligibilityWarnings: [],
        reclaimabilityWarnings: [],
      },
    }),
  )
  await page.getByLabel('Operation', { exact: true }).selectOption('space')
  await page
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  const details = page.getByLabel('Reviewed environment details', {
    exact: true,
  })
  await expect(details).toContainText(
    'Measurement: incomplete; unknown sizes are not zero',
  )
  await expect(details).toContainText(
    'Total allocated (shared files counted once): unavailable',
  )
  await expect(details).toContainText(
    'Observed allocation lower bound: 17,003 bytes',
  )
  await expect(details).toContainText('Snapshot 4: deferred - Running engine')
  await expect(details).toContainText(
    'Quarantine cleanup-42 (retry): snapshots 2 await retry.',
  )
  await expect(
    page.getByRole('button', { name: 'Confirm and apply', exact: true }),
  ).toHaveCount(0)
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
      operation: 'cleanup',
      keepPreviousGenerations: 100,
    },
    { root: '/environments/studio', operation: 'space' },
  ])
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({
    path: 'test-results/captures/environment-readonly-space.png',
    fullPage: true,
  })
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
  const longName = 'Studio with multiple production environments - '
    .repeat(3)
    .slice(0, 128)
  await expect(
    page.getByLabel('Environment name', { exact: true }),
  ).toHaveAttribute('maxlength', '128')
  await expect(page.getByLabel('Engine name', { exact: true })).toHaveAttribute(
    'maxlength',
    '64',
  )
  await page.getByLabel('Environment name', { exact: true }).fill(longName)
  await page
    .getByRole('button', { name: 'Save existing binding', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Save existing binding', exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByLabel('Saved environment', { exact: true }),
  ).toHaveValue('studio')
  await page
    .getByRole('button', { name: 'Dismiss notification', exact: true })
    .click()
  await page.evaluate(() => scrollTo(0, 0))
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
  expect(calls).toEqual([
    {
      kind: 'save',
      environment: expect.objectContaining({ id: 'studio', name: longName }),
    },
  ])
})

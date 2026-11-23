import { expect, test } from '../../e2e/visual.js'

test('browse projects and separately paged workflows and files without network access', async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      dinksterLibrary: {
        installations: async () => [{ id: 'studio', name: 'Local studio' }],
        projects: async (installation: string, cursor: string | null) => {
          if (installation !== 'studio') throw new Error('Wrong installation')
          if (cursor !== null && cursor !== 'next-project')
            throw new Error('Wrong project cursor')
          return cursor === null
            ? {
                items: [{ id: 'grain', name: 'Film grain tests' }],
                cursor: 'next-project',
              }
            : { items: [{ id: 'empty', name: 'Empty project' }], cursor: null }
        },
        workflows: async (
          installation: string,
          project: string,
          cursor: string | null,
        ) => {
          if (installation !== 'studio') throw new Error('Wrong installation')
          if (project === 'empty') return { items: [], cursor: null }
          if (project !== 'grain') throw new Error('Wrong project')
          if (cursor !== null && cursor !== 'next-workflow')
            throw new Error('Wrong workflow cursor')
          return cursor === null
            ? {
                items: [
                  {
                    id: 'portrait',
                    name: 'Portrait workflow',
                    description: 'Saved workflow',
                  },
                ],
                cursor: 'next-workflow',
              }
            : {
                items: [{ id: 'landscape', name: 'Landscape workflow' }],
                cursor: null,
              }
        },
        assets: async (
          installation: string,
          project: string,
          cursor: string | null,
        ) => {
          if (installation !== 'studio') throw new Error('Wrong installation')
          if (project === 'empty') return { items: [], cursor: null }
          if (project !== 'grain') throw new Error('Wrong project')
          if (cursor !== null && cursor !== 'next-file')
            throw new Error('Wrong file cursor')
          return cursor === null
            ? {
                items: [
                  {
                    id: 'image',
                    name: 'Portrait.png',
                    description: 'image/png',
                  },
                ],
                cursor: 'next-file',
              }
            : {
                items: [
                  {
                    id: 'audio',
                    name: 'Soundscape.flac',
                    description: 'audio/flac',
                  },
                ],
                cursor: null,
              }
        },
      },
    })
  })
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  await page.goto('/desktop-library.html')
  await expect(
    page.getByRole('list', { name: 'Local installations' }),
  ).toContainText('Local studio')
  await page.screenshot({
    path: 'test-results/captures/desktop-library-installations.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: 'View projects', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Local studio',
  )
  await page
    .getByRole('button', { name: 'Show more projects', exact: true })
    .click()
  await expect(
    page.getByRole('list', { name: 'Projects', exact: true }),
  ).toContainText('Empty project')
  await expect(
    page.getByRole('button', { name: 'Show more projects', exact: true }),
  ).toHaveCount(0)
  await page.screenshot({
    path: 'test-results/captures/desktop-library-projects.png',
    fullPage: true,
  })
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Film grain tests' })
    .getByRole('button')
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Film grain tests',
  )
  await expect(
    page.getByRole('button', { name: 'Open project', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('list', { name: 'Saved workflows' }),
  ).toContainText('Portrait workflow')
  await expect(
    page.getByRole('list', { name: 'Files', exact: true }),
  ).toContainText('Portrait.png')
  await page.getByRole('button', { name: 'Show more saved workflows' }).click()
  await expect(
    page.getByRole('list', { name: 'Saved workflows' }),
  ).toContainText('Landscape workflow')
  await expect(
    page.getByRole('list', { name: 'Files', exact: true }),
  ).not.toContainText('Soundscape.flac')
  await page.getByRole('button', { name: 'Show more files' }).click()
  await expect(
    page.getByRole('list', { name: 'Files', exact: true }),
  ).toContainText('Soundscape.flac')
  await page.screenshot({
    path: 'test-results/captures/desktop-library-assets.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: 'test-results/captures/desktop-library-assets-narrow.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page
    .getByRole('button', { name: 'Show more projects', exact: true })
    .click()
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Empty project' })
    .getByRole('button')
    .click()
  await expect(
    page.getByText('No saved workflows in this project.', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('No recorded files in this project.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Portrait.png', { exact: true })).toHaveCount(0)
  await page.screenshot({
    path: 'test-results/captures/desktop-library-empty.png',
    fullPage: true,
  })
  expect(
    requests.every((url) => new URL(url).origin === new URL(baseURL!).origin),
  ).toBe(true)
})

test('software history keeps snapshot identity, compatibility notices and empty/error states separate', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let mode = 'ready'
    Object.assign(window, {
      setHistoryMode: (value: string) => {
        mode = value
      },
      dinksterLibrary: {
        installations: async () => [{ id: 'studio', name: 'Selected studio' }],
        projects: async () => ({
          items: [{ id: 'grain', name: 'Film grain tests' }],
          cursor: null,
        }),
        workflows: async () => ({ items: [], cursor: null }),
        assets: async () => ({ items: [], cursor: null }),
        history: async (installation: string, project: string) => {
          if (installation !== 'studio' || project !== 'grain')
            throw new Error('Wrong selection')
          if (mode === 'error')
            throw new Error('private recovery path must not be displayed')
          return {
            installation: { id: 'resolved', name: 'Resolved studio' },
            environment: { id: 'b'.repeat(32), snapshot: '3' },
            entries:
              mode === 'empty'
                ? []
                : [
                    {
                      id: 7,
                      generation: 12,
                      timestamp: '2026-11-22T22:00:00Z',
                      reason: 'update',
                      exact: true,
                      snapshot: {
                        engine: { version: '0.2.3', release: 'a'.repeat(64) },
                        base: { id: 'cpu-base', variant: 'cpu' },
                      },
                    },
                    {
                      id: 13,
                      generation: 19,
                      timestamp: '2026-11-22T23:00:00Z',
                      reason: 'import',
                      exact: false,
                      snapshot: {
                        engine: { version: '0.2.1', release: 'older-release' },
                        base: { id: 'other-base', variant: 'cuda' },
                      },
                    },
                  ],
            notices: [
              'Snapshot 12 cannot open the migrated library without library-helper/1.',
            ],
          }
        },
      },
    })
  })
  await page.goto('/desktop-library.html')
  await page.getByRole('button', { name: 'View projects', exact: true }).click()
  await page.getByRole('button', { name: 'View assets', exact: true }).click()
  const history = page.getByRole('region', {
    name: 'Environment software history',
    exact: true,
  })
  await expect(history).toContainText('Resolved studio: active snapshot 3.')
  await expect(history).toContainText(
    'Snapshot 12 cannot open the migrated library without library-helper/1.',
  )
  const entries = history.getByRole('listitem')
  await expect(entries).toHaveCount(2)
  await expect(entries.nth(0)).toContainText('Snapshot 12')
  await expect(entries.nth(0)).toContainText(
    'History entry 7 - update. Engine 0.2.3',
  )
  await expect(entries.nth(0)).toContainText(
    'Recorded without software substitutions.',
  )
  await expect(entries.nth(1)).toContainText('Snapshot 19')
  await expect(entries.nth(1)).toContainText(
    'History entry 13 - import. Engine 0.2.1',
  )
  await expect(entries.nth(1)).toContainText(
    'Recorded with software substitutions.',
  )
  await expect(history.getByRole('button')).toHaveCount(0)
  await page.screenshot({
    path: 'test-results/captures/software-history-wide.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 900, height: 700 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: 'test-results/captures/software-history-narrow.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.evaluate(() =>
    (
      window as unknown as { setHistoryMode: (mode: string) => void }
    ).setHistoryMode('empty'),
  )
  await page.getByRole('button', { name: 'View assets', exact: true }).click()
  await expect(
    history.getByText('No recorded software snapshots.', { exact: true }),
  ).toBeVisible()
  await expect(history.getByRole('listitem')).toHaveCount(0)
  await page.screenshot({
    path: 'test-results/captures/software-history-empty.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.evaluate(() =>
    (
      window as unknown as { setHistoryMode: (mode: string) => void }
    ).setHistoryMode('error'),
  )
  await page.getByRole('button', { name: 'View assets', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Software history could not be read.',
  )
  await expect(
    page.getByText('No recorded software snapshots.', { exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByText('private recovery path must not be displayed', {
      exact: true,
    }),
  ).toHaveCount(0)
  await page.screenshot({
    path: 'test-results/captures/software-history-error.png',
    fullPage: true,
  })
})

test('leaving software history ignores its late rejection', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      dinksterLibrary: {
        installations: async () => [{ id: 'studio', name: 'Local studio' }],
        projects: async () => ({
          items: [{ id: 'grain', name: 'Film grain tests' }],
          cursor: null,
        }),
        workflows: async () => ({ items: [], cursor: null }),
        assets: async () => ({ items: [], cursor: null }),
        history: async () =>
          new Promise((_resolve, reject) => {
            Object.assign(window, {
              rejectHistory: () => reject(new Error('Late failure')),
            })
          }),
      },
    })
  })
  await page.goto('/desktop-library.html')
  await page.getByRole('button', { name: 'View projects', exact: true }).click()
  await page.getByRole('button', { name: 'View assets', exact: true }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Loading software history' }),
  ).toBeVisible()
  await page.screenshot({
    path: 'test-results/captures/software-history-loading.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.evaluate(() =>
    (window as unknown as { rejectHistory: () => void }).rejectHistory(),
  )
  await expect(
    page.getByRole('list', { name: 'Projects', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(
    page.getByRole('heading', {
      name: 'Environment software history',
      exact: true,
    }),
  ).toHaveCount(0)
})

test('an unreadable library is one plain notice, not an empty library or a storage prompt', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      dinksterLibrary: {
        installations: async () => [{ id: 'studio', name: 'Local studio' }],
        projects: async () => {
          throw new Error('records.sqlite format 9000')
        },
      },
    })
  })
  await page.goto('/desktop-library.html')
  await page.getByRole('button', { name: 'View projects', exact: true }).click()
  await expect(page.getByRole('note')).toHaveText(
    'By the way, these projects and files cannot be shown with the installed tools.',
  )
  await expect(page.getByText('No projects yet.', { exact: true })).toHaveCount(
    0,
  )
  await expect(page.getByText(/records.sqlite|format 9000/)).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.screenshot({
    path: 'test-results/captures/desktop-library-unreadable.png',
    fullPage: true,
  })
})

test('leaving a slow project list immediately ignores its late failure', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      dinksterLibrary: {
        installations: async () => [{ id: 'studio', name: 'Local studio' }],
        projects: async () =>
          new Promise((_resolve, reject) => {
            Object.assign(window, {
              rejectLibrary: () => reject(new Error('Late failure')),
            })
          }),
      },
    })
  })
  await page.goto('/desktop-library.html')
  await page.getByRole('button', { name: 'View projects', exact: true }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Loading projects' }),
  ).toHaveText('Loading projects')
  await page.screenshot({
    path: 'test-results/captures/desktop-library-loading.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Installations', exact: true }).click()
  await page.evaluate(() =>
    (window as unknown as { rejectLibrary: () => void }).rejectLibrary(),
  )
  await expect(
    page.getByRole('list', { name: 'Local installations' }),
  ).toBeVisible()
  await expect(page.getByRole('note')).toHaveCount(0)
})

test('open the selected project once, retain failures and allow a successful retry', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: [string, string][] = []
    Object.assign(window, {
      openingCalls: calls,
      dinksterLibrary: {
        installations: async () => [
          { id: 'saved-studio', name: 'Local studio' },
        ],
        projects: async () => ({
          items: [{ id: 'grain', name: 'Film grain tests' }],
          cursor: null,
        }),
        workflows: async () => ({ items: [], cursor: null }),
        assets: async () => ({ items: [], cursor: null }),
        open: (installation: string, project: string) => {
          calls.push([installation, project])
          return new Promise<void>((resolve, reject) =>
            Object.assign(window, {
              finishOpening: (success: boolean) =>
                success
                  ? resolve()
                  : reject(
                      new Error(
                        'The environment changed. Open the project again.',
                      ),
                    ),
            }),
          )
        },
      },
    })
  })
  await page.goto('/desktop-library.html')
  await page.getByRole('button', { name: 'View projects', exact: true }).click()
  await page.getByRole('button', { name: 'View assets', exact: true }).click()
  const open = page.getByRole('button', { name: 'Open project', exact: true })
  await expect(open).toHaveAttribute('data-role', 'neutral')
  await expect(open).toHaveAttribute('data-fill', 'solid')
  await page.screenshot({
    path: 'test-results/captures/desktop-library-open.png',
    fullPage: true,
  })
  await open.click()
  await expect(open).toHaveAttribute('aria-busy', 'true')
  await expect(
    page.getByRole('button', { name: 'Projects', exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Installations', exact: true }),
  ).toBeDisabled()
  await open.press('Enter')
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { openingCalls: string[][] }).openingCalls,
      ),
    )
    .toEqual([['saved-studio', 'grain']])
  await page.screenshot({
    path: 'test-results/captures/desktop-library-opening.png',
    fullPage: true,
  })
  const finish = (success: boolean) =>
    page.evaluate(
      (value) =>
        (
          window as unknown as { finishOpening: (value: boolean) => void }
        ).finishOpening(value),
      success,
    )
  await finish(false)
  await expect(page.getByRole('alert')).toHaveText(
    'The environment changed. Open the project again.',
  )
  await expect(open).toBeEnabled()
  await page.screenshot({
    path: 'test-results/captures/desktop-library-open-error.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: 'test-results/captures/desktop-library-open-error-narrow.png',
    fullPage: true,
  })
  await expect(
    page.getByRole('button', { name: 'Dismiss error', exact: true }),
  ).toBeVisible()
  await open.click()
  await expect(page.getByRole('alert')).toHaveText(
    'The environment changed. Open the project again.',
  )
  await finish(true)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('status')).toHaveText('Project opened.')
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { openingCalls: string[][] }).openingCalls,
      ),
    )
    .toEqual([
      ['saved-studio', 'grain'],
      ['saved-studio', 'grain'],
    ])
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Film grain tests',
  )
  await expect(
    page.getByRole('button', { name: 'Projects', exact: true }),
  ).toBeEnabled()
  await page.screenshot({
    path: 'test-results/captures/desktop-library-open-success-narrow.png',
    fullPage: true,
  })
})

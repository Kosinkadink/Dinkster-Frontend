import { expect, test } from '../../e2e/visual.js'

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.goto('/#page-loading')
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'))
})

test('a quick page waits for both reads without a loading sign and retains its answer during refresh', async ({
  page,
}) => {
  const section = page.getByRole('region', { name: 'Page loading' })
  const loading = section.getByRole('status')
  await section.getByRole('button', { name: 'Load quickly' }).click()
  await page.clock.runFor(20)
  await expect(section.getByText('Alex Morgan', { exact: true })).toHaveCount(0)
  await expect(loading).toHaveCount(0)
  await page.clock.runFor(60)
  await expect(section.getByText('Alex Morgan', { exact: true })).toBeVisible()
  await expect(
    section.getByText('alex@example.test', { exact: true }),
  ).toBeVisible()
  await page.clock.runFor(200)
  await expect(loading).toHaveCount(0)
  await section.getByRole('button', { name: 'Refresh account' }).click()
  await page.clock.runFor(500)
  await expect(
    section.getByText('alex@example.test', { exact: true }),
  ).toBeVisible()
  await expect(loading).toHaveCount(0)
  await page.clock.runFor(500)
  await expect(section.locator('[aria-busy]')).toHaveAttribute(
    'aria-busy',
    'false',
  )
  await expect(
    section.getByText('alex@example.test', { exact: true }),
  ).toHaveCount(0)
  await expect(
    section.getByText('alex@updated.example.test', { exact: true }),
  ).toBeVisible()
})

test('a slow page waits 200ms to show loading and holds it until 500ms', async ({
  page,
}) => {
  const section = page.getByRole('region', { name: 'Page loading' })
  await section.getByRole('button', { name: 'Load briefly' }).click()
  await page.clock.runFor(199)
  await expect(section.getByRole('status')).toHaveCount(0)
  await page.clock.runFor(1)
  await expect(section.getByRole('status')).toHaveText('Loading account')
  await page.clock.runFor(299)
  await expect(section.getByRole('status')).toBeVisible()
  await expect(section.getByText('Alex Morgan', { exact: true })).toHaveCount(0)
  await page.clock.runFor(1)
  await expect(section.getByRole('status')).toHaveCount(0)
  await expect(
    section.getByText('alex@example.test', { exact: true }),
  ).toBeVisible()
})

test('failure observes the same minimum and a superseded failure cannot replace a newer answer', async ({
  page,
}) => {
  const section = page.getByRole('region', { name: 'Page loading' })
  await section.getByRole('button', { name: 'Fail to load' }).click()
  await page.clock.runFor(499)
  await expect(section.getByRole('status')).toBeVisible()
  await expect(section.getByRole('alert')).toHaveCount(0)
  await page.clock.runFor(1)
  await expect(section.getByRole('status')).toHaveCount(0)
  await expect(section.getByRole('alert')).toHaveText(
    'The account could not be read. Try again.',
  )
  await section.getByRole('button', { name: 'Fail to load' }).click()
  await page.clock.runFor(10)
  await section.getByRole('button', { name: 'Load quickly' }).click()
  await page.clock.runFor(80)
  await expect(
    section.getByText('alex@example.test', { exact: true }),
  ).toBeVisible()
  await page.clock.runFor(600)
  await expect(section.getByRole('alert')).toHaveCount(0)
  await expect(section.getByRole('status')).toHaveCount(0)
})

test('replacing a pending read keeps an already visible loading sign until its minimum expires', async ({
  page,
}) => {
  const section = page.getByRole('region', { name: 'Page loading' })
  await section.getByRole('button', { name: 'Load slowly' }).click()
  await page.clock.runFor(220)
  await expect(section.getByRole('status')).toBeVisible()
  await section.getByRole('button', { name: 'Load quickly' }).click()
  await expect(section.getByRole('status')).toBeVisible()
  await page.clock.runFor(279)
  await expect(section.getByRole('status')).toBeVisible()
  await page.clock.runFor(1)
  await expect(section.getByRole('status')).toHaveCount(0)
  await expect(
    section.getByText('alex@example.test', { exact: true }),
  ).toBeVisible()
})

import { expect, test } from '../../e2e/visual.js'

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.goto('/#page-loading')
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'))
})

test('a quick page waits for both reads without a loading sign and retains its answer during refresh', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const section = page.getByRole('region', { name: 'Page loading' })
  const summary = page.getByRole('region', { name: 'Account summary' })
  const loading = section.getByRole('status')
  await section.getByRole('button', { name: 'Load quickly' }).click()
  await page.clock.runFor(20)
  await expect(section.getByText('Alex Morgan', { exact: true })).toHaveCount(0)
  await expect(loading).toHaveCount(0)
  await expect(
    summary.getByText('Alex Morgan uses alex@example.test.'),
  ).toHaveCount(0)
  await page.clock.runFor(60)
  await expect(section.getByText('Alex Morgan', { exact: true })).toBeVisible()
  await expect(
    section.getByText('alex@example.test', { exact: true }),
  ).toBeVisible()
  await expect(
    summary.getByText('Alex Morgan uses alex@example.test.'),
  ).toBeVisible()
  await expect(section.locator('.dinkster-page-load-answer')).toHaveCSS(
    'animation-duration',
    '0.2s',
  )
  await expect(summary.locator('.dinkster-page-load-answer')).toHaveCSS(
    'animation-duration',
    '0.24s',
  )
  await page.clock.runFor(200)
  await expect(loading).toHaveCount(0)
  await section.getByRole('button', { name: 'Refresh account' }).click()
  await page.clock.runFor(500)
  await expect(
    section.getByText('alex@example.test', { exact: true }),
  ).toBeVisible()
  await expect(
    summary.getByText('Alex Morgan uses alex@example.test.'),
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
  await expect(
    summary.getByText('Alex Morgan uses alex@updated.example.test.'),
  ).toBeVisible()
  await expect(
    summary.getByText('Alex Morgan uses alex@example.test.'),
  ).toHaveCount(0)
  await expect(
    section.getByRole('button', { name: 'Refresh account' }),
  ).toBeFocused()
})

test('a slow page waits 200ms to show loading and holds it until 500ms', async ({
  page,
}) => {
  const section = page.getByRole('region', { name: 'Page loading' })
  const summary = page.getByRole('region', { name: 'Account summary' })
  const heading = summary.getByRole('heading', { name: 'Account summary' })
  const headingBounds = await heading.boundingBox()
  const activity = page.getByText('No action yet', { exact: true })
  const activityBounds = await activity.boundingBox()
  await section.getByRole('button', { name: 'Load briefly' }).click()
  await page.clock.runFor(199)
  await expect(section.getByRole('status')).toHaveCount(0)
  await page.clock.runFor(1)
  await expect(section.getByRole('status')).toHaveText('Loading account')
  await expect(summary.getByRole('status')).toHaveCount(0)
  await expect(
    summary.getByText('Alex Morgan uses alex@example.test.'),
  ).toHaveCount(0)
  await page.clock.runFor(299)
  await expect(section.getByRole('status')).toBeVisible()
  await expect(section.getByText('Alex Morgan', { exact: true })).toHaveCount(0)
  await page.clock.runFor(1)
  await expect(section.getByRole('status')).toHaveCount(0)
  await expect(
    section.getByText('alex@example.test', { exact: true }),
  ).toBeVisible()
  expect(await heading.boundingBox()).toEqual(headingBounds)
  expect(await activity.boundingBox()).toEqual(activityBounds)
})

test('failure observes the same minimum and a superseded failure cannot replace a newer answer', async ({
  page,
}) => {
  const section = page.getByRole('region', { name: 'Page loading' })
  const summary = page.getByRole('region', { name: 'Account summary' })
  await section.getByRole('button', { name: 'Fail to load' }).click()
  await page.clock.runFor(499)
  await expect(section.getByRole('status')).toBeVisible()
  await expect(section.getByRole('alert')).toHaveCount(0)
  await page.clock.runFor(1)
  await expect(section.getByRole('status')).toHaveCount(0)
  await expect(section.getByRole('alert')).toHaveText(
    'The account could not be read.',
  )
  await expect(summary.getByRole('alert')).toHaveCount(0)
  await expect(summary.getByRole('button', { name: 'Try again' })).toHaveCount(
    0,
  )
  await expect(
    summary.getByText('Alex Morgan uses alex@example.test.'),
  ).toHaveCount(0)
  await section.getByRole('button', { name: 'Try again' }).click()
  await page.clock.runFor(500)
  await expect(section.getByRole('alert')).toHaveCount(0)
  await expect(
    section.getByText('alex@example.test', { exact: true }),
  ).toBeVisible()
  await expect(
    summary.getByText('Alex Morgan uses alex@example.test.'),
  ).toBeVisible()
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

test('the content frame stays fixed, centres loading, and retains the last answer below a failed refresh and retry', async ({
  page,
}) => {
  const section = page.getByRole('region', { name: 'Page loading' })
  await section.getByText('Fade and rise', { exact: true }).click()
  const frame = section.locator('.dinkster-page-load-example')
  const summary = page.getByRole('region', { name: 'Account summary' })
  const bounds = await frame.boundingBox()
  expect(bounds).not.toBeNull()
  await section.getByRole('button', { name: 'Load slowly' }).click()
  await page.clock.runFor(200)
  const loading = await section.getByRole('status').boundingBox()
  expect(loading).not.toBeNull()
  expect(
    Math.abs(loading!.x + loading!.width / 2 - (bounds!.x + bounds!.width / 2)),
  ).toBeLessThan(1)
  expect(
    Math.abs(
      loading!.y + loading!.height / 2 - (bounds!.y + bounds!.height / 2),
    ),
  ).toBeLessThan(1)
  await page.clock.runFor(800)
  await expect(section.locator('.dinkster-page-load-answer')).toHaveCSS(
    'animation-name',
    'none',
  )
  await expect(summary.locator('.dinkster-page-load-answer')).toHaveCSS(
    'animation-name',
    'none',
  )
  await section.getByRole('button', { name: 'Fail to load' }).click()
  await page.clock.runFor(250)
  const alert = section.getByRole('alert')
  const retry = section.getByRole('button', { name: 'Try again' })
  const answer = section.getByText('alex@example.test', { exact: true })
  await expect(alert).toHaveText('The account could not be read.')
  await expect(answer).toBeVisible()
  await expect(
    summary.getByText('Alex Morgan uses alex@example.test.'),
  ).toBeVisible()
  await expect(summary.getByRole('alert')).toHaveCount(0)
  await expect(section.getByRole('status')).toHaveCount(0)
  const alertBounds = await alert.boundingBox()
  const retryBounds = await retry.boundingBox()
  const answerBounds = await answer.boundingBox()
  expect(alertBounds!.y + alertBounds!.height).toBeLessThan(retryBounds!.y)
  expect(retryBounds!.y + retryBounds!.height).toBeLessThan(answerBounds!.y)
  expect(await frame.boundingBox()).toEqual(bounds)
  await retry.click()
  await page.clock.runFor(200)
  await expect(answer).toBeVisible()
  await expect(section.getByRole('status')).toHaveCount(0)
  await page.clock.runFor(50)
  await expect(alert).toHaveCount(0)
  await expect(answer).toBeVisible()
  await expect(
    summary.getByText('Alex Morgan uses alex@example.test.'),
  ).toBeVisible()
  expect(await frame.boundingBox()).toEqual(bounds)
})

test('the rise arrival moves only the new answer six pixels over 240ms', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const section = page.getByRole('region', { name: 'Page loading' })
  const heading = section.getByRole('heading', { name: 'Page loading' })
  const bounds = await heading.boundingBox()
  await section.getByText('Fade and rise', { exact: true }).click()
  await section.getByRole('button', { name: 'Load quickly' }).click()
  await page.clock.runFor(80)
  const answer = section.locator('.dinkster-page-load-answer')
  await expect(answer).toHaveCSS('animation-duration', '0.24s')
  await expect(answer).toHaveCSS(
    'animation-timing-function',
    'cubic-bezier(0.2, 0.7, 0.2, 1)',
  )
  const frames = await answer.evaluate((element) => {
    const animation = element.getAnimations()[0]
    if (!animation) throw new Error('The answer has no arrival animation')
    animation.pause()
    animation.currentTime = 0
    const start = {
      opacity: getComputedStyle(element).opacity,
      transform: getComputedStyle(element).transform,
    }
    animation.currentTime = 240
    return {
      start,
      end: {
        opacity: getComputedStyle(element).opacity,
        transform: getComputedStyle(element).transform,
      },
    }
  })
  expect(frames.start).toEqual({
    opacity: '0',
    transform: 'matrix(1, 0, 0, 1, 0, 6)',
  })
  expect(frames.end).toEqual({ opacity: '1', transform: 'none' })
  expect(await heading.boundingBox()).toEqual(bounds)
})

test('project headings and actions stay mounted while rows and facts arrive and refresh', async ({
  page,
}) => {
  await page.goto('/#project-loading')
  const section = page.getByRole('region', { name: 'Project loading' })
  const heading = section.getByRole('heading', {
    name: 'Projects',
    exact: true,
  })
  const headingBounds = await heading.boundingBox()
  const owner = section.getByRole('term').filter({ hasText: 'Owner' })
  const ownerBounds = await owner.boundingBox()
  const list = section.getByRole('listbox', { name: 'Projects' })
  const create = section.getByRole('button', { name: 'New', exact: true })
  const read = section.getByRole('button', { name: 'Read projects' })
  await expect(list).toHaveCount(0)
  await read.click()
  await page.clock.runFor(200)
  await expect(section.getByRole('status')).toHaveText('Loading projects')
  await create.click()
  await expect(
    section.getByText('New project opened', { exact: true }),
  ).toBeVisible()
  await page.clock.runFor(800)
  await expect(list).toBeVisible()
  await expect(create).toBeFocused()
  expect(await heading.boundingBox()).toEqual(headingBounds)
  expect(await owner.boundingBox()).toEqual(ownerBounds)
  await expect(
    section.getByRole('definition').filter({ hasText: 'Alex Morgan' }),
  ).toBeVisible()
  await list.getByRole('option', { name: /Alex Morgan/ }).click()
  await page.keyboard.press('End')
  await expect(
    list.getByRole('option', { name: /Settings audit/ }),
  ).toBeFocused()
  await read.click()
  await page.clock.runFor(500)
  await expect(
    list.getByRole('option', { name: /Settings audit/ }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(section.getByRole('status')).toHaveCount(0)
  await create.click()
  await page.clock.runFor(500)
  await expect(create).toBeFocused()
  await expect(
    list.getByRole('option', { name: /Settings audit/ }),
  ).toHaveAttribute('aria-selected', 'true')
  expect(await heading.boundingBox()).toEqual(headingBounds)
  expect(await owner.boundingBox()).toEqual(ownerBounds)
  await page.setViewportSize({ width: 390, height: 900 })
  await expect(
    section.getByRole('group', { name: 'Loaded project facts' }),
  ).toHaveScreenshot('project-answer-facts-narrow.png')
})

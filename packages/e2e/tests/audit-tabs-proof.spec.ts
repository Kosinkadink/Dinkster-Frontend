import { expect, test } from '@playwright/test'

test('tabs expose complete ARIA relationships and keyboard focus behavior without document mutation', async ({ page }) => {
  await page.goto('/tabs-proof.html')
  const tablist = page.getByRole('tablist', { name: 'Proof inspector' })
  const overview = page.getByRole('tab', { name: 'Overview' })
  const disabled = page.getByRole('tab', { name: 'Disabled' })
  const activity = page.getByRole('tab', { name: 'Activity' })

  await expect(tablist).toHaveAttribute('aria-orientation', 'horizontal')
  await expect(overview).toHaveAttribute('aria-selected', 'true')
  await expect(overview).toHaveAttribute('tabindex', '0')
  await expect(activity).toHaveAttribute('tabindex', '-1')
  await expect(disabled).toBeDisabled()

  const relationshipsResolve = await page.locator('[role="tablist"]').evaluate((list) => {
    const elements = Array.from(list.parentElement!.querySelectorAll<HTMLElement>('[role="tab"], [role="tabpanel"]'))
    const ids = elements.map((element) => element.id)
    return new Set(ids).size === ids.length && elements.every((element) => {
      const targetId = element.getAttribute(element.getAttribute('role') === 'tab' ? 'aria-controls' : 'aria-labelledby')
      const target = targetId === null ? null : document.getElementById(targetId)
      const reciprocal = element.getAttribute('role') === 'tab' ? 'aria-labelledby' : 'aria-controls'
      return target !== null && target.getAttribute(reciprocal) === element.id
    })
  })
  expect(relationshipsResolve).toBe(true)

  const initialRevision = await page.evaluate(() => (Reflect.get(window, '__tabsProofRevision') as () => number)())
  await overview.focus()
  await overview.press('ArrowRight')
  await expect(activity).toBeFocused()
  await expect(activity).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Activity' })).toBeVisible()
  await expect(activity).toHaveCSS('outline-style', 'solid')

  await activity.press('Home')
  await expect(overview).toBeFocused()
  await overview.press('End')
  await expect(activity).toBeFocused()
  await activity.press('Tab')
  await expect(page.getByRole('tabpanel', { name: 'Activity' })).toBeFocused()

  await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__tabsProofRevision') as () => number)())).toBe(initialRevision)
})

test('dynamic removal repairs focused-tab ownership without reclaiming external focus', async ({ page }) => {
  await page.goto('/tabs-proof.html')
  await page.evaluate(() => (Reflect.get(window, '__tabsProofPrepareRemoval') as () => void)())
  const nearby = page.getByRole('tab', { name: 'Nearby' })
  const activity = page.getByRole('tab', { name: 'Activity' })

  await activity.focus()
  await page.evaluate(() => (Reflect.get(window, '__tabsProofRemove') as (id: string) => void)('activity'))
  await expect(nearby).toBeFocused()
  await expect(nearby).toHaveAttribute('aria-selected', 'true')

  await page.reload()
  await page.evaluate(() => (Reflect.get(window, '__tabsProofPrepareRemoval') as () => void)())
  const reloadedActivity = page.getByRole('tab', { name: 'Activity' })
  const outside = page.getByTestId('outside-focus')
  await reloadedActivity.focus()
  await outside.focus()
  await page.evaluate(() => (Reflect.get(window, '__tabsProofRemove') as (id: string) => void)('activity'))
  await expect(outside).toBeFocused()
})

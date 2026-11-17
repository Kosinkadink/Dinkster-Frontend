import { expect, test } from '@playwright/test'
import { canvasGalleryPages } from '../../canvas/gallery/fixtures.js'

for (const theme of ['dark', 'light'] as const) {
  for (const [id, label] of canvasGalleryPages) {
    test(`${label}, ${theme}`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto('/#canvas')
      await page
        .getByRole('button', {
          name: `${theme === 'dark' ? 'Dark' : 'Light'} theme`,
          exact: true,
        })
        .click()
      await page.getByRole('button', { name: label, exact: true }).click()
      const canvas = page.getByRole('img', {
        name: `${id} in ${theme} theme`,
        exact: true,
      })
      await expect(canvas).toHaveAttribute('data-ready', `${id}-${theme}`)
      await expect(canvas).toHaveScreenshot(`${id}-${theme}.png`)
      expect(errors).toEqual([])
    })
  }
}

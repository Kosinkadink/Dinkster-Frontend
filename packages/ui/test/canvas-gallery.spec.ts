import { expect, test } from '@playwright/test'
import {
  canvasGalleryPages,
  galleryWidgetInputs,
} from '../../canvas/gallery/fixtures.js'

for (const theme of ['dark', 'light'] as const) {
  for (const [id, label] of canvasGalleryPages) {
    for (const input of id === 'widget-states'
      ? galleryWidgetInputs
      : [undefined]) {
      test(`${label}${input ? `: ${input.id}` : ''}, ${theme}`, async ({
        page,
      }) => {
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
        if (input) {
          await page
            .getByRole('combobox', { name: 'Widget kind' })
            .selectOption(input.id)
          await expect(canvas).toHaveAttribute('data-widget', input.id)
        }
        expect(
          await canvas.evaluate(
            (element) =>
              element.parentElement!.clientWidth >= element.clientWidth,
          ),
        ).toBe(true)
        for (const outline of id === 'idle-outline'
          ? ['current', 'quieter']
          : [undefined]) {
          if (outline) {
            await page
              .getByRole('combobox', { name: 'Outline look' })
              .selectOption(outline)
            await expect(canvas).toHaveAttribute('data-outline', outline)
          }
          await expect(canvas).toHaveScreenshot(
            `${id}${input && input.id !== 'float' ? `-${input.id}` : ''}${outline ? `-${outline}` : ''}-${theme}.png`,
          )
        }
        if (id === 'idle-outline') {
          await page
            .getByRole('button', { name: 'Node anatomy', exact: true })
            .click()
          const anatomy = page.getByRole('img', {
            name: `anatomy in ${theme} theme`,
            exact: true,
          })
          await expect(anatomy).toHaveAttribute('data-ready', `anatomy-${theme}`)
          await expect(anatomy).toHaveScreenshot(`anatomy-${theme}.png`)
        }
        expect(errors).toEqual([])
      })
    }
  }
}

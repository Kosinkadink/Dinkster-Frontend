import { expect, test } from '@playwright/test'
import {
  canvasGalleryPages,
  galleryWidgetInputs,
} from '../../canvas/gallery/fixtures.js'

for (const theme of ['dark', 'light'] as const) {
  test(`Previous type colors stay isolated, ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/#canvas')
    await page
      .getByRole('button', {
        name: `${theme === 'dark' ? 'Dark' : 'Light'} theme`,
        exact: true,
      })
      .click()
    await page
      .getByRole('button', { name: 'Pins and links', exact: true })
      .click()
    const canvas = page.getByRole('img', {
      name: `types in ${theme} theme`,
      exact: true,
    })
    const look = page.getByRole('combobox', { name: 'Type colors' })
    await expect(look).toHaveValue('current')
    await expect(canvas).toHaveScreenshot(`types-${theme}.png`)
    await look.selectOption('previous')
    await expect(canvas).toHaveAttribute('data-type-look', 'previous')
    await expect(canvas).toHaveScreenshot(`types-previous-${theme}.png`)
    await page
      .getByRole('button', { name: 'Node anatomy', exact: true })
      .click()
    const anatomy = page.getByRole('img', {
      name: `anatomy in ${theme} theme`,
      exact: true,
    })
    await expect(anatomy).toHaveAttribute('data-ready', `anatomy-${theme}`)
    await expect(anatomy).toHaveScreenshot(`anatomy-${theme}.png`)
  })
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
        if (id === 'idle-outline') {
          await expect(
            page.getByRole('combobox', { name: 'Outline look' }),
          ).toHaveValue('quieter')
        }
        const titles = id === 'titles' || id === 'titles-content'
        if (titles) {
          await expect(
            page.getByRole('combobox', { name: 'Title fitting' }),
          ).toHaveValue('ellipsis')
        }
        for (const look of id === 'idle-outline'
          ? ['previous', 'quieter']
          : titles
            ? ['squeeze', 'ellipsis']
            : [undefined]) {
          if (look) {
            await page
              .getByRole('combobox', {
                name: titles ? 'Title fitting' : 'Outline look',
              })
              .selectOption(look)
            await expect(canvas).toHaveAttribute(
              titles ? 'data-title-look' : 'data-outline',
              look,
            )
          }
          await expect(canvas).toHaveScreenshot(
            `${id}${input && input.id !== 'float' ? `-${input.id}` : ''}${look ? `-${look}` : ''}-${theme}.png`,
          )
        }
        if (id === 'idle-outline' || titles) {
          const look = titles ? 'squeeze' : 'previous'
          await page
            .getByRole('combobox', {
              name: titles ? 'Title fitting' : 'Outline look',
            })
            .selectOption(look)
          await expect(canvas).toHaveAttribute(
            titles ? 'data-title-look' : 'data-outline',
            look,
          )
          await page
            .getByRole('button', { name: 'Node anatomy', exact: true })
            .click()
          const anatomy = page.getByRole('img', {
            name: `anatomy in ${theme} theme`,
            exact: true,
          })
          await expect(anatomy).toHaveAttribute(
            'data-ready',
            `anatomy-${theme}`,
          )
          await expect(anatomy).toHaveScreenshot(`anatomy-${theme}.png`)
        }
        expect(errors).toEqual([])
      })
    }
  }
}

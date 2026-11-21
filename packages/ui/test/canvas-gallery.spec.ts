import { expect, test } from '@playwright/test'
import { defaultTokens } from '../../canvas/src/tokens.js'
import {
  canvasGalleryPages,
  galleryWidgetInputs,
} from '../../canvas/gallery/fixtures.js'

test('Canvas waits for the bundled italic face before publishing title paint', async ({
  page,
}) => {
  let release!: () => void
  let requested!: () => void
  const fontRequested = new Promise<void>((resolve) => {
    requested = resolve
  })
  const fontReleased = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/NotoSans-Italic-*.woff2', async (route) => {
    requested()
    await fontReleased
    await route.continue()
  })
  try {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/#canvas', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Node titles', exact: true }).click()
    await fontRequested
    const canvas = page.getByRole('img', {
      name: 'titles in dark theme',
      exact: true,
    })
    await expect(canvas).not.toHaveAttribute('data-ready', /.+/)
    await page
      .getByRole('button', { name: 'Node anatomy', exact: true })
      .click()
    const anatomy = page.getByRole('img', {
      name: 'anatomy in dark theme',
      exact: true,
    })
    await expect(anatomy).not.toHaveAttribute('data-ready', /.+/)
    release()
    await expect(anatomy).toHaveAttribute('data-ready', 'anatomy-dark')
    await page.getByRole('button', { name: 'Node titles', exact: true }).click()
    await expect(canvas).toHaveAttribute('data-ready', 'titles-dark')
    await expect(canvas).toHaveScreenshot('titles-ellipsis-dark.png')
  } finally {
    release()
  }
})

for (const theme of ['dark', 'light'] as const) {
  test(`Canvas text input preserves shared behavior at compact density, ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/#canvas')
    await page
      .getByRole('button', {
        name: `${theme === 'dark' ? 'Dark' : 'Light'} theme`,
        exact: true,
      })
      .click()
    await page
      .getByRole('button', { name: 'Core widget rows', exact: true })
      .click()
    const sample = page.getByRole('region', {
      name: 'Canvas text input',
      exact: true,
    })
    const seed = sample.getByRole('textbox', {
      name: 'Canvas seed',
      exact: true,
    })
    const ordinary = sample.getByRole('textbox', {
      name: 'Default field',
      exact: true,
    })
    for (const density of ['app', 'site']) {
      await page.evaluate((density) => {
        document.documentElement.dataset.density = density
      }, density)
      expect(
        await ordinary.evaluate(
          (element) => element.getBoundingClientRect().height,
        ),
      ).toBe(density === 'app' ? 40 : 36)
      expect(
        await seed.evaluate((element) => ({
          height: element.getBoundingClientRect().height,
          fontSize: getComputedStyle(element).fontSize,
        })),
      ).toEqual({ height: 24, fontSize: '12px' })
    }
    await expect(seed).toHaveValue('18446744073709551615')
    await expect(seed).toHaveAttribute('inputmode', 'numeric')
    await seed.fill('9007199254740993')
    await expect(seed).toHaveValue('9007199254740993')
    const decimal = sample.getByRole('textbox', {
      name: 'Canvas decimal',
      exact: true,
    })
    await expect(decimal).toHaveAttribute('inputmode', 'decimal')
    await decimal.fill('-0.000125')
    await expect(decimal).toHaveValue('-0.000125')
    await expect(
      sample.getByRole('textbox', {
        name: 'Unavailable canvas field',
        exact: true,
      }),
    ).toBeDisabled()
    await expect(
      sample.getByRole('textbox', {
        name: 'Read-only canvas field',
        exact: true,
      }),
    ).not.toBeEditable()
    const invalid = sample.getByRole('textbox', {
      name: 'Invalid canvas field',
      exact: true,
    })
    await expect(invalid).toHaveAttribute('aria-invalid', 'true')
    await expect(invalid).toHaveAccessibleDescription('Enter a numeric value.')
    await seed.focus()
    await page.keyboard.press('End')
    await expect(seed).toBeFocused()
    expect(
      await seed.evaluate((element) => getComputedStyle(element).outlineStyle),
    ).toBe('solid')
    await expect(sample).toHaveScreenshot(`canvas-text-input-${theme}.png`)
    await page.setViewportSize({ width: 390, height: 1000 })
    expect(
      await sample.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return [...element.querySelectorAll('input')].every((input) => {
          const field = input.getBoundingClientRect()
          return field.left >= bounds.left && field.right <= bounds.right
        })
      }),
    ).toBe(true)
    await expect(sample).toHaveScreenshot(
      `canvas-text-input-narrow-${theme}.png`,
    )
  })

  test(`Tab dimensions are adjustable only in the proposal, ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 2000 })
    await page.goto('/#canvas')
    await page
      .getByRole('button', {
        name: `${theme === 'dark' ? 'Dark' : 'Light'} theme`,
        exact: true,
      })
      .click()
    await page
      .getByRole('button', { name: 'Attached tabs proposal', exact: true })
      .click()
    const canvas = page.getByRole('img', {
      name: `tabs in ${theme} theme`,
      exact: true,
    })
    await expect(canvas).toHaveAttribute('data-tab-size', '16-11-12')
    await page
      .getByRole('combobox', { name: 'Tab height', exact: true })
      .selectOption('20')
    await expect(canvas).toHaveAttribute('data-tab-size', '20-11-12')
    await page
      .getByRole('combobox', { name: 'Tab text size', exact: true })
      .selectOption('12')
    await expect(canvas).toHaveAttribute('data-tab-size', '20-12-12')
    await page
      .getByRole('combobox', { name: 'Tab side inset', exact: true })
      .selectOption('16')
    await expect(canvas).toHaveAttribute('data-tab-size', '20-12-16')
    await expect(canvas).toHaveScreenshot(`tabs-roomier-${theme}.png`)
    await page
      .getByRole('button', {
        name: 'Attached tabs at content zoom',
        exact: true,
      })
      .click()
    const content = page.getByRole('img', {
      name: `tabs-content in ${theme} theme`,
      exact: true,
    })
    await expect(content).toHaveAttribute('data-tab-size', '20-12-16')
    await expect(content).toHaveScreenshot(`tabs-content-roomier-${theme}.png`)
    await page
      .getByRole('button', { name: 'Node anatomy', exact: true })
      .click()
    await expect(
      page.getByRole('img', { name: `anatomy in ${theme} theme`, exact: true }),
    ).toHaveScreenshot(`anatomy-${theme}.png`)
  })

  test(`Attached tab overflow and hover, ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 2000 })
    await page.goto('/#canvas')
    await page
      .getByRole('button', {
        name: `${theme === 'dark' ? 'Dark' : 'Light'} theme`,
        exact: true,
      })
      .click()
    await page
      .getByRole('button', { name: 'Attached tabs proposal', exact: true })
      .click()
    const canvas = page.getByRole('img', {
      name: `tabs in ${theme} theme`,
      exact: true,
    })
    await expect(canvas).toHaveAttribute('data-ready', `tabs-${theme}`)
    await canvas.hover({ position: { x: 267, y: 846 } })
    await expect(canvas).toHaveAttribute('title', 'Detail 1')
    await expect(canvas).toHaveScreenshot(`tabs-hover-${theme}.png`)
    await page
      .getByRole('button', { name: 'Node anatomy', exact: true })
      .click()
    await expect(
      page.getByRole('img', { name: `anatomy in ${theme} theme`, exact: true }),
    ).not.toHaveAttribute('title', /.+/)
    await page
      .getByRole('button', { name: 'Attached tabs proposal', exact: true })
      .click()
    await expect(canvas).toHaveAttribute('data-ready', `tabs-${theme}`)
    await page.mouse.move(0, 0)
    await canvas.click({ position: { x: 290, y: 846 } })
    const dialog = page.getByRole('dialog', { name: 'Node details' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Detail 2', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Detail 9', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Detail 1', { exact: true })).toHaveCount(0)
    await expect(dialog).toHaveScreenshot(`tabs-overflow-${theme}.png`)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page
      .getByRole('button', { name: 'Node anatomy', exact: true })
      .click()
    await expect(
      page.getByRole('img', { name: `anatomy in ${theme} theme`, exact: true }),
    ).toHaveScreenshot(`anatomy-${theme}.png`)
  })

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
        if (id === 'node-look') {
          // One shot per node: its looks side by side in one wrapping line.
          const cards = page.locator('figure.dinkster-canvas-example canvas')
          await expect(cards).toHaveCount(36)
          for (const card of await cards.all()) {
            const cardId = (await card.getAttribute('data-testid'))!.slice(
              'node-look-'.length,
            )
            await expect(card).toHaveAttribute(
              'data-ready',
              `${cardId}-${theme}`,
            )
          }
          const groups = page.locator('.dinkster-canvas-examples')
          await expect(groups).toHaveCount(12)
          for (const [index, group] of (await groups.all()).entries()) {
            const firstId = (await group
              .locator('canvas')
              .first()
              .getAttribute('data-testid'))!
            const example = firstId.slice('node-look-'.length, -'-today'.length)
            await expect(group, `group ${index}`).toHaveScreenshot(
              `node-look-${example}-${theme}.png`,
            )
          }
          expect(errors).toEqual([])
          return
        }
        if (id === 'row-editing') {
          // Each example is its own small canvas with the open field over it.
          const examples = page.locator('figure.dinkster-canvas-example')
          await expect(examples).toHaveCount(14)
          for (const example of await examples.all()) {
            const sample = example.locator('canvas')
            const exampleId = (await sample.getAttribute('data-testid'))!.slice(
              'row-editing-'.length,
            )
            await expect(sample).toHaveAttribute(
              'data-ready',
              `${exampleId}-${theme}`,
            )
            await expect(example).toHaveScreenshot(
              `row-editing-${exampleId}-${theme}.png`,
            )
          }
          expect(errors).toEqual([])
          return
        }
        const canvas = page.getByRole('img', {
          name: `${id} in ${theme} theme`,
          exact: true,
        })
        await expect(canvas).toHaveAttribute('data-ready', `${id}-${theme}`)
        if (id === 'boundary-names') {
          const names = page.getByRole('combobox', {
            name: 'Boundary names',
            exact: true,
          })
          await expect(names).toHaveValue('ids')
          await names.selectOption('current')
          await expect(canvas).toHaveAttribute('data-boundary-names', 'current')
          await expect(canvas).toHaveScreenshot(
            `boundary-names-current-${theme}.png`,
          )
          await names.selectOption('ids')
          await expect(canvas).toHaveAttribute('data-boundary-names', 'ids')
        }
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
        const tabs = id === 'tabs' || id === 'tabs-content'
        const run = id === 'run-editable' || id === 'run-frozen'
        if (run) {
          await expect(
            page.getByText('Gallery-only run presentation.', { exact: false }),
          ).toBeVisible()
          await expect(
            page.getByRole('combobox', { name: 'Badge layout', exact: true }),
          ).toHaveValue('tabs')
        }
        if (titles) {
          await expect(
            page.getByRole('combobox', { name: 'Title fitting' }),
          ).toHaveValue('ellipsis')
        }
        for (const look of id === 'idle-outline'
          ? ['previous', 'quieter']
          : titles
            ? ['squeeze', 'ellipsis']
            : tabs
              ? ['chips', 'tabs']
              : [undefined]) {
          if (look) {
            await page
              .getByRole('combobox', {
                name: titles
                  ? 'Title fitting'
                  : tabs
                    ? 'Badge layout'
                    : 'Outline look',
              })
              .selectOption(look)
            await expect(canvas).toHaveAttribute(
              titles
                ? 'data-title-look'
                : tabs
                  ? 'data-tab-look'
                  : 'data-outline',
              look,
            )
          }
          await expect(canvas).toHaveScreenshot(
            `${id}${input && input.id !== 'float' ? `-${input.id}` : ''}${look ? `-${look}` : ''}-${theme}.png`,
          )
        }
        if (id === 'boundary-names') {
          await page
            .getByRole('combobox', { name: 'Boundary names', exact: true })
            .selectOption('current')
          await expect(canvas).toHaveAttribute('data-boundary-names', 'current')
          await page
            .getByRole('button', { name: 'Subgraph boundaries', exact: true })
            .click()
          await expect(
            page.getByRole('img', {
              name: `boundary in ${theme} theme`,
              exact: true,
            }),
          ).toHaveScreenshot(`boundary-${theme}.png`)
        }
        if (id === 'collection-rows') {
          const look = page.getByRole('combobox', {
            name: 'Collection row look',
            exact: true,
          })
          await expect(look).toHaveValue('inset-raised-collections')
          await look.selectOption(defaultTokens.widgetRowLook)
          await expect(canvas).toHaveAttribute(
            'data-row-look',
            defaultTokens.widgetRowLook,
          )
          await expect(canvas).toHaveScreenshot(
            `collection-rows-current-${theme}.png`,
          )
          await look.selectOption('inset-raised-collections')
          await expect(canvas).toHaveAttribute(
            'data-row-look',
            'inset-raised-collections',
          )
          await page
            .getByRole('button', { name: 'Widget kinds', exact: true })
            .click()
          const widgets = page.getByRole('img', {
            name: `widgets in ${theme} theme`,
            exact: true,
          })
          await expect(widgets).toHaveAttribute(
            'data-row-look',
            defaultTokens.widgetRowLook,
          )
          await expect(widgets).toHaveScreenshot(`widgets-${theme}.png`)
        }
        if (id === 'core-rows') {
          await page
            .getByRole('combobox', { name: 'Core row look', exact: true })
            .selectOption('inset')
          await expect(canvas).toHaveAttribute('data-row-look', 'inset')
          await expect(canvas).toHaveScreenshot(`core-rows-inset-${theme}.png`)
          await page
            .getByRole('button', { name: 'Node anatomy', exact: true })
            .click()
          await expect(
            page.getByRole('img', {
              name: `anatomy in ${theme} theme`,
              exact: true,
            }),
          ).toHaveScreenshot(`anatomy-${theme}.png`)
          await page
            .getByRole('button', { name: 'Widget kinds', exact: true })
            .click()
          await expect(
            page.getByRole('img', {
              name: `widgets in ${theme} theme`,
              exact: true,
            }),
          ).toHaveScreenshot(`widgets-${theme}.png`)
        }
        if (run) {
          await canvas.hover({ position: { x: 360, y: 218 } })
          await expect(canvas).toHaveAttribute('title', 'Running')
          await page.mouse.move(0, 0)
          await page
            .getByRole('combobox', { name: 'Tab height', exact: true })
            .selectOption('20')
          await expect(canvas).toHaveAttribute('data-tab-size', '20-11-12')
          await page
            .getByRole('button', { name: 'Node anatomy', exact: true })
            .click()
          await expect(
            page.getByRole('img', {
              name: `anatomy in ${theme} theme`,
              exact: true,
            }),
          ).toHaveScreenshot(`anatomy-${theme}.png`)
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

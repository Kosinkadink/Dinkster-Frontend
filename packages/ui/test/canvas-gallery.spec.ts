import { expect, test, type Page } from '@playwright/test'
import {
  canvasGalleryPages,
  galleryWidgetInputs,
} from '../../canvas/gallery/fixtures.js'

const choosePage = (page: Page, id: string) =>
  page.getByRole('combobox', { name: 'Page', exact: true }).selectOption(id)

const chooseTheme = (page: Page, theme: 'dark' | 'light') =>
  page
    .getByRole('button', {
      name: `${theme === 'dark' ? 'Dark' : 'Light'} theme`,
      exact: true,
    })
    .click()

/** Every example card on the page has painted its canvas. */
async function cardsReady(page: Page, id: string, theme: string) {
  const cards = page.locator('figure.dinkster-canvas-example canvas')
  await expect(cards.first()).toBeVisible()
  for (const card of await cards.all())
    await expect(card).toHaveAttribute('data-ready', new RegExp(`-${theme}$`))
  return cards
}

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
    await choosePage(page, 'titles')
    await fontRequested
    await expect(page.locator('figure.dinkster-canvas-example')).toHaveCount(0)
    await choosePage(page, 'anatomy')
    await expect(page.locator('figure.dinkster-canvas-example')).toHaveCount(0)
    release()
    await cardsReady(page, 'anatomy', 'dark')
    await choosePage(page, 'titles')
    await cardsReady(page, 'titles', 'dark')
    await expect(page.getByTestId('canvas-titles-1-ellipsis')).toHaveScreenshot(
      'titles-long-ordinary-ellipsis-dark.png',
    )
  } finally {
    release()
  }
})

test('Canvas pages are grouped in one list that names the selected page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#canvas')
  const list = page.getByRole('combobox', { name: 'Page', exact: true })
  await expect(list).toHaveValue('anatomy')
  const groups = await list
    .locator('optgroup')
    .evaluateAll((groups) =>
      groups.map((group) => [
        group.getAttribute('label'),
        [...group.querySelectorAll('option')].map((option) => option.value),
      ]),
    )
  expect(groups.map(([label]) => label)).toEqual([
    'Nodes',
    'Tabs and states',
    'Rows',
    'Wires',
    'Subgraphs',
    'Zoom',
  ])
  // Every page is listed exactly once.
  expect(groups.flatMap(([, ids]) => ids as string[]).sort()).toEqual(
    canvasGalleryPages.map(([id]) => id).sort(),
  )
  await choosePage(page, 'types')
  await expect(list).toHaveValue('types')
  await expect(
    page.getByRole('heading', { name: 'Pins and links', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('No action yet')).toHaveCount(0)
})

test('The selected page is linkable and steps in list order', async ({
  page,
}) => {
  await page.goto('/?page=types#canvas')
  const list = page.getByRole('combobox', { name: 'Page', exact: true })
  await expect(list).toHaveValue('types')
  const order = await list
    .locator('option')
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    )
  const at = order.indexOf('types')
  const previous = page.getByRole('button', { name: 'Previous page' })
  const next = page.getByRole('button', { name: 'Next page' })
  await next.click()
  await expect(list).toHaveValue(order[at + 1]!)
  expect(new URL(page.url()).searchParams.get('page')).toBe(order[at + 1])
  await previous.click()
  await previous.click()
  await expect(list).toHaveValue(order[at - 1]!)
  await page.reload()
  await expect(list).toHaveValue(order[at - 1]!)
  await choosePage(page, order[0]!)
  await expect(previous).toBeDisabled()
  await choosePage(page, order.at(-1)!)
  await expect(next).toBeDisabled()
  // An unknown page falls back to the first page instead of a blank view.
  await page.goto('/?page=nope#canvas')
  await expect(list).toHaveValue('anatomy')
})

test('The content column is centered beside the sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#canvas')
  const gaps = await page.evaluate(() => {
    const main = document.querySelector('.dinkster-page')!
    const content = document.querySelector('.dinkster-content')!
    const style = getComputedStyle(main)
    const area = main.getBoundingClientRect()
    const column = content.getBoundingClientRect()
    return {
      left: column.left - area.left - parseFloat(style.paddingLeft),
      right: area.right - parseFloat(style.paddingRight) - column.right,
    }
  })
  // 1440 - 240 sidebar - 2 * 32 padding leaves 1136 for a 960 column.
  expect(gaps.left).toBe(88)
  expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(1)
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
    await choosePage(page, 'core-rows')
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

  test(`Attached tab overflow and hover, ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/#canvas')
    await chooseTheme(page, theme)
    await choosePage(page, 'tabs')
    await cardsReady(page, 'tabs', theme)
    // The minimized example's first strip and its +7: measured text leaves room for two strips.
    const canvas = page.getByTestId('canvas-tabs-13-tabs')
    await canvas.hover({ position: { x: 25, y: 75 } })
    await expect(canvas).toHaveAttribute('title', 'Detail 1')
    await expect(canvas).toHaveScreenshot(`tabs-hover-${theme}.png`)
    await page.mouse.move(0, 0)
    await expect(canvas).not.toHaveAttribute('title', /.+/)
    await canvas.click({ position: { x: 64, y: 75 } })
    const dialog = page.getByRole('dialog', { name: 'Node details' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Detail 3', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Detail 9', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Detail 2', { exact: true })).toHaveCount(0)
    await expect(dialog).toHaveScreenshot(`tabs-overflow-${theme}.png`)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
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
        await chooseTheme(page, theme)
        await choosePage(page, id)
        await expect(
          page.getByRole('heading', { name: label, exact: true }),
        ).toBeVisible()
        if (input) {
          await page
            .getByRole('combobox', { name: 'Widget kind', exact: true })
            .selectOption(input.id)
          await expect(
            page.locator('figure.dinkster-canvas-example canvas').first(),
          ).toHaveAttribute('data-ready', `${id}-${theme}`)
        }
        // No comparison is behind a list: only the page list and the widget kind remain.
        await expect(page.getByRole('combobox')).toHaveCount(
          id === 'widget-states' ? 2 : 1,
        )
        const cards = await cardsReady(page, id, theme)
        const comparisons = page.locator('.dinkster-canvas-comparison')
        if (
          [
            'idle-outline',
            'titles',
            'titles-content',
            'types',
            'boundary-names',
            'widgets',
            'core-rows',
            'collection-rows',
            'editor-rows',
            'widget-driven',
            'widget-offered',
            'widget-companions',
            'widget-states',
            'run-editable',
            'run-frozen',
            'tabs',
            'tabs-content',
          ].includes(id)
        ) {
          await expect(cards).toHaveCount((await comparisons.count()) * 2)
          for (const comparison of await comparisons.all())
            await expect(comparison.locator('figcaption')).toHaveText([
              'Before',
              'After',
            ])
        } else await expect(comparisons).toHaveCount(0)
        const section = page.getByRole('region', { name: label, exact: true })
        await expect(section).toHaveScreenshot(
          `${id}${input && input.id !== 'float' ? `-${input.id}` : ''}-${theme}.png`,
        )
        if (id === 'run-editable' || id === 'run-frozen') {
          const running = page.getByTestId(`canvas-${id}-1-tabs`)
          await running.hover({ position: { x: 60, y: 175 } })
          await expect(running).toHaveAttribute('title', 'Running')
        }
        await page.setViewportSize({ width: 390, height: 1000 })
        await cardsReady(page, id, theme)
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(390)
        expect(errors).toEqual([])
      })
    }
  }
}

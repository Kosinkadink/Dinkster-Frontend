import { expect, test, type Page } from '@playwright/test'
import {
  canvasGalleryPages,
  galleryWidgetInputs,
} from '../../canvas/gallery/fixtures.js'

const sideList = (page: Page) =>
  page.getByRole('navigation', { name: 'Main navigation', exact: true })

const pageLink = (page: Page, id: string) =>
  sideList(page).locator(`a[href="?page=${id}#canvas"]`)

/** Opens a page the way a person does: its heading if closed, then the page. */
async function choosePage(page: Page, id: string) {
  const link = pageLink(page, id)
  if (!(await link.isVisible())) {
    const listId = await link.evaluate(
      (element) => element.closest('.dinkster-nav-pages')!.id,
    )
    await sideList(page).locator(`button[aria-controls="${listId}"]`).click()
  }
  await link.click()
  await expect(link).toHaveAttribute('aria-current', 'page')
}

/** Opens a page by its own link; the light theme is reached by `theme=light`. */
const openPage = (page: Page, id: string, theme: 'dark' | 'light' = 'dark') =>
  page.goto(`/?page=${id}${theme === 'light' ? '&theme=light' : ''}#canvas`)

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

test('Canvas pages are listed under six headings in the side list', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#canvas')
  const headings = sideList(page).locator('button[aria-expanded]')
  await expect(headings).toHaveText([
    'Nodes',
    'Tabs and states',
    'Rows',
    'Wires',
    'Subgraphs',
    'Zoom',
  ])
  // Only the heading holding the current page starts open.
  expect(
    await headings.evaluateAll((all) =>
      all.map((heading) => heading.getAttribute('aria-expanded')),
    ),
  ).toEqual(['true', 'false', 'false', 'false', 'false', 'false'])
  await expect(pageLink(page, 'anatomy')).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(
    sideList(page).getByRole('link', { name: 'Canvas', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  // Every page is listed exactly once.
  const listed = await sideList(page)
    .locator('a[href^="?page="]')
    .evaluateAll((links) =>
      links.map((link) =>
        new URLSearchParams(link.getAttribute('href')!.split('#')[0]).get(
          'page',
        ),
      ),
    )
  expect(listed.sort()).toEqual(canvasGalleryPages.map(([id]) => id).sort())
  // A heading opens and closes; the page picker and theme buttons are gone.
  const rows = headings.filter({ hasText: 'Rows' })
  await rows.click()
  await expect(rows).toHaveAttribute('aria-expanded', 'true')
  await expect(pageLink(page, 'row-editing')).toBeVisible()
  await rows.click()
  await expect(rows).toHaveAttribute('aria-expanded', 'false')
  await expect(pageLink(page, 'row-editing')).toBeHidden()
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /theme$/ })).toHaveCount(0)
  await expect(page.getByText('No action yet')).toHaveCount(0)
})

test('Every Canvas page opens by a click in the side list', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#canvas')
  for (const [id, label] of canvasGalleryPages) {
    await choosePage(page, id)
    await expect(
      page.getByRole('heading', { name: label, exact: true }),
    ).toBeVisible()
    expect(new URL(page.url()).searchParams.get('page')).toBe(id)
  }
})

test('A page link opens its heading, and the foot steps in list order', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openPage(page, 'types')
  const wires = sideList(page).getByRole('button', { name: 'Wires' })
  await expect(wires).toHaveAttribute('aria-expanded', 'true')
  await expect(
    sideList(page).getByRole('button', { name: 'Nodes' }),
  ).toHaveAttribute('aria-expanded', 'false')
  await expect(pageLink(page, 'types')).toHaveAttribute('aria-current', 'page')
  const steps = page.getByRole('navigation', { name: 'Canvas pages' })
  const previous = steps.locator('a[rel="prev"]')
  const next = steps.locator('a[rel="next"]')
  // Each names the page it leads to.
  await expect(previous).toHaveText(/^Previous page\s*Text box heights$/)
  await expect(next).toHaveText(/^Next page\s*Structural parts$/)
  await next.click()
  expect(new URL(page.url()).searchParams.get('page')).toBe('structure')
  await expect(pageLink(page, 'structure')).toHaveAttribute(
    'aria-current',
    'page',
  )
  // Stepping into the next heading opens it.
  await next.click()
  expect(new URL(page.url()).searchParams.get('page')).toBe('boundary')
  await expect(
    sideList(page).getByRole('button', { name: 'Subgraphs' }),
  ).toHaveAttribute('aria-expanded', 'true')
  await previous.click()
  await page.reload()
  await expect(pageLink(page, 'structure')).toHaveAttribute(
    'aria-current',
    'page',
  )
  await openPage(page, 'anatomy')
  await expect(previous).toHaveCount(0)
  await expect(next).toHaveCount(1)
  await openPage(page, 'minimap')
  await expect(next).toHaveCount(0)
  // An unknown page falls back to the first page instead of a blank view.
  await page.goto('/?page=nope#canvas')
  await expect(pageLink(page, 'anatomy')).toHaveAttribute(
    'aria-current',
    'page',
  )
})

test('The side list works from the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#canvas')
  await sideList(page)
    .getByRole('link', { name: 'Canvas', exact: true })
    .focus()
  const focused = () =>
    page.evaluate(() => document.activeElement?.textContent?.trim())
  // Tab moves through headings and the open heading's pages, in order.
  for (let i = 0; i < 20 && (await focused()) !== 'Rows'; i++)
    await page.keyboard.press('Tab')
  const rows = sideList(page).getByRole('button', { name: 'Rows' })
  await expect(rows).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(rows).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Space')
  await expect(rows).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(pageLink(page, 'widgets')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(pageLink(page, 'core-rows')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('heading', { name: 'Core widget rows', exact: true }),
  ).toBeVisible()
  await expect(pageLink(page, 'core-rows')).toHaveAttribute(
    'aria-current',
    'page',
  )
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
    await openPage(page, 'core-rows', theme)
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

  test(`Tab overflow and hover, ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openPage(page, 'tabs', theme)
    await cardsReady(page, 'tabs', theme)
    // The narrow example's first strip and its +5: measured text leaves room for four strips.
    const canvas = page.getByTestId('canvas-tabs-15')
    await canvas.hover({ position: { x: 16, y: 152 } })
    await expect(canvas).toHaveAttribute('title', 'Detail 1')
    await expect(canvas).toHaveScreenshot(`tabs-hover-${theme}.png`)
    await page.mouse.move(0, 0)
    await expect(canvas).not.toHaveAttribute('title', /.+/)
    await canvas.click({ position: { x: 88, y: 152 } })
    const dialog = page.getByRole('dialog', { name: 'Node details' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Detail 5', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Detail 9', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Detail 4', { exact: true })).toHaveCount(0)
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
        await openPage(page, id, theme)
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
        // No comparison is behind a list: only the widget kind remains,
        // besides the filters of the lists drawn open on the lists page.
        const filters = page.locator(
          'input.dinkster-canvas-field-input[role="combobox"]',
        )
        await expect(filters).toHaveCount(id === 'row-lists' ? 25 : 0)
        await expect(page.getByRole('combobox')).toHaveCount(
          (id === 'widget-states' ? 1 : 0) + (await filters.count()),
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
          const running = page.getByTestId(`canvas-${id}-1`)
          await running.hover({ position: { x: 45, y: 185 } })
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

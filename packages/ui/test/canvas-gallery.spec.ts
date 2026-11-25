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

test('Controls inside an open row use ordinary borders and a brighter keyboard border', async ({ page }) => {
  const tokenColor = async (token: string) => page.evaluate((token) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${token})`
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, token)
  await openPage(page, 'save-target-box')
  const card = page.getByTestId('save-target-box-open').locator('..')
  const mount = card.locator('.dinkster-canvas-target-choice')
  const prefix = card.locator('.dinkster-canvas-target-input')
  await expect(mount).toBeVisible()
  await expect(mount).toHaveCSS('border-color', await tokenColor('--dinkster-border-subtle'))
  const outerOutline = card.locator('.dinkster-canvas-field-outline path')
  const outerStroke = await outerOutline.evaluate((element) => getComputedStyle(element).stroke)
  await prefix.focus()
  await expect(prefix).toBeFocused()
  await expect(prefix).toHaveCSS('border-color', await tokenColor('--dinkster-border-hover'))
  await expect(prefix).toHaveCSS('outline-style', 'none')
  await expect(outerOutline).toHaveCSS('stroke', outerStroke)
  await expect(card).toHaveScreenshot('side-controls-prefix-focused-dark.png')
  const invalid = page.getByTestId('save-target-box-invalid').locator('..').locator('.dinkster-canvas-target-input')
  await invalid.focus()
  await expect(invalid).toHaveCSS('outline-color', await tokenColor('--dinkster-danger-foreground'))
  for (const [id, token] of [['not-here', '--dinkster-warning-foreground'], ['no-default', '--dinkster-danger-foreground']]) {
    const warnedMount = page.getByTestId(`save-target-box-${id}`).locator('..').locator('.dinkster-canvas-target-choice')
    await warnedMount.focus()
    await expect(warnedMount).toHaveCSS('outline-color', await tokenColor(token!))
  }
  await openPage(page, 'row-editing')
  const seed = page.getByTestId('row-editing-seed-right').locator('..')
  for (const control of [seed.locator('.dinkster-canvas-side-mode').first(), seed.locator('.dinkster-canvas-side-link').first()]) {
    await control.focus()
    await expect(control).toBeFocused()
    await expect(control).toHaveCSS('outline-style', 'none')
    await expect(control).toHaveCSS('border-width', '1px')
    await expect(control).toHaveCSS('border-color', await tokenColor('--dinkster-border-hover'))
  }
  await openPage(page, 'color-editing')
  const area = page.getByTestId('color-editing-open').locator('..').locator('.dinkster-canvas-color-area')
  await area.focus()
  await expect(area).toBeFocused()
  await expect(area).toHaveCSS('outline-style', 'none')
  await expect(area).toHaveCSS('border-width', '1px')
  await expect(area).toHaveCSS('border-color', await tokenColor('--dinkster-border-hover'))
  const swatches = page.getByTestId('color-editing-eight').locator('..').locator('.dinkster-canvas-color-swatches')
  await swatches.focus()
  await expect(swatches).toBeFocused()
  await expect(swatches).toHaveCSS('outline-style', 'none')
  await expect(swatches.locator('[data-candidate="true"]')).toHaveCSS('border-color', await tokenColor('--dinkster-border-hover'))
  await openPage(page, 'row-states')
  const stage = page.getByTestId('row-states-representation-open').locator('..')
  const filter = stage.getByRole('combobox', { name: 'Representation', exact: true })
  const nestedOutline = stage.locator('.dinkster-canvas-side-representation-list .dinkster-canvas-field-outline path')
  await filter.focus()
  await expect(filter).toBeFocused()
  await expect(filter).toHaveCSS('outline-style', 'none')
  await expect(nestedOutline).toHaveCSS('stroke', await tokenColor('--dinkster-border-hover'))
  await expect(nestedOutline).toHaveCSS('stroke-width', '1px')
  await filter.press('Escape')
  const trigger = stage.getByRole('button', { name: 'Representation Number', exact: true })
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveCSS('outline-style', 'none')
  await expect(trigger).toHaveCSS('border-color', await tokenColor('--dinkster-border-hover'))
})

test('Shared-line fields join exposed ends and keep the middle side part detached', async ({ page }) => {
  await openPage(page, 'row-states')
  for (const [id, place, value] of [['middle-field', 'below-node', '12'], ['last-field', 'right', '24'], ['first-field', 'left', '8']]) {
    const card = page.getByTestId(`row-states-${id}`).locator('..')
    const side = card.locator('.dinkster-canvas-field-side')
    await expect(side).toHaveAttribute('data-place', place!)
    await expect(card.locator('input')).toHaveValue(value!)
    const fieldBox = await card.locator('.dinkster-canvas-field').boundingBox()
    const sideBox = await side.boundingBox()
    expect(fieldBox).not.toBeNull()
    expect(sideBox).not.toBeNull()
    if (place === 'below-node') expect(sideBox!.y).toBeGreaterThan(fieldBox!.y + fieldBox!.height)
    else if (place === 'right') expect(sideBox!.x).toBeGreaterThanOrEqual(fieldBox!.x + fieldBox!.width - 1)
    else expect(sideBox!.x + sideBox!.width).toBeLessThanOrEqual(fieldBox!.x + 1)
  }
})

test('Representation filters declared looks and dismisses without changing the field', async ({ page }) => {
  await openPage(page, 'row-states')
  const labels = page.locator('.dinkster-canvas-side-representation-line .dinkster-canvas-field-label')
  await expect(labels.first()).toBeVisible()
  await expect.poll(() => labels.evaluateAll((elements) => elements.every((element) =>
    element.scrollWidth <= element.clientWidth))).toBe(true)
  const stage = page.getByTestId('row-states-representation-open').locator('..')
  const popup = stage.locator('.dinkster-canvas-side-representation-list')
  const filter = popup.getByRole('combobox', { name: 'Representation', exact: true })
  await expect(popup.locator('.dinkster-canvas-field')).toHaveAttribute('data-panel', 'below')
  const above = page.getByTestId('row-states-representation-open-above').locator('..')
  await expect(above.locator('.dinkster-canvas-side-representation-list .dinkster-canvas-field')).toHaveAttribute('data-panel', 'above')
  const draft = stage.locator('input:not([role="combobox"])')
  const trigger = stage.getByRole('button', { name: 'Representation Number', exact: true })
  await expect(draft).toHaveValue('0.65')
  await filter.press('Escape')
  await draft.fill('0.73')
  await trigger.click()
  await expect(popup.getByRole('option')).toHaveText(['Number', 'Slider'])
  await filter.fill('sl')
  await expect(popup.getByRole('option')).toHaveText(['Slider'])
  await filter.press('Escape')
  await expect(popup).toHaveCount(0)
  await expect(trigger).toBeVisible()
  await trigger.press('Enter')
  await expect(popup.getByRole('option')).toHaveText(['Number', 'Slider'])
  await popup.getByRole('option').first().click()
  await expect(popup).toHaveCount(0)
  await expect(trigger).toBeVisible()
  await expect(draft).toHaveValue('0.73')
  await trigger.press('Enter')
  await page.getByRole('heading', { name: 'Declaration row states: representation, nothing and skipped', exact: true }).click()
  await expect(popup).toHaveCount(0)
})

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

test('Canvas pages are listed under eight headings in the side list', async ({
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
    'Flow nodes',
    'Problems with fixes',
    'Zoom',
  ])
  // Only the heading holding the current page starts open.
  expect(
    await headings.evaluateAll((all) =>
      all.map((heading) => heading.getAttribute('aria-expanded')),
    ),
  ).toEqual([
    'true',
    'false',
    'false',
    'false',
    'false',
    'false',
    'false',
    'false',
  ])
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
    sideList(page).getByRole('button', { name: 'Nodes', exact: true }),
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
  await next.click()
  expect(new URL(page.url()).searchParams.get('page')).toBe('wire-looks')
  // Stepping into the next heading opens it.
  await next.click()
  expect(new URL(page.url()).searchParams.get('page')).toBe('boundary')
  await expect(
    sideList(page).getByRole('button', { name: 'Subgraphs' }),
  ).toHaveAttribute('aria-expanded', 'true')
  await previous.click()
  await page.reload()
  await expect(pageLink(page, 'wire-looks')).toHaveAttribute(
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

test('Color picker handles stay wholly inside every control', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openPage(page, 'color-editing')
  await cardsReady(page, 'color-editing', 'dark')
  const handlesOf = (id: string) =>
    page
      .locator('figure.dinkster-canvas-example', {
        has: page.getByTestId(`color-editing-${id}`),
      })
      .locator('svg:has(> .dinkster-canvas-color-handle)')
      .evaluateAll((controls) =>
        controls.map((svg) => {
          const handle = svg.querySelector<SVGGElement>('.dinkster-canvas-color-handle')!
          const box = handle.getBBox()
          const at = (value: number) => Math.round(value * 100) / 100
          return {
            shape: handle.getAttribute('data-shape'),
            x: Number(handle.getAttribute('data-x')),
            y: Number(handle.getAttribute('data-y')),
            box: { left: at(box.x), top: at(box.y), right: at(box.x + box.width), bottom: at(box.y + box.height) },
            width: Number(svg.getAttribute('width')),
            height: Number(svg.getAttribute('height')),
          }
        }),
      )
  // Every open example draws a ring on the square and an upright bar on the
  // hue strip, and on the opacity strip when the field has one. Each stays
  // inside its control; a bar spans its strip's full height.
  for (const id of ['open', 'pick', 'invalid', 'empty', 'alpha', 'clear', 'black', 'white']) {
    const handles = await handlesOf(id)
    expect(handles.map((handle) => handle.shape), id).toEqual(
      id === 'alpha' || id === 'clear' ? ['ring', 'bar', 'bar'] : ['ring', 'bar'],
    )
    for (const handle of handles) {
      expect(handle.width, id).toBeGreaterThan(12)
      expect(handle.box.left, id).toBeGreaterThanOrEqual(0)
      expect(handle.box.top, id).toBeGreaterThanOrEqual(0)
      expect(handle.box.right, id).toBeLessThanOrEqual(handle.width)
      expect(handle.box.bottom, id).toBeLessThanOrEqual(handle.height)
      if (handle.shape === 'bar') {
        expect([handle.box.top, handle.box.bottom], id).toEqual([0, handle.height])
        expect(handle.box.right - handle.box.left, id).toBeCloseTo(6, 2)
      }
    }
  }
  // Black sits in the bottom-left corner, white in the top-left with the hue
  // at the red end, and full transparency at the clear end.
  const [blackSquare] = await handlesOf('black')
  expect([blackSquare!.x, blackSquare!.y]).toEqual([6, blackSquare!.height - 6])
  const [whiteSquare, whiteHue] = await handlesOf('white')
  expect([whiteSquare!.x, whiteSquare!.y, whiteHue!.x]).toEqual([6, 6, 3])
  const clear = await handlesOf('clear')
  expect(clear[2]!.x).toBe(3)
  // Just opened, the handles already mark the stored color.
  const [square, hue] = await handlesOf('open')
  expect(square!.x).toBeCloseTo(0.75 * square!.width, 0)
  expect(square!.y).toBeCloseTo(0.2 * square!.height, 0)
  expect(hue!.x).toBeCloseTo((220 / 360) * hue!.width, 0)
})

test('An open row\'s side part draws its rules and keys in the node\'s divider and label colors', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openPage(page, 'row-editing')
  await cardsReady(page, 'row-editing', 'dark')
  const palette = (name: string) =>
    page.evaluate((name) => {
      const probe = document.createElement('span')
      probe.style.color = `var(${name})`
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }, name)
  const help = page.locator('.dinkster-canvas-side-help').first()
  const key = page.locator('.dinkster-canvas-side-fact dt').first()
  expect(
    await help.evaluate((element) => getComputedStyle(element).borderTopColor),
  ).toBe(await palette('--dinkster-border-divider'))
  expect(
    await key.evaluate((element) => getComputedStyle(element).color),
  ).toBe(await palette('--dinkster-text-secondary'))
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
    const canvas = page.getByTestId('canvas-tabs-14')
    await canvas.hover({ position: { x: 16, y: 152 } })
    await expect(canvas).toHaveAttribute('title', 'Detail 1')
    await expect(canvas).toHaveScreenshot(`tabs-hover-${theme}.png`)
    await page.mouse.move(0, 0)
    await expect(canvas).not.toHaveAttribute('title', /.+/)
    await canvas.click({ position: { x: 101, y: 152 } })
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
        // Only the widget kind, open list filters and Representation examples
        // are choices; comparisons are all visible without selecting one.
        const filters = page.locator(
          'input.dinkster-canvas-field-input[role="combobox"]:not(.dinkster-canvas-side-representation-list *)',
        )
        await expect(filters).toHaveCount(id === 'row-lists' ? 23 : id === 'row-states' ? 3 : 0)
        await expect(page.getByRole('combobox').and(
          page.locator(':not(.dinkster-canvas-side-representation *, .dinkster-canvas-side-representation-list *)'),
        )).toHaveCount(
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

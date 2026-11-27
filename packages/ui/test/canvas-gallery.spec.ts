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

test('copy amounts and Stop stay readable without widening the node', async ({ page }) => {
  await openPage(page, 'row-file-previews')
  for (const title of ['Copying a video', 'Copying in a narrow node']) {
    const card = page.locator('figure').filter({ has: page.locator('figcaption', { hasText: title }) })
    const canvas = card.locator('canvas')
    await expect(canvas).toHaveAttribute('data-ready', /-dark$/)
    const before = await canvas.boundingBox()
    const amount = card.getByText('210 MiB of 512 MiB', { exact: true })
    const stop = card.getByRole('button', { name: 'Stop', exact: true })
    await expect(amount).toBeVisible()
    await expect(stop).toBeVisible()
    expect(await amount.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    const amountBox = (await amount.boundingBox())!
    const stopBox = (await stop.boundingBox())!
    expect(stopBox.y).toBeGreaterThanOrEqual(amountBox.y + amountBox.height)
    expect(amountBox.x).toBeGreaterThanOrEqual(before!.x)
    expect(amountBox.x + amountBox.width).toBeLessThanOrEqual(before!.x + before!.width)
    await stop.click()
    await expect(card.getByRole('status')).toHaveCount(0)
    const after = (await canvas.boundingBox())!
    expect(after.width).toBe(before!.width)
    expect(after.height).toBeLessThan(before!.height)
  }
  const waiting = page.locator('figure').filter({ has: page.getByText('Waiting in a narrow node', { exact: true }) })
  const stop = waiting.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible()
  const status = (await waiting.getByRole('status').boundingBox())!
  const stopBox = (await stop.boundingBox())!
  expect(stopBox.x + stopBox.width).toBeLessThanOrEqual(status.x + status.width)
  await stop.click()
  await expect(waiting.getByRole('status')).toHaveCount(0)
})

test('choosing a fixes Review entry selects its named example on the canvas', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openPage(page, 'fixes-notice')
  const card = page.getByTestId('fixes-notice-per-node')
  await expect(card.locator('canvas')).toHaveAttribute('data-ready', /-dark$/)
  await expect(
    card.getByRole('button', {
      name: 'Open the Review upgrades setting', exact: true,
    }),
  ).toBeVisible()
  const removedChoices = page.getByTestId('fixes-notice-removed-choices')
  await expect(removedChoices.locator('canvas')).toHaveAttribute(
    'data-ready', /-dark$/,
  )
  await expect(removedChoices.getByRole('button', {
    name: 'Open the Review upgrades setting', exact: true,
  })).toHaveCount(0)
  await removedChoices.screenshot({
    path: testInfo.outputPath('review-without-settings-dark.png'),
  })
  let before = await card.locator('canvas').screenshot()
  for (const name of ['Sampler', 'Unpack frames', 'Resize image']) {
    await card
      .locator('.dinkster-fixes-review-row')
      .filter({ hasText: name })
      .click()
    await expect(card.getByRole('img')).toHaveAccessibleName(
      `Canvas with ${name} selected in dark theme`,
    )
    await expect(card.locator('canvas')).toHaveAttribute('data-ready', /-dark$/)
    await expect(card.locator('figcaption')).toHaveText(
      `Moves the canvas to ${name}.`,
    )
    const selected = await card.locator('canvas').screenshot()
    expect(selected).not.toEqual(before)
    before = selected
  }
  await expect(card).toHaveScreenshot('fixes-review-chosen-dark.png')
  await card.screenshot({
    path: testInfo.outputPath('review-chosen-canvas-dark.png'),
  })
})

test('Editor problem details open by keyboard, return focus and resolve through their action', async ({
  page,
}) => {
  await openPage(page, 'save-target-box')
  const warning = page
    .getByTestId('save-target-box-foldout-missing')
    .locator('..')
  const details = warning.getByRole('button', { name: 'Details', exact: true })
  await expect(warning.locator('.dinkster-canvas-editor-note')).toContainText(
    'usb1 not found.',
  )
  await expect(
    warning.getByRole('button', { name: 'Use project default' }),
  ).toHaveCount(0)
  await details.focus()
  await details.press('Enter')
  const note = page.getByRole('dialog', {
    name: 'usb1 is not on this machine.',
    exact: true,
  })
  await expect(
    note.getByRole('button', { name: 'Use project default' }),
  ).toBeFocused()
  await expect(
    note.getByRole('button', { name: 'Use project default' }),
  ).toHaveCSS('outline-style', 'solid')
  await expect(note).toContainText('Runs save to this project')
  await page.keyboard.press('Escape')
  await expect(note).toHaveCount(0)
  await expect(details).toBeFocused()
  await details.press('Space')
  await expect(note).toBeVisible()
  await note.getByRole('button', { name: 'Use project default' }).click()
  await expect(note).toHaveCount(0)
  await expect(details).toHaveCount(0)
  await expect(warning.locator('.dinkster-canvas-target-choice')).toContainText(
    'Project default',
  )
  const error = page
    .getByTestId('save-target-box-foldout-missing-no-default')
    .locator('..')
  await expect(error.locator('.dinkster-canvas-editor-note')).toContainText(
    'No output mount.',
  )
  await error.getByRole('button', { name: 'Details', exact: true }).click()
  const errorNote = page.getByRole('dialog', {
    name: 'usb1 is missing and this project has no default output mount.',
    exact: true,
  })
  await expect(errorNote).toBeVisible()
  await expect(
    errorNote.getByRole('button', { name: 'Open Storage' }),
  ).toBeVisible()
  await expect(
    errorNote.getByRole('button', { name: 'Open Storage' }),
  ).toBeFocused()
  await expect(
    errorNote.getByRole('button', { name: 'Open Storage' }),
  ).toHaveCSS('outline-style', 'none')
  await page
    .getByRole('heading', { name: 'Shared fold-out editor', exact: true })
    .click()
  await expect(errorNote).toHaveCount(0)
})

test('Controls inside an open row use ordinary borders and a secondary-text keyboard border', async ({
  page,
}) => {
  const tokenColor = async (token: string) =>
    page.evaluate((token) => {
      const probe = document.createElement('span')
      probe.style.color = `var(${token})`
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }, token)
  await openPage(page, 'save-target-box')
  const card = page.getByTestId('save-target-box-foldout-typing').locator('..')
  const mount = card.locator('.dinkster-canvas-target-choice')
  const prefix = card.locator('.dinkster-canvas-target-input')
  await expect(mount).toBeVisible()
  await expect(mount).toHaveCSS(
    'border-color',
    await tokenColor('--dinkster-border-subtle'),
  )
  const resting = page
    .getByTestId('save-target-box-foldout-rest')
    .locator('..')
    .locator('.dinkster-canvas-target-input')
  await expect(resting).toHaveCSS(
    'border-color',
    await tokenColor('--dinkster-border-subtle'),
  )
  await prefix.focus()
  await expect(prefix).toBeFocused()
  await expect(prefix).toHaveCSS(
    'border-color',
    await tokenColor('--dinkster-text-secondary'),
  )
  await expect(prefix).toHaveCSS('border-width', '1px')
  await expect(prefix).toHaveCSS('outline-style', 'none')
  await expect(card).toHaveScreenshot('side-controls-prefix-focused-dark.png')
  const invalid = page
    .getByTestId('save-target-box-foldout-invalid')
    .locator('..')
    .locator('.dinkster-canvas-target-input')
  await invalid.focus()
  await expect(invalid).toHaveCSS(
    'outline-color',
    await tokenColor('--dinkster-danger-foreground'),
  )
  for (const [id, token] of [
    ['foldout-missing', '--dinkster-warning-foreground'],
    ['foldout-no-default', '--dinkster-danger-foreground'],
  ]) {
    const warnedMount = page
      .getByTestId(`save-target-box-${id}`)
      .locator('..')
      .locator('.dinkster-canvas-target-choice')
    await warnedMount.focus()
    await expect(warnedMount).toHaveCSS(
      'outline-color',
      await tokenColor(token!),
    )
  }
  await openPage(page, 'row-editing')
  const seed = page.getByTestId('row-editing-seed-right').locator('..')
  for (const control of [
    seed.locator('.dinkster-canvas-side-mode').first(),
    seed.locator('.dinkster-canvas-side-link').first(),
  ]) {
    await control.focus()
    await expect(control).toBeFocused()
    await expect(control).toHaveCSS('outline-style', 'none')
    await expect(control).toHaveCSS('border-width', '1px')
    await expect(control).toHaveCSS(
      'border-color',
      await tokenColor('--dinkster-text-secondary'),
    )
  }
  await openPage(page, 'color-editing')
  const area = page
    .getByTestId('color-editing-open')
    .locator('..')
    .locator('.dinkster-canvas-color-area')
  await area.focus()
  await expect(area).toBeFocused()
  await expect(area).toHaveCSS('outline-style', 'none')
  await expect(area).toHaveCSS('border-width', '1px')
  await expect(area).toHaveCSS(
    'border-color',
    await tokenColor('--dinkster-text-secondary'),
  )
  const swatches = page
    .getByTestId('color-editing-eight')
    .locator('..')
    .locator('.dinkster-canvas-color-swatches')
  await swatches.focus()
  await expect(swatches).toBeFocused()
  await expect(swatches).toHaveCSS('outline-style', 'none')
  await expect(swatches.locator('[data-candidate="true"]')).toHaveCSS(
    'border-color',
    await tokenColor('--dinkster-text-secondary'),
  )
  await openPage(page, 'row-states')
  const stage = page.getByTestId('row-states-representation-open').locator('..')
  const filter = stage.getByRole('combobox', { name: 'Display', exact: true })
  const nestedOutline = stage.locator(
    '.dinkster-canvas-side-representation-list .dinkster-canvas-field-outline path',
  )
  await filter.focus()
  await expect(filter).toBeFocused()
  await expect(filter).toHaveCSS('outline-style', 'none')
  await expect(nestedOutline).toHaveCSS(
    'stroke',
    await tokenColor('--dinkster-text-secondary'),
  )
  await expect(nestedOutline).toHaveCSS('stroke-width', '1px')
  await filter.press('Escape')
  const trigger = stage.getByRole('button', {
    name: 'Display Number',
    exact: true,
  })
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveCSS('outline-style', 'none')
  await expect(trigger).toHaveCSS(
    'border-color',
    await tokenColor('--dinkster-text-secondary'),
  )
})

test('Save target shared fold-out distinguishes rest, typing and a reopened wired value', async ({
  playwright,
  baseURL,
  viewport,
}) => {
  // The tall comparison page otherwise switches between LCD and grayscale text on different raster backends.
  const browser = await playwright.chromium.launch({
    args: ['--disable-accelerated-2d-canvas', '--disable-lcd-text'],
  })
  const page = await browser.newPage({
    baseURL: baseURL!,
    viewport: viewport!,
    reducedMotion: 'reduce',
  })
  try {
    for (const theme of ['dark', 'light'] as const) {
      await openPage(page, 'save-target-box', theme)
      const section = page
        .getByRole('heading', { name: 'Shared fold-out editor', exact: true })
        .locator('..')
      const stage = (id: string) =>
        page.getByTestId(`save-target-box-foldout-${id}`).locator('..')
      const typing = stage('typing').locator('.dinkster-canvas-target-input')
      await expect(
        stage('folded').locator('.dinkster-canvas-editor'),
      ).toHaveCount(0)
      await expect(
        stage('rest').locator('.dinkster-canvas-editor'),
      ).toBeVisible()
      await expect(stage('wired').locator('input')).toHaveCount(0)
      const wiredName = stage('wired-open').locator('input')
      await expect(wiredName).toHaveValue('from/upstream')
      await expect(wiredName).toHaveAttribute('readonly', '')
      await expect(
        stage('wired-open').locator('.dinkster-canvas-target-choice'),
      ).toHaveCSS('opacity', '1')
      await expect(wiredName).toHaveCSS('opacity', '1')
      await expect(
        stage('invalid').getByText('Mount', { exact: true }),
      ).toBeVisible()
      const labels = await stage('rest')
        .locator(
          '.dinkster-canvas-target-label, .dinkster-canvas-target-caption',
        )
        .evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().left),
        )
      expect(labels[0]).toBe(labels[1])
      const restPadding = await stage('rest')
        .locator('.dinkster-canvas-editor')
        .evaluate(
          (element) =>
            element.clientHeight -
            element.querySelector<HTMLElement>('.dinkster-canvas-target-box')!
              .offsetHeight,
        )
      await expect
        .poll(() =>
          stage('invalid')
            .locator('.dinkster-canvas-editor')
            .evaluate(
              (element) =>
                element.clientHeight -
                element.querySelector<HTMLElement>(
                  '.dinkster-canvas-target-box',
                )!.offsetHeight,
            ),
        )
        .toBe(restPadding)
      const restInput = stage('rest').locator('.dinkster-canvas-target-input')
      const ordinary = await restInput.evaluate(
        (element) => getComputedStyle(element).borderColor,
      )
      await typing.focus()
      await expect(typing).toBeFocused()
      await expect(typing).toHaveCSS('border-width', '1px')
      await expect(typing).toHaveCSS('outline-style', 'none')
      await expect(typing).toHaveCSS(
        'border-color',
        theme === 'dark' ? 'rgb(164, 181, 183)' : 'rgb(88, 99, 109)',
      )
      expect(ordinary).toBe(
        theme === 'dark' ? 'rgb(50, 65, 67)' : 'rgb(211, 217, 222)',
      )
      await expect(restInput).toHaveCSS('border-color', ordinary)
      const chrome = await page.addStyleTag({
        content: '.dinkster-topbar { visibility: hidden; }',
      })
      await expect(section).toHaveScreenshot(`save-target-foldout-${theme}.png`)
      await chrome.evaluate((element) =>
        element.parentNode?.removeChild(element),
      )
      const missing = stage('missing')
      await expect(missing.locator('.dinkster-canvas-editor-note')).toHaveText(
        'usb1 not found.Details',
      )
      await missing
        .getByRole('button', { name: 'Details', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Use project default', exact: true })
        .click()
      await expect(missing.locator('.dinkster-canvas-editor-note')).toHaveCount(
        0,
      )
      await expect(
        missing.locator('.dinkster-canvas-target-value-text'),
      ).toHaveText('Project default')
      const changed = stage('changed')
      const expandedHeight = await changed
        .locator('.dinkster-canvas-editor')
        .evaluate((element) => element.clientHeight)
      await changed
        .getByRole('button', { name: 'Reset to default', exact: true })
        .click()
      await expect(changed.locator('input')).toHaveValue('ComfyUI')
      await expect(
        changed.getByRole('button', { name: 'Reset to default', exact: true }),
      ).toHaveCount(0)
      await expect
        .poll(() =>
          changed
            .locator('.dinkster-canvas-editor')
            .evaluate((element) => element.clientHeight),
        )
        .toBeLessThan(expandedHeight)

      const mapped = (id: string) =>
        page.getByTestId(`save-target-box-mapped-${id}`).locator('..')
      const inputs = page
        .getByRole('heading', { name: 'Ordinary Save inputs', exact: true })
        .locator('..')
      await expect(inputs).toHaveScreenshot(`save-target-mapped-${theme}.png`)
      const wiredMount = mapped('mount-wired')
      await expect(
        wiredMount.locator('.dinkster-canvas-target-mount'),
      ).toHaveAttribute('inert', '')
      await wiredMount.locator('input').fill('edited/name')
      await wiredMount
        .getByRole('button', { name: 'Reset to default', exact: true })
        .click()
      await expect(wiredMount.locator('input')).toHaveValue('ComfyUI')
      await expect(
        wiredMount.locator('.dinkster-canvas-target-value-text'),
      ).toHaveText('archive')
      const mappedName = mapped('name-wired')
      await expect(mappedName.locator('input')).toHaveAttribute('readonly', '')
      await mappedName.locator('.dinkster-canvas-target-choice').click()
      await page.getByRole('option', { name: 'archive', exact: true }).click()
      await expect(
        mappedName.locator('.dinkster-canvas-target-value-text'),
      ).toHaveText('archive')
      await expect(mappedName.locator('input')).toHaveValue('from/upstream')
    }
  } finally {
    await browser.close()
  }
})

test('Shared-line fields join exposed ends and keep the middle side part detached', async ({
  page,
}) => {
  await openPage(page, 'row-states')
  for (const [id, place, value] of [
    ['middle-field', 'below-node', '12'],
    ['last-field', 'right', '24'],
    ['first-field', 'left', '8'],
  ]) {
    const card = page.getByTestId(`row-states-${id}`).locator('..')
    const side = card.locator('.dinkster-canvas-field-side')
    await expect(side).toHaveAttribute('data-place', place!)
    await expect(card.locator('input')).toHaveValue(value!)
    const fieldBox = await card.locator('.dinkster-canvas-field').boundingBox()
    const sideBox = await side.boundingBox()
    expect(fieldBox).not.toBeNull()
    expect(sideBox).not.toBeNull()
    if (place === 'below-node')
      expect(sideBox!.y).toBeGreaterThan(fieldBox!.y + fieldBox!.height)
    else if (place === 'right')
      expect(sideBox!.x).toBeGreaterThanOrEqual(
        fieldBox!.x + fieldBox!.width - 1,
      )
    else
      expect(sideBox!.x + sideBox!.width).toBeLessThanOrEqual(fieldBox!.x + 1)
  }
})

test('Display filters declared looks and dismisses without changing the field', async ({
  page,
}) => {
  await openPage(page, 'row-states')
  const labels = page.locator(
    '.dinkster-canvas-side-representation-line .dinkster-canvas-field-label',
  )
  await expect(labels.first()).toBeVisible()
  await expect
    .poll(() =>
      labels.evaluateAll((elements) =>
        elements.every((element) => element.scrollWidth <= element.clientWidth),
      ),
    )
    .toBe(true)
  const stage = page.getByTestId('row-states-representation-open').locator('..')
  const popup = stage.locator('.dinkster-canvas-side-representation-list')
  const filter = popup.getByRole('combobox', { name: 'Display', exact: true })
  await expect(popup.locator('.dinkster-canvas-field')).toHaveAttribute(
    'data-panel',
    'below',
  )
  const above = page
    .getByTestId('row-states-representation-open-above')
    .locator('..')
  await expect(
    above.locator(
      '.dinkster-canvas-side-representation-list .dinkster-canvas-field',
    ),
  ).toHaveAttribute('data-panel', 'above')
  const draft = stage.locator('input:not([role="combobox"])')
  const trigger = stage.getByRole('button', {
    name: 'Display Number',
    exact: true,
  })
  await expect(draft).toHaveValue('0.65')
  await filter.press('Escape')
  await expect
    .poll(() =>
      trigger.evaluate((element) => {
        const style = getComputedStyle(element)
        return (
          style.borderTopLeftRadius !== '0px' &&
          [
            style.borderTopRightRadius,
            style.borderBottomLeftRadius,
            style.borderBottomRightRadius,
          ].every((radius) => radius === style.borderTopLeftRadius)
        )
      }),
    )
    .toBe(true)
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
  await page
    .getByRole('heading', {
      name: 'Declaration row states: Display, nothing and skipped',
      exact: true,
    })
    .click()
  await expect(popup).toHaveCount(0)
})

test('Curve and Save target choices escape clipped editors and stay inside the canvas', async ({
  page,
}) => {
  await openPage(page, 'editor-choice-placement')
  const stage = page.locator('.dinkster-canvas-choice-example')
  const popup = page.locator('.dinkster-canvas-editor-choice-list')
  const list = popup.getByRole('listbox')
  const checkBounds = async () => {
    await expect
      .poll(async () => {
        const bounds = (await stage.boundingBox())!
        const field = (await popup
          .locator('.dinkster-canvas-field')
          .boundingBox())!
        const panel = (await list.boundingBox())!
        return (
          field.x >= bounds.x &&
          field.y >= bounds.y &&
          field.x + field.width <= bounds.x + bounds.width + 0.1 &&
          field.y + field.height <= bounds.y + bounds.height + 0.1 &&
          panel.y >= bounds.y &&
          panel.y + panel.height <= bounds.y + bounds.height + 0.1
        )
      })
      .toBe(true)
    for (const option of await list.getByRole('option').all()) {
      expect(
        await option.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return element.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          )
        }),
      ).toBe(true)
    }
  }
  const curve = stage.getByRole('button', {
    name: 'Interpolation Linear',
    exact: true,
  })
  await curve.click()
  await expect(list.getByRole('option')).toHaveCount(3)
  await checkBounds()
  const input = popup.getByRole('combobox')
  await input.fill('mono')
  await input.press('Enter')
  await expect(
    stage.getByRole('button', {
      name: 'Interpolation Monotone cubic',
      exact: true,
    }),
  ).toBeFocused()
  const mount = stage.getByRole('button', { name: 'Mount output', exact: true })
  await mount.click()
  await expect(list.getByRole('option')).toHaveCount(6)
  await checkBounds()
  const unavailable = list.getByRole('option', { name: 'usb1', exact: true })
  await expect(unavailable).toBeDisabled()
  const unavailableBox = (await unavailable.boundingBox())!
  await page.mouse.click(
    unavailableBox.x + unavailableBox.width / 2,
    unavailableBox.y + unavailableBox.height / 2,
  )
  await expect(list).toBeVisible()
  await expect(mount).toHaveText('Mountoutput')
  await popup.getByRole('combobox').fill('arch')
  await popup.getByRole('combobox').press('Enter')
  await expect(
    stage.getByRole('button', { name: 'Mount archive', exact: true }),
  ).toBeFocused()
  await stage
    .getByRole('button', { name: 'Interpolation Monotone cubic', exact: true })
    .click()
  await popup.getByRole('combobox').press('Escape')
  await expect(popup).toHaveCount(0)
  await stage
    .getByRole('button', { name: 'Mount archive', exact: true })
    .click()
  await page
    .getByRole('heading', { name: 'Choice lists stay on the canvas' })
    .click()
  await expect(popup).toHaveCount(0)
  // A below-opening list must budget its own filter height at canvas zoom.
  for (const scale of [0.75, 1.5]) {
    await stage.evaluate((element, zoom) => {
      element.style.height = '160px'
      const editor = element.querySelectorAll<HTMLElement>(
        '.dinkster-canvas-editor',
      )[1]!
      editor.style.top = '10px'
      editor.style.transformOrigin = 'top right'
      editor.style.transform = `scale(${zoom})`
    }, scale)
    await stage
      .getByRole('button', { name: 'Mount archive', exact: true })
      .click()
    await expect(popup.locator('.dinkster-canvas-field')).toHaveAttribute(
      'data-panel',
      'below',
    )
    await expect
      .poll(async () => {
        const bounds = (await stage.boundingBox())!
        const panel = (await list.boundingBox())!
        return panel.y + panel.height <= bounds.y + bounds.height + 0.1
      })
      .toBe(true)
    await popup.getByRole('combobox').press('Escape')
  }
})

test('Node title and widget capitals are within half a pixel of their row center', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const measurements: { text: string; error: number; widget: boolean }[] = []
    Object.assign(window, { headerCapitalMeasurements: measurements })
    for (const prototype of [
      CanvasRenderingContext2D.prototype,
      OffscreenCanvasRenderingContext2D.prototype,
    ]) {
      const headers = new WeakMap<object, { top: number; height: number }>()
      const rows = new WeakMap<object, { top: number; height: number }>()
      const roundRect = prototype.roundRect
      prototype.roundRect = function (x, y, width, height, radii) {
        if (Array.isArray(radii) && radii[2] === 0 && radii[3] === 0)
          headers.set(this, { top: y, height })
        else if (width > 100 && height >= 20 && height <= 26)
          rows.set(this, { top: y, height })
        return roundRect.call(this, x, y, width, height, radii)
      }
      const fillText = prototype.fillText
      prototype.fillText = function (text, x, y, maxWidth) {
        const widget = !this.font.startsWith('600 ')
        const header = widget ? rows.get(this) : headers.get(this)
        if (
          header &&
          (!widget ||
            ['seed', '42', 'steps', '20', 'cfg', '7.5'].includes(text)) &&
          y > header.top &&
          y < header.top + header.height
        ) {
          const capitals = this.measureText('H')
          measurements.push({
            text,
            widget,
            error:
              y +
              (capitals.actualBoundingBoxDescent -
                capitals.actualBoundingBoxAscent) /
                2 -
              (header.top + header.height / 2),
          })
        }
        if (maxWidth === undefined) return fillText.call(this, text, x, y)
        return fillText.call(this, text, x, y, maxWidth)
      }
    }
  })
  await openPage(page, 'boxes')
  await cardsReady(page, 'boxes', 'dark')
  const measurements = await page.evaluate(
    () =>
      (
        window as unknown as {
          headerCapitalMeasurements: {
            text: string
            error: number
            widget: boolean
          }[]
        }
      ).headerCapitalMeasurements,
  )
  expect(measurements.some(({ text }) => text === 'Sampler')).toBe(true)
  expect(
    measurements.some(({ text, widget }) => widget && text === 'seed'),
  ).toBe(true)
  expect(measurements.some(({ text, widget }) => widget && text === '42')).toBe(
    true,
  )
  for (const { text, error } of measurements)
    expect(Math.abs(error), text).toBeLessThanOrEqual(0.5)
})

test('Step curves draw exact horizontal holds and vertical jumps without a histogram', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const theme of ['dark', 'light'] as const) {
    await page.setViewportSize({ width: 1280, height: 1000 })
    await openPage(page, 'in-node-editors', theme)
    const canvas = page.getByTestId('in-node-editor-hook-keyframes-curve')
    await expect(canvas).toHaveAttribute(
      'data-ready',
      `hook-keyframes-curve-${theme}`,
    )
    const stage = canvas.locator('..')
    await expect(stage).not.toContainText('Interpolation')
    await expect(
      page.getByTestId('in-node-editor-sample-curve').locator('..'),
    ).toContainText('Step')
    await expect(stage).not.toContainText('Histogram')
    await expect(stage.locator('.dinkster-canvas-curve-point')).toHaveCount(4)
    const points = await stage
      .locator('.dinkster-canvas-curve-line[data-held="false"]')
      .getAttribute('points')
    const vertices = points!
      .split(' ')
      .map((pair) => pair.split(',').map(Number))
    let jumps = 0
    for (let index = 1; index < vertices.length; index++) {
      const [x, y] = vertices[index]!
      const [beforeX, beforeY] = vertices[index - 1]!
      expect(x === beforeX || y === beforeY).toBe(true)
      if (y !== beforeY) {
        expect(x).toBe(beforeX)
        jumps++
      }
    }
    expect(jumps).toBe(3)
    await page.setViewportSize({ width: 390, height: 1000 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390)
  }
  expect(errors).toEqual([])
})

/** Every example card on the page has painted its canvas. */
async function cardsReady(page: Page, id: string, theme: string) {
  const cards = page.locator('figure.dinkster-canvas-example canvas')
  if (id === 'editor-choice-placement') {
    await expect(
      page.getByRole('button', { name: 'Interpolation Linear', exact: true }),
    ).toBeVisible()
    return cards
  }
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

test('Every Canvas page opens by a click in the side list', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#canvas')
  await expect(pageLink(page, 'anatomy')).toHaveAttribute('aria-current', 'page')
  await expect(
    sideList(page).getByRole('link', { name: 'Canvas', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  const rows = sideList(page).getByRole('button', { name: 'Rows', exact: true })
  await expect(rows).toHaveAttribute('aria-expanded', 'false')
  await expect(pageLink(page, 'row-editing')).toBeHidden()
  await rows.click()
  await expect(rows).toHaveAttribute('aria-expanded', 'true')
  await expect(pageLink(page, 'row-editing')).toBeVisible()
  await rows.click()
  await expect(rows).toHaveAttribute('aria-expanded', 'false')
  await expect(pageLink(page, 'row-editing')).toBeHidden()
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
          const handle = svg.querySelector<SVGGElement>(
            '.dinkster-canvas-color-handle',
          )!
          const box = handle.getBBox()
          const at = (value: number) => Math.round(value * 100) / 100
          return {
            shape: handle.getAttribute('data-shape'),
            x: Number(handle.getAttribute('data-x')),
            y: Number(handle.getAttribute('data-y')),
            box: {
              left: at(box.x),
              top: at(box.y),
              right: at(box.x + box.width),
              bottom: at(box.y + box.height),
            },
            width: Number(svg.getAttribute('width')),
            height: Number(svg.getAttribute('height')),
          }
        }),
      )
  // Every open example draws a ring on the square and an upright bar on the
  // hue strip, and on the opacity strip when the field has one. Each stays
  // inside its control; a bar spans its strip's full height.
  for (const id of [
    'open',
    'pick',
    'invalid',
    'empty',
    'alpha',
    'clear',
    'black',
    'white',
  ]) {
    const handles = await handlesOf(id)
    expect(
      handles.map((handle) => handle.shape),
      id,
    ).toEqual(
      id === 'alpha' || id === 'clear'
        ? ['ring', 'bar', 'bar']
        : ['ring', 'bar'],
    )
    for (const handle of handles) {
      expect(handle.width, id).toBeGreaterThan(12)
      expect(handle.box.left, id).toBeGreaterThanOrEqual(0)
      expect(handle.box.top, id).toBeGreaterThanOrEqual(0)
      expect(handle.box.right, id).toBeLessThanOrEqual(handle.width)
      expect(handle.box.bottom, id).toBeLessThanOrEqual(handle.height)
      if (handle.shape === 'bar') {
        expect([handle.box.top, handle.box.bottom], id).toEqual([
          0,
          handle.height,
        ])
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

test('Open rows use a quiet outline and preserve keyboard focus and side-part colors', async ({
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
  expect(await key.evaluate((element) => getComputedStyle(element).color)).toBe(
    await palette('--dinkster-text-secondary'),
  )
  for (const theme of ['dark', 'light'] as const) {
    await openPage(page, 'row-editing', theme)
    await cardsReady(page, 'row-editing', theme)
    for (const id of ['number-right', 'text-right', 'focus-number']) {
      const outline = page
        .getByTestId(`row-editing-${id}`)
        .locator('..')
        .locator('.dinkster-canvas-field-outline path')
      await expect(outline).toHaveCSS(
        'stroke',
        await palette(
          id === 'focus-number'
            ? '--dinkster-border-keyboard-focus'
            : '--dinkster-accent-rest-border',
        ),
      )
      await expect(outline).toHaveCSS(
        'stroke-width',
        id === 'focus-number' ? '1px' : '2px',
      )
    }
    await openPage(page, 'color-editing', theme)
    await cardsReady(page, 'color-editing', theme)
    const neutral = page
      .getByTestId('color-editing-wired')
      .locator('..')
      .locator('.dinkster-canvas-field-outline path')
    await expect(neutral).toHaveCSS(
      'stroke',
      await palette('--dinkster-border-subtle'),
    )
    await expect(neutral).toHaveCSS('stroke-width', '1px')
    await openPage(page, 'row-states', theme)
    await cardsReady(page, 'row-states', theme)
    const form = page.getByTestId('button-ask-form')
    const formOutline = form.locator('..').locator('..').locator('.dinkster-canvas-field-outline path')
    const start = form.getByTestId('button-ask-start')
    await start.focus()
    await page.keyboard.press('Tab')
    const end = form.getByTestId('button-ask-end')
    await expect(end).toBeFocused()
    await expect(end.locator('..')).toHaveCSS('border-color', await palette('--dinkster-border-keyboard-focus'))
    await expect(end.locator('..')).toHaveCSS('border-width', '1px')
    await expect(formOutline).toHaveCSS('stroke', await palette('--dinkster-accent-rest-border'))
    await expect(formOutline).toHaveCSS('stroke-width', '2px')
  }
})

for (const theme of ['dark', 'light'] as const) {
  test(`Solver problems name their node once on each surface, ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openPage(page, 'problem-box', theme)
    await cardsReady(page, 'problem-box', theme)
    for (const [id, title, sentence, kind] of [
      [
        'type-warning',
        'Decode',
        'Samples needs latent data, but Load image sends an image.',
        'warning',
      ],
      [
        'type-list-error',
        'Blur image',
        'Image needs one image, but Load images sends a list of images.',
        'error',
      ],
      [
        'type-group-position',
        'Pick value',
        'Position 3 was chosen, but the group has 2 values.',
        'error',
      ],
      [
        'type-selected',
        'Choose model',
        'Source is set to image, but Load latent sends latent data.',
        'warning',
      ],
      [
        'type-switch-stored',
        'Switch',
        'The inputs must be the same type, but the input branch 1 is an image and the input branch 2 is latent data.',
        'warning',
      ],
      [
        'type-switch-runtime',
        'Switch',
        'The inputs must be the same type, but the input branch 1 is an image and the input branch 2 is latent data.',
        'error',
      ],
    ] as const) {
      const card = page.locator('figure.dinkster-canvas-example', {
        has: page.getByTestId(`problem-box-${id}`),
      })
      const box = card.getByRole('dialog', {
        name: `Problems of ${title}`,
        exact: true,
      })
      await expect(box.locator('.problem-box-text')).toHaveText(sentence)
      await expect(box).toHaveAttribute('data-kind', kind)
      await expect(card.locator('.problems-group-title')).toHaveText(
        'This workflow',
      )
      await expect(card.locator('.problem-message')).toHaveText(
        `${title}: ${sentence}`,
      )
      await expect(card.locator('.problem')).toHaveAttribute(
        'data-severity',
        kind,
      )
    }
  })

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
    await page.mouse.click(0, 0)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
    await expect(dialog).toHaveCount(0)
    await canvas.click({ position: { x: 101, y: 152 } })
    await expect(dialog).toBeVisible()
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
        await expect(filters).toHaveCount(
          id === 'row-lists'
            ? 23
            : id === 'row-states'
              ? 3
              : id === 'save-target-box'
                ? 1
                : 0,
        )
        await expect(
          page
            .getByRole('combobox')
            .and(
              page.locator(
                ':not(.dinkster-canvas-side-representation *, .dinkster-canvas-side-representation-list *)',
              ),
            ),
        ).toHaveCount(
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
            'row-summaries',
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

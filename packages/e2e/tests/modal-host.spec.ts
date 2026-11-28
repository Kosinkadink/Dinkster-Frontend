/**
 * ModalHost (docs/shell.md): the shell actuates the 'modal' placement with
 * ONE host - a native <dialog> opened via showModal() - owning backdrop,
 * dialog chrome, title, close button, Escape, and the modal focus contract
 * (initial focus inside, inert background, restoration to the opener).
 * Projects is the proving resident: its body is placement-agnostic and the
 * host provides everything around it. These specs pin the host's contract;
 * settings CONTENT behavior stays pinned by settings-keybindings.spec.ts.
 */
import { expect, test } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('projects-button')).toBeVisible()
})

test('projects renders through the modal host and closes via button, backdrop, and Escape', async ({ page }) => {
  await page.getByTestId('projects-button').click()
  const surface = page.getByTestId('modal-surface')
  await expect(surface).toHaveAttribute('data-modal', 'projects')
  await expect(page.getByRole('dialog', { name: 'Projects' })).toBeVisible()

  // Host chrome close button (accessible name derives from the panel title).
  await page.getByTestId('modal-close').click()
  await expect(surface).not.toBeVisible()

  // A press on ::backdrop closes (the native dialog receives it with
  // coordinates outside its box); a press INSIDE the dialog does not.
  await page.getByTestId('projects-button').click()
  await surface.click({ position: { x: 20, y: 60 } })
  await expect(surface).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(surface).not.toBeVisible()

  // Escape closes: the native dialog handles it wherever focus sits.
  await page.getByTestId('projects-button').click()
  await expect(surface).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(surface).not.toBeVisible()
})

test('a native modal owns Escape while a Canvas view menu remains open behind it', async ({ page }) => {
  const lensSwitcher = page.getByTestId('lens-switcher')
  await lensSwitcher.click()
  await expect(lensSwitcher).toHaveAttribute('aria-expanded', 'true')

  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-testid="projects-button"]')!.click())
  const surface = page.getByTestId('modal-surface')
  await expect(surface).toBeVisible()
  await expect(lensSwitcher).toHaveAttribute('aria-expanded', 'true')

  await page.keyboard.press('Escape')
  await expect(surface).not.toBeVisible()
  await expect(lensSwitcher).toHaveAttribute('aria-expanded', 'true')
  await expect(lensSwitcher).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(lensSwitcher).toHaveAttribute('aria-expanded', 'false')
})

test('a modal owns focus: initial focus moves inside, the background is inert, closing restores the opener', async ({ page }) => {
  await page.getByTestId('projects-button').click()
  const surface = page.getByTestId('modal-surface')
  await expect(surface).toBeVisible()

  // showModal moved focus inside the dialog.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dialog = document.querySelector('dialog[data-modal]')
        return dialog !== null && dialog.contains(document.activeElement)
      }),
    )
    .toBe(true)

  // The background is inert while the modal is open: an outside control
  // refuses programmatic focus.
  await page.evaluate(() => {
    const outside = document.querySelector<HTMLElement>('[data-testid="rail-toggle"]')
    outside?.focus()
  })
  const focusEscaped = await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') === 'rail-toggle',
  )
  expect(focusEscaped).toBe(false)

  // Closing restores focus to the opener button.
  await page.keyboard.press('Escape')
  await expect(surface).not.toBeVisible()
  await expect(page.getByTestId('projects-button')).toBeFocused()
})

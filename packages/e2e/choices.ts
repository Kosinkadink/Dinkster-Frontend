import type { Locator } from '@playwright/test'

export async function chooseOption(
  control: Locator,
  label: string,
): Promise<void> {
  await control.click()
  await control
    .page()
    .getByRole('listbox')
    .getByRole('option', { name: label, exact: true })
    .click()
}

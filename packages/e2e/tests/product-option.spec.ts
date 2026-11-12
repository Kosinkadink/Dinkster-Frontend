import { expect, productOption, test } from './fixtures.js'

test('product option selection keeps its ID when other lists publish options', async ({ page }) => {
  const id = 'output"\\'
  await page.setContent('<button role="option" data-option-id="">Default</button><button role="option">Output</button><output></output>')
  await page.getByRole('option', { name: 'Output' }).evaluate((option, optionId) => {
    option.setAttribute('data-option-id', optionId)
    option.addEventListener('click', () => {
      document.querySelector('output')!.textContent = optionId
    })
  }, id)
  const option = await productOption(page, id)
  await page.evaluate(() => {
    const collection = document.createElement('div')
    collection.setAttribute('role', 'option')
    collection.textContent = 'Collection asset'
    document.body.prepend(collection)
  })
  await option.click()
  await expect(page.locator('output')).toHaveText(id)
})

import { expect, nativeTest, test } from './fixtures.js'

const probes = ['/api/nodes', '/supervisor/status']

test.beforeEach(async ({ context }) => {
  // Context routes stand in for the server; specs may override them per page.
  await context.route('**/*', (route) => route.fulfill({ status: 200, body: 'backend probe' }))
})

test('shared fixtures leave same-origin native discovery reachable', async ({ page }) => {
  for (const path of probes) {
    const response = await page.goto(path)
    expect(response!.status()).toBe(200)
    expect(await response!.text()).toBe('backend probe')
  }
})

nativeTest('explicit native tests leave both same-origin discovery probes unmocked', async ({ page }) => {
  for (const path of probes) {
    const response = await page.goto(path)
    expect(response!.status()).toBe(200)
    expect(await response!.text()).toBe('backend probe')
  }
})

test('shared discovery fixtures leave other origins and prefixed backends alone', async ({ page }) => {
  for (const path of probes) {
    for (const url of [`http://native.test${path}`, `/b2${path}`]) {
      const response = await page.goto(url)
      expect(response!.status()).toBe(200)
      expect(await response!.text()).toBe('backend probe')
    }
  }
})

test('spec routes can override both shared discovery probes', async ({ page }) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ status: 200, body: 'spec probe' }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 200, body: 'spec probe' }))
  for (const path of probes) {
    const response = await page.goto(path)
    expect(response!.status()).toBe(200)
    expect(await response!.text()).toBe('spec probe')
  }
})

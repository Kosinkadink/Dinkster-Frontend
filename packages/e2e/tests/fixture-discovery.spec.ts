import { expect, nativeTest, test } from './fixtures.js'

const probes = ['/api/nodes', '/supervisor/status']

test.beforeEach(async ({ context }) => {
  // Context routes stand in for the server, below the fixture's page routes.
  await context.route('**/*', (route) => route.fulfill({ status: 200, body: 'backend probe' }))
})

test('shared discovery fixtures honor the config and native environment opt-in', async ({ page }) => {
  const pinned = process.env['DINKSTER_E2E_FIXTURE_MODE'] === 'legacy' ||
    process.env['DINKSTER_E2E_USE_NATIVE'] !== '1'
  for (const path of probes) {
    const response = await page.goto(path)
    expect(response!.status()).toBe(pinned ? 502 : 200)
    expect(await response!.text()).toContain(pinned ? 'probe pinned off' : 'backend probe')
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

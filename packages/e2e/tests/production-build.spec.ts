import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'

const root = resolve(import.meta.dirname, '../../..')

test('production app does not expose mutable test handles', async ({
  page,
}, testInfo) => {
  const output = testInfo.outputPath('production')
  await promisify(execFile)(
    'pnpm',
    ['--filter', '@dinkster/app', 'exec', 'vite', 'build', '--outDir', output],
    { cwd: root },
  )
  await page.route('http://production.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/api/') || path.startsWith('/supervisor/')) {
      await route.fulfill({
        status: 503,
        json: { error: 'backend-unavailable' },
      })
      return
    }
    const file = resolve(output, path === '/' ? 'index.html' : `.${path}`)
    if (!file.startsWith(`${output}${sep}`)) {
      await route.fulfill({ status: 404 })
      return
    }
    try {
      const contentType =
        {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.woff2': 'font/woff2',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
        }[extname(file)] ?? 'application/octet-stream'
      await route.fulfill({ body: await readFile(file), contentType })
    } catch {
      await route.fulfill({ status: 404 })
    }
  })
  await page.goto('http://production.test/?mode=test&__dinksterTest=true')
  await expect(page.getByTestId('dinkster-menu-button')).toBeVisible()
  expect(
    await page.evaluate(() => Object.hasOwn(window, '__dinksterTest')),
  ).toBe(false)
  await page.getByTestId('settings-button').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(
    await page.evaluate(() => Object.hasOwn(window, '__dinksterTest')),
  ).toBe(false)
  await page.goto('/')
  await expect(page.getByTestId('dinkster-menu-button')).toBeVisible()
  expect(
    await page.evaluate(() => typeof window.__dinksterTest?.syntheticWorkflow),
  ).toBe('function')
})

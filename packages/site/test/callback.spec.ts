import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { expect, test } from '../../e2e/visual.js'

const template = await readFile(
  new URL('../dist/callback.html', import.meta.url),
  'utf8',
)

for (const [width, heading, message] of [
  [
    1280,
    'Sign-in complete',
    'You can return to Dinkster to continue your download.',
  ],
  [
    390,
    'Sign-in complete',
    'You can return to Dinkster to continue your download.',
  ],
  [
    390,
    'Sign-in failed',
    'The provider did not authorize this sign-in. Return to Dinkster to try again.',
  ],
] as const) {
  test(`callback ${heading} stays usable after its listener closes at ${width}px`, async ({
    browser,
  }) => {
    const values: Record<string, string> = {
      __CALLBACK_HEADING__: heading,
      __CALLBACK_MESSAGE__: message,
      __CALLBACK_RETURN_LABEL__: 'Return to Dinkster',
      __CALLBACK_RETURN_URL__: 'http://127.0.0.1:3639/',
    }
    const html = template.replace(
      /__CALLBACK_[A-Z_]+__/g,
      (slot) => values[slot]!,
    )
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        Connection: 'close',
      })
      response.end(html)
      server.close()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No listener')
    const url = `http://127.0.0.1:${address.port}/callback`
    const closed = once(server, 'close')
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width, height: 900 },
    })
    try {
      const page = await context.newPage()
      const requests: string[] = []
      page.on('request', (request) => requests.push(request.url()))
      await page.goto(url)
      await closed
      await expect(page.getByRole('heading', { name: heading })).toBeVisible()
      const link = page.getByRole('link', { name: 'Return to Dinkster' })
      await expect(link).toHaveAttribute('href', 'http://127.0.0.1:3639/')
      await link.focus()
      await expect(link).toBeFocused()
      const rendering = await page.evaluate(async () => {
        const regular = await document.fonts.load('14px "Noto Sans"')
        const bold = await document.fonts.load('bold 20px "Noto Sans"')
        const image = document.querySelector('img')!
        return {
          fonts: [...regular, ...bold].map((face) => face.status),
          wordmark: image.complete && image.naturalWidth > 0,
          card: getComputedStyle(document.querySelector('section')!)
            .backgroundColor,
          scripts: document.scripts.length,
          fits: document.documentElement.scrollWidth <= innerWidth,
        }
      })
      expect(rendering).toEqual({
        fonts: ['loaded', 'loaded'],
        wordmark: true,
        card: 'rgb(20, 28, 29)',
        scripts: 0,
        fits: true,
      })
      await page.screenshot({
        path: `test-results/captures/callback-${heading === 'Sign-in failed' ? 'failed-' : ''}${width}.png`,
        fullPage: true,
      })
      expect(requests).toEqual([url])
      await page.route('http://127.0.0.1:3639/', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<h1>Dinkster app</h1>',
        }),
      )
      await link.click()
      await expect(page).toHaveURL('http://127.0.0.1:3639/')
    } finally {
      await context.close()
      server.close()
    }
  })
}

test('callback slots keep escaped content literal and destination separate', async ({
  page,
}) => {
  const text = '<img src=x onerror="alert(1)"> & \' __CALLBACK_RETURN_URL__'
  const values: Record<string, string> = {
    __CALLBACK_HEADING__: text,
    __CALLBACK_MESSAGE__: text,
    __CALLBACK_RETURN_LABEL__: text,
    __CALLBACK_RETURN_URL__: 'http://127.0.0.1:3639/',
  }
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character]!,
    )
  await page.route('**/callback-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: template.replace(/__CALLBACK_[A-Z_]+__/g, (slot) =>
        escape(values[slot]!),
      ),
    }),
  )
  await page.goto('/callback-fixture')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(text)
  await expect(page.locator('.dinkster-description')).toHaveText(text)
  await expect(page.getByRole('region')).toHaveAttribute('aria-label', text)
  await expect(page.getByRole('link')).toHaveText(text)
  await expect(page.getByRole('link')).toHaveAttribute(
    'href',
    values.__CALLBACK_RETURN_URL__!,
  )
  await expect(page.locator('img')).toHaveCount(1)
  await expect(page.locator('[onerror]')).toHaveCount(0)
  const violations = await page.evaluate(async () => {
    const blocked = new Promise<string[]>((resolve) => {
      const directives: string[] = []
      document.addEventListener('securitypolicyviolation', (event) => {
        directives.push(event.effectiveDirective)
        if (directives.length === 2) resolve(directives.sort())
      })
    })
    const script = document.createElement('script')
    script.textContent = 'document.body.dataset.injected = "true"'
    document.body.append(script)
    document.body.setAttribute('style', 'display: none')
    return blocked
  })
  expect(violations).toEqual(['script-src-elem', 'style-src-attr'])
  await expect(page.locator('body')).not.toHaveAttribute('data-injected')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})

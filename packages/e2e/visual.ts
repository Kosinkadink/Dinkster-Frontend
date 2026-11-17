import {
  expect as baseExpect,
  test as base,
  type Locator,
  type Page,
} from '@playwright/test'

export async function waitForProductFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    const fonts = new Set<string>()
    for (const element of Array.from(document.querySelectorAll('*'))) {
      if (element.getClientRects().length === 0) continue
      const style = getComputedStyle(element)
      if (!style.fontFamily.includes('Noto Sans')) continue
      fonts.add(
        `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
      )
    }
    for (const font of fonts) {
      const faces = await document.fonts.load(font)
      if (
        faces.length === 0 ||
        faces.some((face) => face.status !== 'loaded') ||
        !document.fonts.check(font)
      )
        throw new Error(`Product font did not load: ${font}`)
    }
    await document.fonts.ready
  })
}

export const test = base.extend({
  context: async ({ context }, use) => {
    const prepare = (page: Page) => {
      const screenshot = page.screenshot.bind(page)
      page.screenshot = async (options) => {
        await waitForProductFonts(page)
        return screenshot(options)
      }
    }
    context.on('page', prepare)
    for (const page of context.pages()) prepare(page)
    await use(context)
    context.off('page', prepare)
  },
  page: async ({ page }, use) => {
    // Locator captures bypass Page.screenshot, including locators created by
    // chained getByRole/getByTestId calls. Restore the worker-local method after use.
    const prototype: Locator = Object.getPrototypeOf(page.locator('body'))
    const screenshot = prototype.screenshot
    prototype.screenshot = async function (options) {
      await waitForProductFonts(this.page())
      return screenshot.call(this, options)
    }
    try {
      await use(page)
    } finally {
      prototype.screenshot = screenshot
    }
  },
})

type ScreenshotOptions = NonNullable<Parameters<Page['screenshot']>[0]> & {
  maxDiffPixelRatio?: number
  maxDiffPixels?: number
  threshold?: number
  timeout?: number
}

export const expect = baseExpect.extend({
  async toHaveScreenshot(
    target: Page | Locator,
    nameOrOptions?: string | string[] | ScreenshotOptions,
    options?: ScreenshotOptions,
  ) {
    await waitForProductFonts('page' in target ? target.page() : target)
    try {
      const assertion = this.isNot ? baseExpect(target).not : baseExpect(target)
      if (typeof nameOrOptions === 'string' || Array.isArray(nameOrOptions))
        await assertion.toHaveScreenshot(nameOrOptions, options)
      else await assertion.toHaveScreenshot(nameOrOptions)
      return { pass: !this.isNot, message: () => '' }
    } catch (error) {
      return {
        pass: this.isNot,
        message: () => (error instanceof Error ? error.message : String(error)),
      }
    }
  },
})

export type {
  APIRequestContext,
  Locator,
  Page,
  Request,
  Route,
  TestInfo,
  WebSocketRoute,
} from '@playwright/test'

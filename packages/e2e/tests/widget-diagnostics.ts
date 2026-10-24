import { mkdirSync, writeFileSync } from 'node:fs'
import type { Fixtures, PlaywrightTestArgs } from '@playwright/test'

export const widgetDiagnostics: Fixtures<{ widgetDiagnostics: void }, {}, PlaywrightTestArgs> = {
  widgetDiagnostics: [async ({ page }, use, testInfo) => {
    const consoleMessages: object[] = []
    page.on('console', (message) => consoleMessages.push({
      at: new Date().toISOString(), type: message.type(), text: message.text(), location: message.location(),
    }))
    page.on('pageerror', (error) => consoleMessages.push({
      at: new Date().toISOString(), type: 'pageerror', text: error.stack ?? error.message,
    }))
    await page.addInitScript(() => {
      const interactions: object[] = []
      Object.assign(window, { __widgetInteractions: interactions })
      const record = (entry: object): void => {
        interactions.push({ at: new Date().toISOString(), ...entry })
        if (interactions.length > 100) interactions.shift()
      }
      const surfaces = (): string[] => Array.from(
        document.querySelectorAll('[data-testid="widget-editor"], .context-menu-cascade'),
        (element) => element.outerHTML,
      )
      for (const type of ['pointerdown', 'click', 'contextmenu', 'focusin', 'focusout']) {
        document.addEventListener(type, (event) => {
          const pointer = event instanceof MouseEvent ? event : undefined
          record({
            type, ...(pointer === undefined ? {} : { x: pointer.clientX, y: pointer.clientY, button: pointer.button }),
            target: (event.target as Element | null)?.outerHTML,
            relatedTarget: event instanceof FocusEvent ? (event.relatedTarget as Element | null)?.outerHTML : undefined,
            hitStack: pointer === undefined ? undefined : document.elementsFromPoint(pointer.clientX, pointer.clientY).map((element) => ({
              tag: element.tagName, testId: element.getAttribute('data-testid'), className: element.className,
            })),
            surfaces: surfaces(),
          })
        }, true)
      }
      new MutationObserver((records) => {
        for (const mutation of records) {
          for (const [type, nodes] of [['added', mutation.addedNodes], ['removed', mutation.removedNodes]] as const) {
            for (const node of Array.from(nodes)) {
              if (node instanceof Element && (node.matches('[data-testid="widget-editor"], .context-menu-cascade') ||
                  node.querySelector('[data-testid="widget-editor"], .context-menu-cascade') !== null)) {
                record({ type, html: node.outerHTML, surfaces: surfaces() })
              }
            }
          }
        }
      }).observe(document, { childList: true, subtree: true })
    })
    await use()
    if (testInfo.status === testInfo.expectedStatus) return
    mkdirSync(testInfo.outputDir, { recursive: true })
    const consolePath = testInfo.outputPath('custom-widget-console.json')
    writeFileSync(consolePath, JSON.stringify(consoleMessages, null, 2))
    await testInfo.attach('custom-widget-console', { path: consolePath, contentType: 'application/json' })
    if (page.isClosed()) return
    const statePath = testInfo.outputPath('custom-widget-dialog-state.json')
    writeFileSync(statePath, JSON.stringify(await page.evaluate(() => ({
      at: new Date().toISOString(), url: location.href,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      activeElement: document.activeElement?.outerHTML,
      editors: Array.from(document.querySelectorAll('[data-testid="widget-editor"], [role="dialog"], .context-menu-cascade'), (element) => ({
        html: element.outerHTML, bounds: element.getBoundingClientRect().toJSON(),
        display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility,
      })),
      interactions: (window as unknown as { __widgetInteractions?: object[] }).__widgetInteractions,
    })), null, 2))
    await testInfo.attach('custom-widget-dialog-state', { path: statePath, contentType: 'application/json' })
    const screenshotPath = testInfo.outputPath('custom-widget-failure.png')
    await page.screenshot({ path: screenshotPath, animations: 'disabled', fullPage: true })
    await testInfo.attach('custom-widget-failure', { path: screenshotPath, contentType: 'image/png' })
  }, { auto: true }],
}

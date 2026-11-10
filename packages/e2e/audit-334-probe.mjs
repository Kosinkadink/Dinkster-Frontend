import { chromium } from '@playwright/test'
import fs from 'node:fs'

const out = '/home/kosin/comfy-vibe-station/lanes/frontend-components-334-logs/probe'
fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
await page.goto('http://127.0.0.1:15630/', { waitUntil: 'load' })
await page.waitForFunction(() => Boolean(window.__dinksterTest?.app), null, { timeout: 30000 })
await page.waitForTimeout(3500)
const btn = page.locator(".template-gallery-close")
console.log('close button count', await btn.count(), await btn.textContent())
await btn.click()
await page.waitForTimeout(800)
console.log('gallery visible after click', await page.getByTestId('template-gallery').isVisible(), 'tabs', await page.evaluate(() => window.__dinksterTest.app.tabs.get().map((t) => t.id + ':' + t.title)))
await page.screenshot({ path: `${out}/after-start-blank.png` })
await page.waitForTimeout(3000)
console.log('gallery visible 3s later', await page.getByTestId('template-gallery').isVisible())
await page.screenshot({ path: `${out}/after-start-blank-3s.png` })
await browser.close()

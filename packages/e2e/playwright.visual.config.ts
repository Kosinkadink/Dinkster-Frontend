import { readFileSync, readdirSync } from 'node:fs'
import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

const specs = readdirSync(new URL('./tests/', import.meta.url)).filter((name) =>
  name.endsWith('.spec.ts') &&
  /toHaveScreenshot|toMatchSnapshot/.test(
    readFileSync(new URL(`./tests/${name}`, import.meta.url), 'utf8'),
  ),
)

export default defineConfig({
  ...base,
  projects: [{ name: 'visual', testMatch: specs.map((name) => `tests/${name}`) }],
})

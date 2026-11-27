import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ['**/canvas-equivalence.spec.ts'],
})

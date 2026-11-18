import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
export const LANE = join(dirname(fileURLToPath(import.meta.url)), '../..')
const frontend = LANE
const require = createRequire(join(frontend, 'packages/e2e/package.json'))
export const { chromium } = require('@playwright/test')
export function stats(xs) {
  if (xs.length === 0) return { n: 0 }
  const s = [...xs].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))]
  const r = (v) => Math.round(v * 100) / 100
  return {
    n: xs.length,
    avg: r(xs.reduce((a, b) => a + b, 0) / xs.length),
    p50: r(q(0.5)),
    p95: r(q(0.95)),
    p99: r(q(0.99)),
    max: r(s[s.length - 1]),
    min: r(s[0]),
  }
}

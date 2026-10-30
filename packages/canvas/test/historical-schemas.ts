import { readFileSync } from 'node:fs'
import type { NodeSchema } from '@dinkster/core'

export const historicalSchemas = new Map(Object.entries(JSON.parse(readFileSync(
  new URL('../../core/test/fixtures/historical-schemas.json', import.meta.url), 'utf8',
)) as Record<string, NodeSchema>))

export const syntheticSchemas = new Map(Object.entries(JSON.parse(readFileSync(
  new URL('../../core/test/fixtures/synthetic-schemas.json', import.meta.url), 'utf8',
)) as Record<string, NodeSchema>))

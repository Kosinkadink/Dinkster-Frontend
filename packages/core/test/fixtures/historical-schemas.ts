import { readFileSync } from 'node:fs'
import type { NodeSchema } from '../../src/schema/model.js'

/** Historical schema records for graph/compiler regressions, not registry discovery. */
export const historicalSchemas = new Map(Object.entries(JSON.parse(readFileSync(
  new URL('./historical-schemas.json', import.meta.url), 'utf8',
)) as Record<string, NodeSchema>))

import { readFileSync } from 'node:fs'
import type { ConnectionId, NodeSchema } from '@dinkster/core'
import type { SchemaRegistry } from '@dinkster/client'

export const historicalSchemas = new Map(Object.entries(JSON.parse(readFileSync(
  new URL('../../core/test/fixtures/historical-schemas.json', import.meta.url), 'utf8',
)) as Record<string, NodeSchema>))

export const historicalRegistry = (connection: ConnectionId, hash = 'historical-schemas'): SchemaRegistry => ({
  connection,
  hash,
  schemas: historicalSchemas,
  diagnostics: [],
  resolve: (type) => historicalSchemas.get(type),
})

import { vi } from 'vitest'
import type { NodeSchema } from '@dinkster/core'
import { AppState } from '../../src/app-state.js'

export function createWorkflowApp(schemas: readonly NodeSchema[] = []): AppState {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, value) },
  } satisfies Storage)
  const app = new AppState()
  const byType = new Map(schemas.map((schema) => [schema.type, schema]))
  app.registry.set({ connection: app.connection.id, schemas: byType, diagnostics: [],
    hash: 'workflow-test', resolve: (type) => byType.get(type) })
  vi.spyOn(app.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
    ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
  return app
}

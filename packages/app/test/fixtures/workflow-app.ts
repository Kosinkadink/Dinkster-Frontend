import { vi } from 'vitest'
import type { NodeSchema, WorkflowDocument } from '@dinkster/core'
import { AppState } from '../../src/app-state.js'
import { scopedStorageKey } from '../../src/projects.js'

function workflowStorage(restored?: WorkflowDocument): Storage {
  const values = new Map<string, string>()
  if (restored !== undefined) values.set(scopedStorageKey('dinkster.openTabs'), JSON.stringify({
    v: 1, active: restored.lineage, tabs: [{ title: 'Restored workflow', doc: restored }],
  }))
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

export function createWorkflowApp(schemas: readonly NodeSchema[] | null = [], restored?: WorkflowDocument): AppState {
  vi.stubGlobal('localStorage', workflowStorage(restored))
  const app = new AppState()
  // Null preserves catalog absence for tests of schema-arrival ordering.
  if (schemas !== null) {
    const byType = new Map(schemas.map((schema) => [schema.type, schema]))
    app.registry.set({ connection: app.connection.id, schemas: byType, diagnostics: [],
      hash: 'workflow-test', resolve: (type) => byType.get(type) })
  }
  vi.spyOn(app.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
    ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
  return app
}

export function prepareWorkflowApp(app: AppState): AppState {
  if (globalThis.localStorage === undefined) vi.stubGlobal('localStorage', workflowStorage())
  for (const backend of app.backends.get()) {
    if (backend.registry.get() === undefined) {
      backend.registry.set({ connection: backend.id, schemas: new Map(), diagnostics: [],
        hash: 'workflow-test', resolve: () => undefined })
    }
    vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
      ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
  }
  return app
}

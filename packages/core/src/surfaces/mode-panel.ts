/** Decode saved mode-panel bindings for document lifecycle and id allocation. */
import { diag, type Diagnostic } from '../diagnostics.js'
import type { JsonObject } from '../format/document.js'

export const MODE_PANEL_TYPE = 'core.modePanel'

export type ModePanelBinding =
  | { readonly kind: 'node'; readonly graphId: string; readonly nodeId: string }
  | { readonly kind: 'group'; readonly graphId: string; readonly groupId: string }
  | { readonly kind: 'unknown'; readonly raw: JsonObject }

export interface ModePanelConfig {
  readonly title?: string
  readonly bindings: readonly ModePanelBinding[]
}

const isObj = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function decodeModePanelConfig(config: JsonObject):
  | { readonly ok: true; readonly config: ModePanelConfig; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] } {
  const bad = (msg: string): { readonly ok: false; readonly diagnostics: readonly Diagnostic[] } => ({
    ok: false,
    diagnostics: [diag('error', 'schema', 'surface.config.invalid', `${MODE_PANEL_TYPE}: ${msg}`)],
  })
  if (config.title !== undefined && typeof config.title !== 'string')
    return bad('title must be a string')
  if (!Array.isArray(config.bindings)) return bad('bindings must be an array')
  const bindings: ModePanelBinding[] = []
  for (const [i, b] of config.bindings.entries()) {
    if (!isObj(b) || typeof b.kind !== 'string') return bad(`bindings[${i}] must be {kind, ...}`)
    if (b.kind === 'node') {
      if (typeof b.graphId !== 'string' || typeof b.nodeId !== 'string')
        return bad(`bindings[${i}] (node) must be {kind:'node', graphId, nodeId}`)
      bindings.push({ kind: 'node', graphId: b.graphId, nodeId: b.nodeId })
    } else if (b.kind === 'group') {
      if (typeof b.graphId !== 'string' || typeof b.groupId !== 'string')
        return bad(`bindings[${i}] (group) must be {kind:'group', graphId, groupId}`)
      bindings.push({ kind: 'group', graphId: b.graphId, groupId: b.groupId })
    } else {
      bindings.push({ kind: 'unknown', raw: b })
    }
  }
  return {
    ok: true,
    config: {
      ...(typeof config.title === 'string' ? { title: config.title } : {}),
      bindings,
    },
    diagnostics: [],
  }
}

import {
  asNodeId,
  defaultValuesOf,
  type Json,
  type NodeData,
  type NodeSchema,
} from '@dinkster/core'
import {
  layoutNode,
  type DesignTokens,
  type NodeLayout,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'

/** Build the display-only node used by the palette preview. */
export function transientPreviewNode(schema: NodeSchema): NodeData {
  const values = defaultValuesOf(schema) as Record<string, Json>
  for (const item of schema.items) {
    if (item.kind !== 'input' || item.widget?.widgetType !== 'COMBO' || values[item.id] !== undefined) continue
    const options = item.widget.options.options
    if (!Array.isArray(options) || options.length === 0) continue
    const first = options[0]
    values[item.id] = (Array.isArray(first) ? first[0] : first) as Json
  }
  return {
    id: asNodeId('__palette_preview__'),
    type: schema.type,
    values,
    title: schema.displayName,
  }
}

/** One schema-backed layout path shared by palette previews and placement. */
export function palettePreviewLayout(
  schema: NodeSchema,
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): { readonly node: NodeData; readonly layout: NodeLayout } {
  const node = transientPreviewNode(schema)
  return { node, layout: layoutNode(schema, node, tokens, measure, widgetMeasure) }
}

/**
 * Stable activation/arming fingerprint for one catalog schema snapshot.
 * A short digest, not the serialized schema: the key travels inside search
 * actions whose string params are capped, and real catalog schemas
 * serialize far past that cap.
 */
export function placementSchemaKey(schema: NodeSchema): string {
  const identity = JSON.stringify(placementIdentityWithoutRemotePolicy(schema))
  return fingerprint(identity, 0x811c9dc5) + fingerprint(identity, 0x01234567)
}

/** FNV-1a 32-bit over UTF-16 code units, hex-encoded; two seeds give 64 bits. */
function fingerprint(text: string, seed: number): string {
  let hash = seed
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const REMOTE_POLICY_FIELDS = new Set(['controlAfterRefresh', 'timeoutMs', 'maxRetries', 'refreshMs'])

function placementIdentityWithoutRemotePolicy(value: unknown, remote = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => placementIdentityWithoutRemotePolicy(entry, false))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
    remote && REMOTE_POLICY_FIELDS.has(key)
      ? []
      : [[key, placementIdentityWithoutRemotePolicy(entry, key === 'remote')]],
  ))
}

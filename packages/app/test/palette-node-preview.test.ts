import { describe, expect, it } from 'vitest'
import type { NodeSchema } from '@dinkster/core'
import { defaultTokens } from '@dinkster/canvas'
import { duplicatePaletteNames, paletteEntryIdentity, type PaletteEntry } from '../src/NodePalette.js'
import { palettePreviewLayout, placementSchemaKey, transientPreviewNode } from '../src/palette-node-preview.js'

const paletteEntry = (type: string, name: string, category: string, pack: string): PaletteEntry => ({
  type, name, category, pack, kind: 'node', fields: [],
})

describe('transient palette preview node', () => {
  it('uses schema defaults and the first combo option without touching external state', () => {
    const schema: NodeSchema = {
      type: 'PreviewNode', displayName: 'Preview Node', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { kind: 'input', id: 'count', optional: false, type: { kind: 'concrete', name: 'INT' }, widget: { widgetType: 'INT', options: {}, default: 3 } },
        { kind: 'input', id: 'mode', optional: false, type: { kind: 'concrete', name: 'STRING' }, widget: { widgetType: 'COMBO', options: { options: ['fast', 'slow'] } } },
      ],
    }
    const store = { nodes: [] as unknown[] }
    const node = transientPreviewNode(schema)

    expect(node).toMatchObject({ type: 'PreviewNode', title: 'Preview Node', values: { count: 3, mode: 'fast' } })
    expect(node.id).toBe('__palette_preview__')
    expect(store.nodes).toEqual([])
    expect(schema.items[1]).not.toHaveProperty('value')

    const preview = palettePreviewLayout(schema, defaultTokens, (text) => text.length * 8, () => undefined)
    expect(preview.node).toEqual(node)
    expect(preview.layout).toMatchObject({
      title: 'Preview Node',
      headerHeight: defaultTokens.headerHeight,
    })
    expect(preview.layout.width).toBeGreaterThan(0)
    expect(preview.layout.height).toBeGreaterThan(defaultTokens.headerHeight)
  })

  it('excludes remote COMBO policy from placement identity', () => {
    const schema: NodeSchema = {
      type: 'PolicyNode', displayName: 'Policy Node', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'choice', optional: false,
        type: { kind: 'concrete', name: 'core.combo' },
        widget: { widgetType: 'COMBO', options: {}, remote: { route: '/api/choices/models', refreshButton: true } },
      }],
    }
    const withPolicy = structuredClone(schema)
    Object.assign((withPolicy.items[0] as any).widget.remote, {
      controlAfterRefresh: 'last', timeoutMs: 2000, maxRetries: 1, refreshMs: 5000,
    })
    expect(placementSchemaKey(withPolicy)).toBe(placementSchemaKey(schema))
  })

  it('emits a short digest that distinguishes materially different schemas', () => {
    const schema: NodeSchema = {
      type: 'DigestNode', displayName: 'Digest Node', category: 'test', source: 'v3', isOutputNode: false,
      items: Array.from({ length: 24 }, (_, i) => ({
        kind: 'input' as const, id: `input_${i}`, optional: false,
        type: { kind: 'concrete' as const, name: 'STRING' },
        widget: { widgetType: 'STRING' as const, options: {}, default: `value ${i}` },
      })),
    }
    const changed = structuredClone(schema)
    ;(changed.items[0] as { widget: { default: string } }).widget.default = 'other'
    // Keys ride inside search-action string params (200-char cap); the digest
    // must stay short no matter how large the schema serializes.
    expect(JSON.stringify(schema).length).toBeGreaterThan(200)
    expect(placementSchemaKey(schema)).toMatch(/^[0-9a-f]{16}$/)
    expect(placementSchemaKey(changed)).toMatch(/^[0-9a-f]{16}$/)
    expect(placementSchemaKey(changed)).not.toBe(placementSchemaKey(schema))
  })
})

describe('palette row identity', () => {
  it('shows pack display name, category, and canonical id only for duplicate display names', () => {
    const native = paletteEntry('dinkster.preview_any', 'Preview as Text', 'utilities', 'Dinkster Core')
    const comfy = paletteEntry('comfy.PreviewAny', 'Preview as Text', 'comfy/utilities', 'ComfyUI')
    const unique = paletteEntry('dinkster.save_target', 'Save Target', 'utilities', 'Dinkster Core')
    const entries = [native, comfy, unique]
    const duplicates = duplicatePaletteNames(entries)

    expect(paletteEntryIdentity(native, duplicates)).toEqual({
      visible: 'Dinkster Core - utilities - dinkster.preview_any',
      accessible: 'Preview as Text, Dinkster Core, utilities, dinkster.preview_any',
    })
    expect(paletteEntryIdentity(comfy, duplicates)).toEqual({
      visible: 'ComfyUI - comfy/utilities - comfy.PreviewAny',
      accessible: 'Preview as Text, ComfyUI, comfy/utilities, comfy.PreviewAny',
    })
    expect(paletteEntryIdentity(unique, duplicates)).toEqual({ accessible: 'Save Target' })
  })

  it('omits fabricated pack context when a duplicate schema has no pack metadata', () => {
    const first = paletteEntry('local.first', 'Local', 'testing', '')
    const second: PaletteEntry = { type: 'local.second', name: 'Local', category: 'other', kind: 'node', fields: [] }
    const duplicates = duplicatePaletteNames([first, second])
    expect(paletteEntryIdentity(second, duplicates)).toEqual({
      visible: 'other - local.second',
      accessible: 'Local, other, local.second',
    })
  })
})

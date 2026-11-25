import { describe, expect, it } from 'vitest'
import type { NodeSchema } from '@dinkster/core'
import { defaultTokens } from '@dinkster/canvas'
import { duplicatePaletteNames, paletteEntryIdentity, type PaletteEntry } from '../src/NodePalette.js'
import { palettePreviewLayout, transientPreviewNode } from '../src/palette-node-preview.js'

const paletteEntry = (type: string, name: string, category: string, pack: string): PaletteEntry => ({
  type, name, category, pack, kind: 'node', fields: [],
})

describe('transient palette preview node', () => {
  it('uses schema defaults and the first combo option without touching external state', () => {
    const schema: NodeSchema = {
      type: 'PreviewNode', displayName: 'Preview Node', category: 'test', source: 'v3', isOutputNode: false,
      body: [
        { kind: 'input', id: 'count', optional: false, type: { kind: 'concrete', name: 'INT' }, widget: { widgetType: 'INT', options: {}, default: 3 } },
        { kind: 'input', id: 'mode', optional: false, type: { kind: 'concrete', name: 'STRING' }, widget: { widgetType: 'COMBO', options: { options: ['fast', 'slow'] } } },
      ],
    }
    const node = transientPreviewNode(schema)

    expect(node).toMatchObject({ type: 'PreviewNode', title: 'Preview Node', values: { count: 3, mode: 'fast' } })
    expect(schema.body[1]).not.toHaveProperty('value')

    const preview = palettePreviewLayout(schema, defaultTokens, (text) => text.length * 8, () => undefined)
    expect(preview.node).toEqual(node)
    expect(preview.layout).toMatchObject({
      title: 'Preview Node',
      headerHeight: defaultTokens.headerHeight,
    })
    expect(preview.layout.width).toBeGreaterThan(0)
    expect(preview.layout.height).toBeGreaterThan(defaultTokens.headerHeight)
  })

})

describe('palette row identity', () => {
  it('shows pack display name, category, and canonical id only for duplicate display names', () => {
    const native = paletteEntry('dinkster.preview_any', 'Preview as Text', 'utilities', 'Dinkster Core')
    const comfy = paletteEntry('comfy.PreviewAny', 'Preview as Text', 'comfy/utilities', 'ComfyUI')
    const unique = paletteEntry('SAVE_TARGET', 'Save Target', 'utilities', 'Dinkster Core')
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

  it('labels duplicate saved blueprints without exposing their record ids', () => {
    const saved: PaletteEntry = {
      type: 'blueprint:saved/record-one', name: 'Image helpers', category: 'This project',
      kind: 'blueprint', fields: [],
      blueprint: { recordId: 'record-one', descriptor: { id: 'record-one', name: 'Image helpers', digest: 'blake3:one' } },
    }
    const other: PaletteEntry = {
      ...saved, type: 'blueprint:saved/record-two',
      blueprint: { recordId: 'record-two', descriptor: { id: 'record-two', name: 'Image helpers', digest: 'blake3:two' } },
    }
    const pack: PaletteEntry = {
      ...saved, type: 'blueprint:helpers/image', pack: 'Image pack', category: 'Images',
      blueprint: { packId: 'helpers', descriptor: { id: 'image', name: 'Image helpers', digest: 'sha256:pack' } },
    }
    const duplicates = duplicatePaletteNames([saved, other, pack])
    for (const entry of [saved, other]) {
      expect(paletteEntryIdentity(entry, duplicates)).toEqual({
        visible: 'This project - Blueprint', accessible: 'Image helpers, This project, Blueprint',
      })
    }
    expect(paletteEntryIdentity(pack, duplicates)).toEqual({
      visible: 'Image pack - Images - blueprint:helpers/image',
      accessible: 'Image helpers, Image pack, Images, blueprint:helpers/image',
    })
    expect(paletteEntryIdentity(saved, new Set())).toEqual({ accessible: 'Image helpers' })
    expect([saved.type, other.type]).toEqual(['blueprint:saved/record-one', 'blueprint:saved/record-two'])
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

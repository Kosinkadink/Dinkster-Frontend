import { asConnectionId, type NodeSchema } from '@dinkster/core'
import { describe, expect, it } from 'vitest'
import {
  decodePackLocaleCatalog,
  overlayPackLocales,
  preferredPackLocaleKeys,
} from '../src/pack-locales.js'

const schema: NodeSchema = {
  type: 'demo.paint',
  displayName: 'Paint',
  description: 'Base description',
  category: 'demo',
  source: 'v3',
  pack: 'demo-pack',
  isOutputNode: false,
  searchTerms: ['base-term'],
  items: [
    {
      kind: 'input',
      id: 'color',
      displayName: 'Color',
      tooltip: 'Base color help',
      type: { kind: 'concrete', name: 'core.string' },
      optional: false,
      widget: {
        widgetType: 'COMBO',
        options: { options: ['red', { value: 'blue', label: 'Base blue' }] },
        default: 'red',
      },
    },
    {
      kind: 'input',
      id: 'group',
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: {
        kind: 'autogrow',
        naming: { kind: 'prefix', prefix: 'item', max: 3 },
        template: [{
          kind: 'input',
          id: 'caption',
          displayName: 'Caption',
          type: { kind: 'concrete', name: 'core.string' },
          optional: true,
        }],
      },
    },
    {
      kind: 'output',
      id: 'image',
      displayName: 'Image',
      type: { kind: 'concrete', name: 'dinkster.image' },
    },
  ],
}

const registry = {
  connection: asConnectionId('native'),
  hash: 'RAW-schema-hash',
  schemas: new Map([[schema.type, schema]]),
  diagnostics: [],
  resolve: (type: string) => type === schema.type || type === 'legacy.paint' ? schema : undefined,
  packs: new Map([['demo-pack', {
    displayName: 'Demo Pack',
    blueprints: [{ id: 'starter', name: 'Starter', description: 'Base blueprint', digest: 'sha256:raw' }],
  }]]),
}

describe('pack locale catalogs', () => {
  it('strictly decodes the closed catalog vocabulary', () => {
    const catalog = decodePackLocaleCatalog({
      nodes: { 'demo.paint': {
        displayName: 'Malen',
        inputs: { color: { displayName: 'Farbe', doc: 'RAW port help' } },
        combos: { color: { red: 'Rot' } },
      } },
      blueprints: { starter: { name: 'Start' } },
      guides: { basics: { title: 'Grundlagen' } },
      searchTerms: { 'demo.paint': ['malen', 'farbe'] },
    })
    expect(catalog.nodes?.['demo.paint']?.inputs?.['color']?.doc).toBe('RAW port help')
    expect(catalog.searchTerms?.['demo.paint']).toEqual(['malen', 'farbe'])

    expect(() => decodePackLocaleCatalog({ unknown: {} })).toThrow('unknown fields')
    expect(() => decodePackLocaleCatalog({ nodes: { node: {} } })).toThrow('must be non-empty')
    expect(() => decodePackLocaleCatalog({ guides: { guide: { title: 'Title', extra: true } } }))
      .toThrow('must contain only title')
    expect(() => decodePackLocaleCatalog({ searchTerms: { node: [] } })).toThrow('non-empty array')
  })

  it('orders exact, base, related, and English catalogs without duplicate fetches', () => {
    expect(preferredPackLocaleKeys('pt_BR', ['en', 'pt-pt', 'pt', 'pt-br', 'DE', 'pt-br']))
      .toEqual(['pt-br', 'pt', 'pt-pt', 'en'])
    expect(preferredPackLocaleKeys('de-DE', ['en', 'fr'])).toEqual(['en'])
  })

  it('overlays presentation per field while preserving raw schema identity', () => {
    const preferred = decodePackLocaleCatalog({
      nodes: { 'demo.paint': {
        displayName: 'Malen',
        inputs: {
          color: { displayName: 'Farbe' },
          caption: { displayName: 'Bildtext', doc: 'Beschriftung' },
        },
        outputs: { image: { displayName: 'Bild' } },
        combos: { color: { red: 'Rot' } },
      } },
      blueprints: { starter: { name: 'Start' } },
      searchTerms: { 'demo.paint': ['malen'] },
    })
    const fallback = decodePackLocaleCatalog({
      nodes: { 'demo.paint': {
        description: 'Fallback description',
        inputs: { color: { doc: 'Fallback color help' } },
        outputs: { image: { doc: 'Fallback image help' } },
        combos: { color: { blue: 'Blau' } },
      } },
      blueprints: { starter: { description: 'Fallback blueprint' } },
      searchTerms: { 'demo.paint': ['fallback-term'] },
    })
    const localized = overlayPackLocales(registry, new Map([['demo-pack', [preferred, fallback]]]))
    const translated = localized.resolve('legacy.paint')!
    const color = translated.items[0]!
    const group = translated.items[1]!
    const image = translated.items[2]!

    expect(localized.hash).toBe(registry.hash)
    expect(translated.displayName).toBe('Malen')
    expect(translated.description).toBe('Fallback description')
    expect(color).toMatchObject({ displayName: 'Farbe', tooltip: 'Fallback color help' })
    expect(color.kind === 'input' ? color.widget?.options['options'] : undefined).toEqual([
      { value: 'red', label: 'Rot' },
      { value: 'blue', label: 'Blau' },
    ])
    expect(group.kind === 'input' && group.dynamic?.kind === 'autogrow'
      ? group.dynamic.template[0]
      : undefined).toMatchObject({ displayName: 'Bildtext', tooltip: 'Beschriftung' })
    expect(image).toMatchObject({ displayName: 'Bild', tooltip: 'Fallback image help' })
    expect(translated.searchTerms).toEqual(['malen', 'base-term'])
    expect(localized.packs?.get('demo-pack')?.blueprints?.[0]).toMatchObject({
      id: 'starter', name: 'Start', description: 'Fallback blueprint', digest: 'sha256:raw',
    })
    expect(schema.displayName).toBe('Paint')
    expect(registry.packs.get('demo-pack')?.blueprints?.[0]?.name).toBe('Starter')
  })

  it('does not apply one pack catalog to another pack or unowned entries', () => {
    const foreign: NodeSchema = { ...schema, type: 'other.paint', pack: 'other-pack' }
    const twoPacks = {
      ...registry,
      schemas: new Map([[schema.type, schema], [foreign.type, foreign]]),
      resolve: (type: string) => type === schema.type ? schema : type === foreign.type ? foreign : undefined,
    }
    const catalog = decodePackLocaleCatalog({
      nodes: { 'demo.paint': { displayName: 'Localized' }, 'other.paint': { displayName: 'Wrong pack' } },
    })
    const localized = overlayPackLocales(twoPacks, new Map([['demo-pack', [catalog]]]))
    expect(localized.resolve('demo.paint')?.displayName).toBe('Localized')
    expect(localized.resolve('other.paint')).toBe(foreign)
  })
})

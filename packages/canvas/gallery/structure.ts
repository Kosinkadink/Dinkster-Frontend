import {
  CORE_VIRTUAL_NODE_KINDS,
  coreVirtualNodeKind,
  loadDocument,
  type NodeSchema,
} from '@dinkster/core'
import {
  buildScene,
  type DesignTokens,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'

const image = { kind: 'concrete', name: 'IMAGE' } as const
const blur: NodeSchema = {
  type: 'Blur',
  displayName: 'Blur',
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  items: [
    { kind: 'input', id: 'image', type: image, optional: false },
    {
      kind: 'input',
      id: 'radius',
      type: { kind: 'concrete', name: 'INT' },
      optional: false,
      widget: { widgetType: 'INT', options: { min: 0, max: 64 }, default: 4 },
    },
    { kind: 'output', id: 'IMAGE', type: image },
  ],
}

/** Document-backed structural examples use the same scene builder as the app. */
export function structuralGalleryScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  inside = false,
) {
  const document = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery-structure',
    ext: {
      'dinkster.netViews': [
        {
          graphId: 'g0',
          netId: 'net',
          role: 'source',
          offset: { x: 230, y: -30 },
        },
        {
          graphId: 'g0',
          netId: 'net',
          role: 'sink',
          to: { node: 'b', port: 'image' },
          offset: { x: 0, y: 140 },
        },
      ],
    },
    root: 'g0',
    graphs: {
      g0: {
        id: 'g0',
        name: 'Root',
        nextOrdinal: 20,
        nodes: {
          a: { id: 'a', type: 'Blur', values: {} },
          b: {
            id: 'b',
            type: 'Blur',
            values: { radius: 8 },
            title: 'Alternative',
          },
          sub: { id: 'sub', type: '#g1', values: { radius: 6 } },
          note: {
            id: 'note',
            type: 'dinkster.note',
            virtual: true,
            values: { text: 'Plain note\nSecond line' },
          },
          markdown: {
            id: 'markdown',
            type: 'dinkster.markdown_note',
            virtual: true,
            values: { text: '# Heading\nBody with **bold** text\n- List item' },
          },
          minimized: { id: 'minimized', type: 'Blur', values: {} },
        },
        links: {
          l1: {
            id: 'l1',
            from: { node: 'a', port: 'IMAGE' },
            to: { selector: 's', candidate: 'full' },
          },
          l2: {
            id: 'l2',
            from: { node: 'b', port: 'IMAGE' },
            to: { selector: 's', candidate: 'draft' },
          },
          l3: {
            id: 'l3',
            from: { selector: 's' },
            to: { node: 'sub', port: 'image' },
          },
          l4: {
            id: 'l4',
            from: { valueSource: 'size' },
            to: { node: 'a', port: 'radius' },
          },
          l5: {
            id: 'l5',
            from: { node: 'sub', port: 'image_out' },
            to: { reroute: 'r' },
          },
          l6: {
            id: 'l6',
            from: { reroute: 'r' },
            to: { node: 'minimized', port: 'image' },
          },
        },
        nets: {
          net: {
            id: 'net',
            name: 'Reference image',
            source: { node: 'a', port: 'IMAGE' },
            sinks: [{ node: 'b', port: 'image' }],
          },
        },
        reroutes: { r: { id: 'r' } },
        valueSources: { size: { id: 'size', value: 12, title: 'Radius' } },
        selectors: {
          s: {
            id: 's',
            title: 'Quality',
            candidates: [
              { id: 'full', title: 'Full' },
              { id: 'draft', title: 'Draft' },
            ],
            policy: { kind: 'fixed', candidate: 'full' },
          },
        },
      },
      g1: {
        id: 'g1',
        name: 'Soften',
        nextOrdinal: 2,
        nodes: { inner: { id: 'inner', type: 'Blur', values: {} } },
        links: {},
        nets: {},
        reroutes: {},
        boundary: {
          inputs: [
            {
              id: 'image',
              binds: { kind: 'port', node: 'inner', port: 'image' },
            },
            {
              id: 'radius',
              binds: { kind: 'port', node: 'inner', port: 'radius' },
              promoted: true,
            },
          ],
          outputs: [
            {
              id: 'image_out',
              binds: { kind: 'port', node: 'inner', port: 'IMAGE' },
            },
          ],
        },
      },
    },
    view: {
      graphs: {
        g0: {
          nodes: {
            a: { position: { x: 30, y: 80 } },
            b: { position: { x: 30, y: 240 } },
            sub: { position: { x: 650, y: 80 } },
            minimized: { position: { x: 650, y: 300 }, collapsed: true },
            note: {
              position: { x: 30, y: 450 },
              size: { width: 260, height: 120 },
            },
            markdown: {
              position: { x: 360, y: 450 },
              size: { width: 300, height: 140 },
            },
          },
          selectors: { s: { position: { x: 360, y: 100 } } },
          valueSources: { size: { position: { x: 360, y: 300 } } },
          reroutes: { r: { position: { x: 900, y: 240 } } },
          groups: {
            group: {
              id: 'group',
              title: 'Sources',
              bounds: { x: 10, y: 25, width: 270, height: 370 },
            },
          },
          groupSeq: 2,
          collapsedNets: ['net'],
          guideNets: ['net'],
        },
        g1: { nodes: { inner: { position: { x: 350, y: 120 } } } },
      },
    },
  }).document
  if (!document) throw new Error('Invalid structural gallery document')
  const schemas = new Map(
    [blur, ...CORE_VIRTUAL_NODE_KINDS.map((kind) => kind.schema)].map(
      (schema) => [schema.type, schema],
    ),
  )
  return buildScene({
    document,
    graphId: inside ? 'g1' : 'g0',
    resolve: (type) => schemas.get(type),
    tokens,
    measure,
    widgetMeasure,
    renderVirtualNode: (node) => coreVirtualNodeKind(node.type)?.render(node),
  })
}

/**
 * Pack provenance + explicit outputNode hint (backend commit 1aa3231,
 * additive to schema wire v3): the /api/nodes payload carries a top-level
 * "packs" presentation table and host-attached per-node "pack" attribution.
 * Both are presentation/attribution only - tolerant decode, never identity,
 * and a malformed declaration never fails schema fetch.
 */
import { describe, expect, it } from 'vitest'
import { DINKSTER_SCHEMA_WIRE_VERSION, parseDinksterNodes } from '../src/index.js'

const payload = {
  schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
  dinkster: { version: '0.9.0', schemaWire: 1 },
  packs: {
    core: { displayName: 'Dinkster Core' },
    'vhs.video': { displayName: 'Video Helper Suite', abbr: 'VHS', mark: '\u{1F3A5}', color: '#64b5f6' },
    pinned: {
      displayName: 'Pinned Pack',
      version: '3.1.4',
      artifactDigest: 'sha256:' + 'a'.repeat(64),
      source: 'registry',
      publisher: 'kosinkadink',
    },
    'dev.pack': { displayName: 'Dev Pack', source: 'local:/home/dev/pack' },
    'junk.prov': { displayName: 'Junk Prov', version: '', artifactDigest: 42, source: null },
    'with.settings': { displayName: 'Configurable Pack', settings: true },
    'junk.settings': { displayName: 'Not Configurable', settings: 'true' },
    bare: {},
    dropped: { displayName: 'Bad Fields', abbr: '', mark: 42, color: 'not-a-color' },
    'with.icon': {
      displayName: 'Iconed',
      icon: { digest: 'sha256:abc123', mediaType: 'image/png' },
    },
    'with.assets': {
      displayName: 'Asset Pack',
      assets: [{
        id: 'depth-anything',
        name: 'Depth Anything',
        digest: 'future-digest:abc123',
        kind: 'model/auxiliary',
        size: 1572864,
        mediaType: 'application/octet-stream',
        metadata: { family: 'depth' },
        sources: [
          { type: 'packaged', pack: 'with.assets', path: 'models/depth.bin', extra: true },
          { type: 'remote', url: 'https://example.test/depth.bin' },
        ],
        nodes: ['depth.load'],
        unknownFutureField: true,
      }],
      unknownPackField: true,
    },
    'half.icon': { displayName: 'Half', icon: { digest: 'sha256:def' } },
    'junk.icon': { displayName: 'Junk', icon: 'badge.png' },
    'with.blueprints': {
      displayName: 'Blueprinted',
      blueprints: [
        {
          id: 'txt2img',
          name: 'Text to Image',
          description: 'Prompt in, image out',
          tags: ['starter', 'image'],
          digest: 'sha256:' + 'b'.repeat(64),
          boundaryInputs: ['core.text'],
          boundaryOutputs: ['IMAGE'],
        },
        { id: 'bare', name: 'Bare Minimum', digest: 'sha256:' + 'c'.repeat(64) },
      ],
    },
    'junk.blueprints': {
      displayName: 'Junk Blueprints',
      blueprints: [
        { id: 'no-digest', name: 'No Digest' },
        'not-an-object',
        {
          id: 'messy',
          name: 'Messy',
          digest: 'sha256:' + 'd'.repeat(64),
          tags: [42, '', 'kept'],
          boundaryInputs: 'IMAGE',
          boundaryOutputs: [null, ''],
        },
      ],
    },
    'empty.blueprints': { displayName: 'Empty', blueprints: [] },
  },
  nodes: {
    'core.add': { displayName: 'Add', pack: 'core', signature: 'sig-add-1', interface: [] },
    'vhs.load': { displayName: 'Load Video', pack: 'vhs.video', interface: [] },
    orphan: { displayName: 'Orphan', interface: [] },
    'bad.sig': { displayName: 'Bad Sig', signature: 42, interface: [] },
    sink: { displayName: 'Sink', idempotent: true, outputNode: true, interface: [] },
    effectful: { displayName: 'Effectful', idempotent: false, interface: [] },
    aliased: { displayName: 'Aliased', aliases: ['LegacyName'], interface: [] },
  },
}

const { schemas, diagnostics } = parseDinksterNodes(payload)

describe('explicit outputNode hint', () => {
  it('outputNode: true wins over the !idempotent heuristic', () => {
    expect(schemas.get('sink')?.isOutputNode).toBe(true)
  })

  it('without the hint, !idempotent stays the fallback', () => {
    expect(schemas.get('effectful')?.isOutputNode).toBe(true)
    expect(schemas.get('aliased')?.isOutputNode).toBe(false) // idempotent defaults true
  })
})

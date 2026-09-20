/**
 * Deprecation/replacement orchestration: the once-per-tab upgrade pass.
 * Safe (lossless, warning-free) plans auto-apply on document open; lossy
 * plans land in Problems for badge review. Review mode holds ordinary safe
 * plans, while best-effort migration fallbacks remain automatic.
 * The pass is DEFERRED when a document opens before its backend's schemas
 * arrive - the backendsTick subscription picks the tab up later instead of
 * missing it forever (the seed tabs always take this path).
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { DINKSTER_SCHEMA_WIRE_VERSION, type DinksterNodesPayload, type ObjectInfoEntry, type ReplacementRule } from '@dinkster/core'
import { buildDinksterRegistry, buildSchemaRegistry } from '@dinkster/client'
import { AppState, type Tab } from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const root = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const objectInfo = JSON.parse(readFileSync(join(root, 'fixtures/object_info.json'), 'utf8')) as Record<
  string,
  ObjectInfoEntry
>

let app: AppState

beforeEach(() => {
  app = new AppState()
})

/** Put the fixture schemas on the default backend (fires backendsTick). */
const loadSchemas = (): void => {
  const backend = app.backends.get()[0]!
  backend.registry.set(buildSchemaRegistry(backend.id, objectInfo))
}

/** Minimal native document: one root graph with the given nodes and topology. */
const docJson = (
  lineage: string,
  nodes: Record<string, { type: string; values?: Record<string, unknown> }>,
  links: Record<string, unknown> = {},
  nets: Record<string, unknown> = {},
): unknown => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage,
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'root',
      nodes: Object.fromEntries(
        Object.entries(nodes).map(([id, n]) => [id, { id, type: n.type, values: n.values ?? {} }]),
      ),
      links,
      nets,
      reroutes: {},
      nextOrdinal: 99,
    },
  },
  view: { graphs: { g0: { nodes: {} } } },
  meta: { title: lineage },
})

/** 'OldEmpty' is deprecated/uninstalled; the rule migrates it wholesale. */
const renameRule: ReplacementRule = {
  from: 'OldEmpty',
  note: 'renamed',
  cases: [
    {
      to: 'EmptyLatentImage',
      inputs: {
        width: { kind: 'copy', input: 'width' },
        height: { kind: 'copy', input: 'height' },
        batch_size: { kind: 'copy', input: 'batch_size' },
      },
      outputs: { out0: 'out0' },
    },
  ],
}

const openWithRule = (json: unknown): Tab => {
  expect(app.registerReplacementRule('pack', renameRule)).toEqual([])
  expect(app.openDocument(json, 'T')).toEqual([])
  return app.activeTab()!
}

const nodeType = (tab: Tab, id: string): string | undefined =>
  tab.store.doc.graphs[tab.store.doc.root]!.nodes[id]?.type

describe('auto-upgrade on open', () => {
  it('applies a safe plan when the document opens after schemas arrived', () => {
    loadSchemas()
    const tab = openWithRule(docJson('lin-a', { old: { type: 'OldEmpty', values: { width: 512 } } }))
    expect(nodeType(tab, 'old')).toBe('EmptyLatentImage')
    // Copied value preserved; unmapped inputs get explicit declared defaults.
    expect(tab.store.doc.graphs.g0!.nodes.old!.values.width).toBe(512)
    expect(app.problems.get().some((d) => d.code === 'replace.applied')).toBe(true)
    // One undo step restores the pre-upgrade document exactly.
    expect(tab.store.undo()).toBe(true)
    expect(nodeType(tab, 'old')).toBe('OldEmpty')
  })

  it('defers the pass until schemas arrive when the document opens first', () => {
    const tab = openWithRule(docJson('lin-b', { old: { type: 'OldEmpty' } }))
    expect(nodeType(tab, 'old')).toBe('OldEmpty') // nothing to plan against yet
    loadSchemas()
    expect(nodeType(tab, 'old')).toBe('EmptyLatentImage')
  })

  it('runs exactly once per tab: a later tick does not rescan or re-apply', () => {
    loadSchemas()
    const tab = openWithRule(docJson('lin-c', { old: { type: 'OldEmpty' } }))
    expect(nodeType(tab, 'old')).toBe('EmptyLatentImage')
    tab.store.undo()
    app.backendsTick.update((v) => v + 1) // any backend churn
    expect(nodeType(tab, 'old')).toBe('OldEmpty') // stays for badge review
  })

  it('batches several safe replacements into ONE undo step', () => {
    loadSchemas()
    const tab = openWithRule(
      docJson('lin-d', { a: { type: 'OldEmpty' }, b: { type: 'OldEmpty' } }),
    )
    expect(nodeType(tab, 'a')).toBe('EmptyLatentImage')
    expect(nodeType(tab, 'b')).toBe('EmptyLatentImage')
    expect(tab.store.revision).toBe(1)
    expect(tab.store.undo()).toBe(true)
    expect(nodeType(tab, 'a')).toBe('OldEmpty')
    expect(nodeType(tab, 'b')).toBe('OldEmpty')
  })

  it('review mode holds even safe plans for badge review', () => {
    loadSchemas()
    app.reviewReplacements.set(true)
    const tab = openWithRule(docJson('lin-e', { old: { type: 'OldEmpty' } }))
    expect(nodeType(tab, 'old')).toBe('OldEmpty')
    expect(app.problems.get().some((d) => d.code === 'replace.review')).toBe(true)
    // The held item is still applicable manually (the badge's apply path).
    const items = app.scanTabReplacements(tab)
    expect(items).toHaveLength(1)
    expect(app.applyReplacements(tab, items)).toBe(true)
    expect(nodeType(tab, 'old')).toBe('EmptyLatentImage')
  })

  it('a lossy plan is never auto-applied and lands in Problems', () => {
    loadSchemas()
    // Downstream link on an output the rule does not map -> dropped-link
    // warning -> not safe.
    const lossy: ReplacementRule = { from: 'OldEmpty', cases: [{ to: 'EmptyLatentImage' }] }
    expect(app.registerReplacementRule('pack', lossy)).toEqual([])
    const json = docJson(
      'lin-f',
      { old: { type: 'OldEmpty' }, sink: { type: 'VAEDecode' } },
      { l0: { id: 'l0', from: { node: 'old', port: 'samples' }, to: { node: 'sink', port: 'samples' } } },
    )
    expect(app.openDocument(json, 'T')).toEqual([])
    const tab = app.activeTab()!
    expect(nodeType(tab, 'old')).toBe('OldEmpty')
    expect(app.problems.get().some((d) => d.code === 'replace.review')).toBe(true)
    const items = app.scanTabReplacements(tab)
    expect(items[0]!.safe).toBe(false)
    expect(items[0]!.plan).toBeDefined()
  })

  it('frozen tabs are never scanned or upgraded', () => {
    loadSchemas()
    app.reviewReplacements.set(true) // keep the node in place
    const tab = openWithRule(docJson('lin-g', { old: { type: 'OldEmpty' } }))
    const frozen: Tab = { ...tab, execution: { connection: app.backends.get()[0]!.id, prompt: 'p' as never } }
    expect(app.scanTabReplacements(frozen)).toEqual([])
  })

  it('rejects malformed pack rules with diagnostics, not exceptions', () => {
    const bad = { from: 'X', cases: [] } as unknown as ReplacementRule
    const diags = app.registerReplacementRule('pack', bad)
    expect(diags.length).toBeGreaterThan(0)
    expect(app.problems.get().length).toBeGreaterThan(0)
  })

  it('auto-applies a one-shot same-type migration and restores it atomically', () => {
    loadSchemas()
    const migration: ReplacementRule = {
      from: 'EmptyLatentImage',
      migration: { historicalInputs: ['legacy_width'] },
      cases: [{
        to: 'EmptyLatentImage',
        when: { kind: 'valuePresent', input: 'legacy_width' },
        inputs: { width: { kind: 'copy', input: 'legacy_width' } },
      }, { to: 'EmptyLatentImage' }],
    }
    expect(app.registerReplacementRule('pack', migration)).toEqual([])
    expect(app.openDocument(docJson('lin-migration', {
      image: { type: 'EmptyLatentImage', values: { legacy_width: 640 } },
    }), 'T')).toEqual([])
    const tab = app.activeTab()!
    expect(tab.store.doc.graphs.g0!.nodes.image!.values.width).toBe(640)
    expect(tab.store.doc.graphs.g0!.nodes.image!.values).not.toHaveProperty('legacy_width')
    expect(app.scanTabReplacements(tab)).toEqual([])

    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.image!.values).toEqual({ legacy_width: 640 })
    expect(tab.store.redo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.image!.values.width).toBe(640)
  })

  it('auto-applies the fallback while archiving unmatched state and dropped topology', () => {
    loadSchemas()
    const migration: ReplacementRule = {
      from: 'EmptyLatentImage',
      migration: { historicalInputs: ['legacy_selector'] },
      cases: [{
        to: 'EmptyLatentImage',
        when: { kind: 'valueEquals', input: 'legacy_selector', value: 'known' },
      }, { to: 'EmptyLatentImage' }],
    }
    expect(app.registerReplacementRule('pack', migration)).toEqual([])
    expect(app.openDocument(docJson(
      'lin-invalid-migration',
      {
        image: { type: 'EmptyLatentImage', values: { legacy_selector: 'invalid' } },
        linkSink: { type: 'VAEDecode' },
        netSink: { type: 'VAEDecode' },
      },
      {
        droppedLink: {
          id: 'droppedLink',
          from: { node: 'image', port: 'out0' },
          to: { node: 'linkSink', port: 'samples' },
        },
      },
      {
        droppedNet: {
          id: 'droppedNet',
          name: 'dropped',
          source: { node: 'image', port: 'out0' },
          sinks: [{ node: 'netSink', port: 'samples' }],
        },
      },
    ), 'T')).toEqual([])
    const tab = app.activeTab()!
    const image = tab.store.doc.graphs.g0!.nodes.image!
    expect(image.values).not.toHaveProperty('legacy_selector')
    expect(image.ext?.['dinkster.replacementMigration']).toMatchObject({
      version: 1,
      node: { values: { legacy_selector: 'invalid' } },
      links: {
        droppedLink: {
          from: { node: 'image', port: 'out0' },
          to: { node: 'linkSink', port: 'samples' },
        },
      },
      nets: {
        droppedNet: {
          source: { node: 'image', port: 'out0' },
          sinks: [{ node: 'netSink', port: 'samples' }],
        },
      },
    })
    expect(tab.store.doc.graphs.g0!.links.droppedLink).toBeUndefined()
    expect(tab.store.doc.graphs.g0!.nets.droppedNet).toBeUndefined()
    expect(app.problems.get()).toContainEqual(expect.objectContaining({ code: 'replace.migration.archived' }))
    expect(app.problems.get()).not.toContainEqual(expect.objectContaining({ code: 'replace.review' }))
    expect(app.scanTabReplacements(tab)).toEqual([])
  })

  it('auto-applies a fallback in review mode while holding ordinary safe replacements', () => {
    loadSchemas()
    app.reviewReplacements.set(true)
    const migration: ReplacementRule = {
      from: 'EmptyLatentImage',
      migration: { historicalInputs: ['legacy_selector'] },
      cases: [{
        to: 'EmptyLatentImage',
        when: { kind: 'valueEquals', input: 'legacy_selector', value: 'known' },
      }, { to: 'EmptyLatentImage' }],
    }
    expect(app.registerReplacementRule('pack', renameRule)).toEqual([])
    expect(app.registerReplacementRule('pack', migration)).toEqual([])
    expect(app.openDocument(docJson('lin-review-fallback', {
      old: { type: 'OldEmpty' },
      image: { type: 'EmptyLatentImage', values: { legacy_selector: 'invalid' } },
    }), 'T')).toEqual([])
    const tab = app.activeTab()!

    expect(nodeType(tab, 'old')).toBe('OldEmpty')
    expect(tab.store.doc.graphs.g0!.nodes.image!.values).not.toHaveProperty('legacy_selector')
    expect(tab.store.doc.graphs.g0!.nodes.image!.ext?.['dinkster.replacementMigration']).toMatchObject({
      node: { values: { legacy_selector: 'invalid' } },
    })
    expect(app.problems.get()).toContainEqual(expect.objectContaining({
      code: 'replace.migration.archived',
    }))
    expect(app.problems.get()).toContainEqual(expect.objectContaining({
      code: 'replace.review',
      message: expect.stringContaining("node 'old'"),
    }))
    expect(app.problems.get()).not.toContainEqual(expect.objectContaining({
      code: 'replace.review',
      message: expect.stringContaining("node 'image'"),
    }))
  })

  it('applies a leading fallback but holds its safe ordinary follow-up in review mode', () => {
    loadSchemas()
    app.reviewReplacements.set(true)
    const migration: ReplacementRule = {
      from: 'EmptyLatentImage',
      migration: { historicalInputs: ['legacy_selector'] },
      cases: [{
        to: 'EmptyLatentImage',
        when: { kind: 'valueEquals', input: 'legacy_selector', value: 'known' },
      }, { to: 'EmptyLatentImage' }],
    }
    const followUp: ReplacementRule = {
      from: 'EmptyLatentImage',
      cases: [{ to: 'EmptyImage' }],
    }
    expect(app.registerReplacementRule('pack', migration)).toEqual([])
    expect(app.registerReplacementRule('pack', followUp)).toEqual([])
    expect(app.openDocument(docJson('lin-review-fallback-chain', {
      image: { type: 'EmptyLatentImage', values: { legacy_selector: 'invalid' } },
    }), 'T')).toEqual([])
    const tab = app.activeTab()!

    expect(nodeType(tab, 'image')).toBe('EmptyLatentImage')
    expect(tab.store.doc.graphs.g0!.nodes.image!.values).not.toHaveProperty('legacy_selector')
    expect(tab.store.doc.graphs.g0!.nodes.image!.ext?.['dinkster.replacementMigration']).toBeDefined()
    expect(app.problems.get()).toContainEqual(expect.objectContaining({
      code: 'replace.review',
      message: expect.stringContaining("node 'image' (EmptyLatentImage) can be upgraded to 'EmptyImage'"),
    }))
  })

  it('applies a leading fallback even when its ordinary follow-up needs review', () => {
    loadSchemas()
    const migration: ReplacementRule = {
      from: 'EmptyLatentImage',
      migration: { historicalInputs: ['legacy_selector'] },
      cases: [{
        to: 'EmptyLatentImage',
        when: { kind: 'valueEquals', input: 'legacy_selector', value: 'known' },
        outputs: { out0: 'out0' },
      }, {
        to: 'EmptyLatentImage',
        outputs: { out0: 'out0' },
      }],
    }
    const followUp: ReplacementRule = {
      from: 'EmptyLatentImage',
      cases: [{ to: 'EmptyImage' }],
    }
    expect(app.registerReplacementRule('pack', migration)).toEqual([])
    expect(app.registerReplacementRule('pack', followUp)).toEqual([])
    expect(app.openDocument(docJson(
      'lin-lossy-fallback-chain',
      {
        image: { type: 'EmptyLatentImage', values: { legacy_selector: 'invalid' } },
        sink: { type: 'VAEDecode' },
      },
      {
        latent: {
          id: 'latent',
          from: { node: 'image', port: 'out0' },
          to: { node: 'sink', port: 'samples' },
        },
      },
    ), 'T')).toEqual([])
    const tab = app.activeTab()!

    expect(nodeType(tab, 'image')).toBe('EmptyLatentImage')
    expect(tab.store.doc.graphs.g0!.nodes.image!.values).not.toHaveProperty('legacy_selector')
    expect(tab.store.doc.graphs.g0!.links.latent).toBeDefined()
    expect(app.problems.get()).toContainEqual(expect.objectContaining({
      code: 'replace.review',
      message: expect.stringContaining("node 'image' (EmptyLatentImage) can be upgraded to 'EmptyImage'"),
    }))
  })

  it('holds unknown-selector fallbacks that share historical runtime state', () => {
    loadSchemas()
    app.reviewReplacements.set(true)
    const migration: ReplacementRule = {
      from: 'EmptyLatentImage',
      migration: { historicalInputs: ['mode', 'legacy'] },
      cases: [{
        to: 'EmptyLatentImage',
        when: { kind: 'valueEquals', input: 'mode', value: 'known' },
      }, { to: 'EmptyLatentImage' }],
    }
    expect(app.registerReplacementRule('pack', migration)).toEqual([])
    expect(app.openDocument(docJson(
      'lin-shared-fallback-link',
      {
        a: { type: 'EmptyLatentImage', values: { mode: 'bad-a' } },
        b: { type: 'EmptyLatentImage', values: { mode: 'bad-b' } },
      },
      {
        shared: {
          id: 'shared',
          from: { node: 'a', tap: 'legacy', members: ['value'] },
          to: { node: 'b', port: 'legacy' },
        },
      },
    ), 'T')).toEqual([])
    const tab = app.activeTab()!

    expect(tab.store.doc.graphs.g0!.nodes.a!.values).toEqual({ mode: 'bad-a' })
    expect(tab.store.doc.graphs.g0!.nodes.b!.values).toEqual({ mode: 'bad-b' })
    expect(tab.store.doc.graphs.g0!.nodes.a!.ext?.['dinkster.replacementMigration']).toBeUndefined()
    expect(tab.store.doc.graphs.g0!.nodes.b!.ext?.['dinkster.replacementMigration']).toBeUndefined()
    expect(tab.store.doc.graphs.g0!.links.shared).toBeDefined()
    expect(app.problems.get()).toContainEqual(expect.objectContaining({ code: 'replace.review' }))
    expect(app.problems.get()).not.toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
  })

  it('replans matched migrations that share one historical link', () => {
    loadSchemas()
    const migration: ReplacementRule = {
      from: 'EmptyLatentImage',
      migration: { historicalInputs: ['mode', 'legacy'] },
      cases: [{
        to: 'EmptyLatentImage',
        when: { kind: 'valueEquals', input: 'mode', value: 'known' },
        inputs: { batch_size: { kind: 'copy', input: 'legacy' } },
      }, { to: 'EmptyLatentImage' }],
    }
    expect(app.registerReplacementRule('pack', migration)).toEqual([])
    expect(app.openDocument(docJson(
      'lin-shared-matched-link',
      {
        a: { type: 'EmptyLatentImage', values: { mode: 'known', legacy: 320 } },
        b: { type: 'EmptyLatentImage', values: { mode: 'known', legacy: 640 } },
      },
      {
        shared: {
          id: 'shared',
          from: { node: 'a', tap: 'legacy' },
          to: { node: 'b', port: 'legacy' },
        },
      },
    ), 'T')).toEqual([])
    const tab = app.activeTab()!

    expect(tab.store.doc.graphs.g0!.nodes.a!.values).not.toHaveProperty('mode')
    expect(tab.store.doc.graphs.g0!.nodes.b!.values).not.toHaveProperty('mode')
    expect(tab.store.doc.graphs.g0!.nodes.a!.values.batch_size).toBe(320)
    expect(tab.store.doc.graphs.g0!.nodes.b!.values.batch_size).toBe(640)
    expect(tab.store.doc.graphs.g0!.nodes.a!.ext?.['dinkster.replacementMigration']).toBeDefined()
    expect(tab.store.doc.graphs.g0!.nodes.b!.ext?.['dinkster.replacementMigration']).toBeDefined()
    expect(tab.store.doc.graphs.g0!.links.shared).toMatchObject({
      from: { node: 'a', tap: 'batch_size' },
      to: { node: 'b', port: 'batch_size' },
    })
    expect(app.problems.get()).not.toContainEqual(expect.objectContaining({ code: 'replace.review' }))
    expect(app.problems.get()).not.toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
  })
})

// ---------------------------------------------------------------------------
// Native backends: synthesized alias rules + unresolved-type surfacing
// ---------------------------------------------------------------------------

const nodesPayload = JSON.parse(readFileSync(join(root, 'fixtures/dinkster-nodes-comfy.json'), 'utf8')) as DinksterNodesPayload
const dynamicTargetFixture = JSON.parse(readFileSync(
  join(root, 'fixtures/replacements/dynamic-target.json'),
  'utf8',
)) as { schemas: Array<Record<string, unknown> & { nodeType: string }> }

const dynamicTargetPayload = (): DinksterNodesPayload => {
  const raw = structuredClone(nodesPayload) as any
  raw.dinkster.schemaWire = DINKSTER_SCHEMA_WIRE_VERSION
  raw.packs = {}
  raw.nodes = Object.fromEntries(
    dynamicTargetFixture.schemas.map((schema) => [schema.nodeType, schema]),
  )
  return raw as DinksterNodesPayload
}

const chainedMigrationPayload = (): DinksterNodesPayload => {
  const raw = structuredClone(nodesPayload) as any
  const type = { kind: 'concrete', types: ['core.int'] }
  const input = (id: string): Record<string, unknown> => ({
    role: 'input',
    id,
    type,
    required: false,
  })
  const output = (id: string): Record<string, unknown> => ({ role: 'output', id, type })
  raw.dinkster.schemaWire = DINKSTER_SCHEMA_WIRE_VERSION
  raw.packs = {}
  raw.nodes = {
    'fixture.chain-old': {
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      nodeType: 'fixture.chain-old',
      displayName: 'Chain Old',
      category: 'fixture',
      interface: [input('value'), output('result')],
    },
    'fixture.chain-current': {
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      nodeType: 'fixture.chain-current',
      displayName: 'Chain Current',
      category: 'fixture',
      interface: [input('legacy'), input('current'), output('legacy_result'), output('current_result')],
    },
  }
  return raw as DinksterNodesPayload
}

const maintainedAliasPayload = (
  records: readonly {
    readonly nodeClass: string
    readonly sourceType: string
    readonly mappingKind?: 'op' | 'family'
    readonly mapOutput?: boolean
  }[],
): DinksterNodesPayload => {
  const raw = structuredClone(nodesPayload) as any
  const sourceSchemas = records.map(({ sourceType }) => {
    const source = structuredClone(raw.nodes['comfy.EmptyImage'])
    source.nodeType = sourceType
    delete source.aliases
    delete source.pack
    delete source.signature
    return source
  })
  raw.packs.comfy.comfyAliases = {
    format: 'dinkster-comfy-alias/1',
    sourceSchemas,
    records: records.map(({ nodeClass, sourceType, mappingKind = 'op', mapOutput = true }) => ({
      id: `comfy_alias:comfy-core/${nodeClass}`,
      mappingKind,
      carrier: 'comfy.EmptyImage',
      source: {
        pack: 'comfy-core',
        nodeClass,
        nodeType: sourceType,
        revision: 'b78cec87',
      },
      replacement: {
        from: sourceType,
        cases: [{
          to: 'comfy.EmptyImage',
          inputs: {
            width: { kind: 'copy', input: 'width' },
            height: { kind: 'copy', input: 'height' },
            batch_size: { kind: 'copy', input: 'batch_size' },
            color: { kind: 'copy', input: 'color' },
          },
          ...(mapOutput ? { outputs: { image: 'image' } } : {}),
        }],
      },
      confidence: {
        tier: mappingKind === 'op' ? 'exact' : 'parametric',
        evidence: [`tests/${nodeClass}.json`],
      },
      ...(mappingKind === 'family' ? { family: { id: 'image', provider: 'missing-provider' } } : {}),
    })),
  }
  return raw as DinksterNodesPayload
}

const maintainedGroupPayload = (): DinksterNodesPayload => {
  const raw = structuredClone(nodesPayload) as any
  const source = (nativeType: 'comfy.EmptyImage' | 'comfy.PreviewImage', nodeType: string): any => {
    const schema = structuredClone(raw.nodes[nativeType])
    schema.nodeType = nodeType
    delete schema.aliases
    delete schema.pack
    delete schema.signature
    return schema
  }
  const emptyType = 'comfy_group_source:comfy-core/EmptyImage'
  const previewType = 'comfy_group_source:comfy-core/PreviewImage'
  const groupType = 'comfy-group.comfy-core.empty-image-preview'
  const groupSchema = source('comfy.EmptyImage', groupType)
  groupSchema.interface = groupSchema.interface.filter((item: { role: string }) => item.role === 'input')
  raw.packs.comfy.comfyGroups = {
    format: 'dinkster-comfy-group/1',
    sourceSchemas: [
      source('comfy.EmptyImage', emptyType),
      source('comfy.PreviewImage', previewType),
    ],
    groupSchemas: [groupSchema],
    records: [{
      id: 'comfy_group:comfy-core/empty-image-preview',
      mappingKind: 'op',
      carrier: 'comfy.EmptyImage',
      source: { pack: 'comfy-core', name: 'empty-image-preview', revision: 'b78cec87' },
      pattern: {
        groupType,
        anchor: 'preview',
        nodes: {
          image: {
            source: { pack: 'comfy-core', nodeClass: 'EmptyImage', nodeType: emptyType, revision: 'b78cec87' },
            mode: 'active',
          },
          preview: {
            source: { pack: 'comfy-core', nodeClass: 'PreviewImage', nodeType: previewType, revision: 'b78cec87' },
            mode: 'active',
          },
        },
        edges: [{ from: 'image:image', to: 'preview:images' }],
        disconnected: [],
        boundary: { inputs: {}, outputs: {} },
        parameters: {
          width: 'image:width',
          height: 'image:height',
          batch_size: 'image:batch_size',
          color: 'image:color',
        },
        constants: {},
      },
      replacement: {
        from: groupType,
        cases: [{
          to: 'comfy.EmptyImage',
          inputs: {
            width: { kind: 'copy', input: 'width' },
            height: { kind: 'copy', input: 'height' },
            batch_size: { kind: 'copy', input: 'batch_size' },
            color: { kind: 'copy', input: 'color' },
          },
        }],
      },
      confidence: { tier: 'grouped', evidence: ['tests/empty-image-preview.json'] },
    }],
  }
  return raw as DinksterNodesPayload
}

const maintainedDynamicGroupPayload = (): DinksterNodesPayload => {
  const raw = structuredClone(nodesPayload) as any
  const fixtureSchema = (type: string): any => structuredClone(
    dynamicTargetFixture.schemas.find((schema) => schema.nodeType === type)!,
  )
  const native = (schema: any): any => ({
    ...schema,
    pack: 'comfy',
    aliases: [],
    signature: '0000000000000000000000000000000000000000',
  })
  const maskType = { kind: 'concrete', types: ['comfy.MASK'] }
  const input = (id: string, required: boolean, defaultValue?: string): any => ({
    role: 'input',
    id,
    type: maskType,
    required,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  })
  const polarityInput = (): any => ({
    role: 'input',
    id: 'mask_polarity',
    type: { kind: 'concrete', types: ['core.string'] },
    required: false,
    default: 'white',
  })
  const output = (id: string): any => ({ role: 'output', id, type: maskType })
  const sourceType = 'comfy.fixture.MaskSource'
  const passType = 'comfy_group_source:fixture-group/MaskPass'
  const sinkType = 'comfy_group_source:fixture-group/MaskSink'
  const groupType = 'comfy-group.fixture-group.mask-chain'
  const sourceSchema = fixtureSchema('fixture.mask-source')
  sourceSchema.nodeType = sourceType
  const passSchema = {
    schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
    nodeType: passType,
    displayName: 'Mask Pass',
    category: 'fixture',
    interface: [input('mask', true), polarityInput(), output('mask')],
  }
  const sinkSchema = {
    schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
    nodeType: sinkType,
    displayName: 'Mask Sink',
    category: 'fixture',
    interface: [input('mask', true)],
  }
  const groupSchema = {
    schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
    nodeType: groupType,
    displayName: 'Mask Chain',
    category: 'fixture',
    interface: [input('mask', true), polarityInput()],
  }
  raw.dinkster.schemaWire = DINKSTER_SCHEMA_WIRE_VERSION
  raw.nodes = {}
  raw.nodes['fixture.mask-source'] = native(fixtureSchema('fixture.mask-source'))
  raw.nodes['fixture.slot-modern'] = native(fixtureSchema('fixture.slot-modern'))
  raw.packs.comfy.comfyAliases = {
    format: 'dinkster-comfy-alias/1',
    sourceSchemas: [sourceSchema],
    records: [{
      id: 'comfy_alias:fixture-source/MaskSource',
      mappingKind: 'op',
      carrier: 'fixture.mask-source',
      source: {
        pack: 'fixture-source',
        nodeClass: 'MaskSource',
        nodeType: sourceType,
        revision: 'fixture-v1',
      },
      replacement: {
        from: sourceType,
        cases: [{ to: 'fixture.mask-source', outputs: { mask: 'mask' } }],
      },
      confidence: { tier: 'exact', evidence: ['tests/mask-source.json'] },
    }],
  }
  raw.packs.comfy.comfyGroups = {
    format: 'dinkster-comfy-group/1',
    sourceSchemas: [passSchema, sinkSchema],
    groupSchemas: [groupSchema],
    records: [{
      id: 'comfy_group:fixture-group/mask-chain',
      mappingKind: 'op',
      carrier: 'fixture.slot-modern',
      source: { pack: 'fixture-group', name: 'mask-chain', revision: 'fixture-v1' },
      pattern: {
        groupType,
        anchor: 'sink',
        nodes: {
          pass: {
            source: {
              pack: 'fixture-group',
              nodeClass: 'MaskPass',
              nodeType: passType,
              revision: 'fixture-v1',
            },
            mode: 'active',
          },
          sink: {
            source: {
              pack: 'fixture-group',
              nodeClass: 'MaskSink',
              nodeType: sinkType,
              revision: 'fixture-v1',
            },
            mode: 'active',
          },
        },
        edges: [{ from: 'pass:mask', to: 'sink:mask' }],
        disconnected: [],
        boundary: { inputs: { mask: 'pass:mask' }, outputs: {} },
        parameters: { mask_polarity: 'pass:mask_polarity' },
        constants: {},
      },
      replacement: {
        from: groupType,
        cases: [{
          to: 'fixture.slot-modern',
          slotVariants: { mask: 'mask' },
          inputs: {
            mask: { kind: 'link', input: 'mask' },
            'mask.mask_polarity': { kind: 'copy', input: 'mask_polarity' },
          },
        }],
      },
      confidence: { tier: 'grouped', evidence: ['tests/mask-chain.json'] },
    }],
  }
  return raw as DinksterNodesPayload
}

const maintainedTiledGroupPayload = (): DinksterNodesPayload => {
  const raw = structuredClone(nodesPayload) as any
  const concrete = (type: string): any => ({ kind: 'concrete', types: [type] })
  const input = (id: string, type: string, defaultValue?: number | string): any => ({
    role: 'input',
    id,
    type: concrete(type),
    required: defaultValue === undefined,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  })
  const output = (id: string, type: string): any => ({ role: 'output', id, type: concrete(type) })
  const nativeType = 'comfy.TiledUpscale'
  const splitType = 'comfy_group_source:comfy-core/ImageTileSplit'
  const scaleType = 'comfy_group_source:comfy-core/ImageScaleBy'
  const mergeType = 'comfy_group_source:comfy-core/ImageTileMerge'
  const groupType = 'comfy-group.comfy-core.tiled-upscale'
  const imageInput = input('image', 'comfy.IMAGE')
  const imageOutput = output('image', 'comfy.IMAGE')
  const native = structuredClone(raw.nodes['comfy.EmptyImage'])
  native.nodeType = nativeType
  native.displayName = 'Tiled Upscale'
  native.interface = [imageInput, input('tile_size', 'core.int', 512), input('scale_by', 'core.float', 2), imageOutput]
  native.aliases = []
  native.signature = '0000000000000000000000000000000000000000'
  raw.nodes[nativeType] = native
  const source = (nodeType: string, items: readonly any[]): any => {
    const schema = structuredClone(native)
    schema.nodeType = nodeType
    schema.interface = items
    delete schema.aliases
    delete schema.pack
    delete schema.signature
    return schema
  }
  raw.packs.comfy.comfyGroups = {
    format: 'dinkster-comfy-group/1',
    sourceSchemas: [
      source(splitType, [imageInput, input('tile_size', 'core.int', 512), output('tiles', 'comfy.IMAGE')]),
      source(scaleType, [
        imageInput,
        input('upscale_method', 'core.string', 'nearest-exact'),
        input('scale_by', 'core.float', 2),
        imageOutput,
      ]),
      source(mergeType, [input('tiles', 'comfy.IMAGE'), input('overlap', 'core.int', 32), imageOutput]),
    ],
    groupSchemas: [source(groupType, native.interface)],
    records: [{
      id: 'comfy_group:comfy-core/tiled-upscale',
      mappingKind: 'op',
      carrier: nativeType,
      source: { pack: 'comfy-core', name: 'tiled-upscale', revision: 'b78cec87' },
      pattern: {
        groupType,
        anchor: 'merge',
        nodes: {
          split: {
            source: { pack: 'comfy-core', nodeClass: 'ImageTileSplit', nodeType: splitType, revision: 'b78cec87' },
            mode: 'active',
          },
          upscale: {
            source: { pack: 'comfy-core', nodeClass: 'ImageScaleBy', nodeType: scaleType, revision: 'b78cec87' },
            mode: 'active',
          },
          merge: {
            source: { pack: 'comfy-core', nodeClass: 'ImageTileMerge', nodeType: mergeType, revision: 'b78cec87' },
            mode: 'active',
          },
        },
        edges: [
          { from: 'split:tiles', to: 'upscale:image' },
          { from: 'upscale:image', to: 'merge:tiles' },
        ],
        disconnected: [],
        boundary: { inputs: { image: 'split:image' }, outputs: { image: 'merge:image' } },
        parameters: { tile_size: 'split:tile_size', scale_by: 'upscale:scale_by' },
        constants: { 'upscale:upscale_method': 'nearest-exact', 'merge:overlap': 32 },
      },
      replacement: {
        from: groupType,
        cases: [{
          to: nativeType,
          inputs: {
            image: { kind: 'copy', input: 'image' },
            tile_size: { kind: 'copy', input: 'tile_size' },
            scale_by: { kind: 'copy', input: 'scale_by' },
          },
          outputs: { image: 'image' },
        }],
      },
      confidence: { tier: 'grouped', evidence: ['tests/tiled-upscale.json'] },
    }],
  }
  return raw as DinksterNodesPayload
}

/** Put the native namespaced schemas on the default backend. */
const loadNativeSchemas = (): void => {
  const backend = app.backends.get()[0]!
  backend.registry.set(buildDinksterRegistry(backend.id, nodesPayload))
}

const dynamicOutputPayload = (): DinksterNodesPayload => {
  const raw = structuredClone(nodesPayload) as any
  const type = (name: string): any => ({ kind: 'concrete', types: [name] })
  const schema = (count: string, family: string): any => ({
    schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
    interface: [
      { role: 'input', id: count, required: true, type: type('core.int') },
      {
        role: 'outputFamily',
        id: family,
        type: type('comfy.IMAGE'),
        minMembers: 0,
        maxMembers: 4,
        count: { input: count, suffix: 'index' },
      },
    ],
  })
  raw.dinkster.schemaWire = DINKSTER_SCHEMA_WIRE_VERSION
  raw.packs = {}
  raw.nodes = {
    'test.DynamicOld': schema('count', 'results'),
    'test.DynamicNew': schema('quantity', 'items'),
  }
  return raw as DinksterNodesPayload
}

describe('dynamic output replacement integration', () => {
  it('applies a DynamicSlot replacement whose producer is import-only', () => {
    const backend = app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, dynamicTargetPayload())
    const schemas = new Map(registry.schemas)
    const producer = schemas.get('fixture.mask-source')!
    schemas.delete(producer.type)
    const importOnlyRegistry: typeof registry = {
      ...registry,
      schemas,
      resolve: (type) => schemas.get(type),
      comfyAliases: {
        records: [],
        sourceSchemas: new Map([[producer.type, producer]]),
        recordsBySourceType: new Map(),
        recordsByNodeClass: new Map(),
      },
    }
    backend.registry.set(importOnlyRegistry)
    expect(app.openDocument(docJson(
      'dynamic-slot-import-only-producer',
      {
        source: { type: 'fixture.mask-source' },
        old: { type: 'fixture.slot-legacy', values: { mask_polarity: 'white' } },
      },
      {
        mask: {
          id: 'mask',
          from: { node: 'source', port: 'mask' },
          to: { node: 'old', port: 'mask' },
        },
      },
    ), 'Dynamic slot import')).toEqual([])
    const tab = app.activeTab()!
    expect(nodeType(tab, 'old')).toBe('fixture.slot-modern')
    expect(tab.store.doc.graphs.g0!.nodes.old!.dynamic).toEqual({ mask: { selected: 'mask' } })
    expect(tab.store.doc.graphs.g0!.nodes.old!.values).toEqual({ 'mask.mask_polarity': 'white' })
    expect(app.problems.get()).not.toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
  })

  it('replans a migration reached after an ordinary hop against shared links', () => {
    const backend = app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, chainedMigrationPayload())
    expect(registry.diagnostics).toEqual([])
    backend.registry.set(registry)
    const ordinary: ReplacementRule = {
      from: 'fixture.chain-old',
      cases: [{
        to: 'fixture.chain-current',
        inputs: { legacy: { kind: 'copy', input: 'value' } },
        outputs: { legacy_result: 'result' },
      }],
    }
    const migration: ReplacementRule = {
      from: 'fixture.chain-current',
      migration: { historicalInputs: ['legacy'] },
      cases: [{
        to: 'fixture.chain-current',
        inputs: { current: { kind: 'copy', input: 'legacy' } },
        outputs: { current_result: 'legacy_result' },
      }],
    }
    expect(app.registerReplacementRule('pack', ordinary)).toEqual([])
    expect(app.registerReplacementRule('pack', migration)).toEqual([])
    expect(app.openDocument(docJson(
      'ordinary-then-migration-shared-link',
      {
        a: { type: 'fixture.chain-old', values: { value: 10 } },
        b: { type: 'fixture.chain-old', values: { value: 20 } },
      },
      {
        shared: {
          id: 'shared',
          from: { node: 'a', port: 'result' },
          to: { node: 'b', port: 'value' },
        },
      },
    ), 'Chained migration')).toEqual([])
    const tab = app.activeTab()!
    expect(app.scanTabReplacements(tab)).toEqual([])
    expect(nodeType(tab, 'a')).toBe('fixture.chain-current')
    expect(nodeType(tab, 'b')).toBe('fixture.chain-current')
    expect(tab.store.doc.graphs.g0!.nodes.a!.values).toEqual({ current: 10 })
    expect(tab.store.doc.graphs.g0!.nodes.b!.values).toEqual({ current: 20 })
    expect(tab.store.doc.graphs.g0!.links.shared).toMatchObject({
      from: { node: 'a', port: 'current_result' },
      to: { node: 'b', port: 'current' },
    })
    expect(app.problems.get()).not.toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
    expect(app.problems.get()).not.toContainEqual(expect.objectContaining({ code: 'replace.review' }))
  })

  it('holds an ordinary prefix whose later migration fallback is mandatory in review mode', () => {
    const backend = app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, chainedMigrationPayload())
    expect(registry.diagnostics).toEqual([])
    backend.registry.set(registry)
    app.reviewReplacements.set(true)
    const ordinary: ReplacementRule = {
      from: 'fixture.chain-old',
      cases: [{
        to: 'fixture.chain-current',
        inputs: { legacy: { kind: 'copy', input: 'value' } },
        outputs: { legacy_result: 'result' },
      }],
    }
    const migration: ReplacementRule = {
      from: 'fixture.chain-current',
      migration: { historicalInputs: ['legacy'] },
      cases: [{
        to: 'fixture.chain-current',
        inputs: { current: { kind: 'copy', input: 'legacy' } },
        outputs: { current_result: 'legacy_result' },
      }],
    }
    expect(app.registerReplacementRule('pack', ordinary)).toEqual([])
    expect(app.registerReplacementRule('pack', migration)).toEqual([])
    expect(app.openDocument(docJson('review-ordinary-then-migration', {
      old: { type: 'fixture.chain-old', values: { value: 10 } },
    }), 'Held chained migration')).toEqual([])
    const tab = app.activeTab()!

    expect(nodeType(tab, 'old')).toBe('fixture.chain-old')
    expect(tab.store.doc.graphs.g0!.nodes.old!.values).toEqual({ value: 10 })
    expect(tab.store.revision).toBe(0)
    expect(app.problems.get()).toContainEqual(expect.objectContaining({
      code: 'replace.review',
      message: expect.stringContaining("node 'old'"),
    }))
  })

  it('runs registry scan and atomic dispatch with exact member endpoints on open', () => {
    const backend = app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, dynamicOutputPayload())
    backend.registry.set(registry)
    const rule: ReplacementRule = {
      from: 'test.DynamicOld',
      cases: [{
        to: 'test.DynamicNew',
        inputs: { quantity: { kind: 'copy', input: 'count' } },
        outputFamilies: { items: { kind: 'copy', sourceFamily: 'results' } },
      }],
    }
    expect(app.registerReplacementRule('pack', rule)).toEqual([])
    expect(app.openDocument(docJson(
      'dynamic-output-replacement',
      {
        old: { type: 'test.DynamicOld', values: { count: 2 } },
        sink: { type: 'comfy.PreviewImage' },
      },
      {
        linked: {
          id: 'linked',
          from: { node: 'old', port: 'results', members: ['1'] },
          to: { node: 'sink', port: 'images' },
        },
      },
    ), 'Dynamic outputs')).toEqual([])
    const tab = app.activeTab()!
    expect(nodeType(tab, 'old')).toBe('test.DynamicNew')
    expect(tab.store.doc.graphs.g0!.nodes.old!.values).toEqual({ quantity: 2 })
    expect(tab.store.doc.graphs.g0!.links.linked!.from).toEqual({
      node: 'old',
      port: 'items',
      members: ['1'],
    })
    expect(tab.store.undo()).toBe(true)
    expect(nodeType(tab, 'old')).toBe('test.DynamicOld')
    expect(tab.store.doc.graphs.g0!.links.linked!.from).toEqual({
      node: 'old',
      port: 'results',
      members: ['1'],
    })
  })
})

describe('legacy documents against a native backend', () => {
  it('applies a dynamic group replacement using its pre-registration import registry', () => {
    const backend = app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, maintainedDynamicGroupPayload())
    expect(registry.diagnostics).toEqual([])
    backend.registry.set(registry)
    const litegraph = {
      nodes: [
        {
          id: 1,
          type: 'MaskSource',
          outputs: [{ name: 'MASK', links: [1] }],
        },
        {
          id: 2,
          type: 'MaskPass',
          inputs: [{ name: 'mask', link: 1 }],
          outputs: [{ name: 'MASK', links: [2] }],
          widgets_values: ['white'],
        },
        {
          id: 3,
          type: 'MaskSink',
          inputs: [{ name: 'mask', link: 2 }],
        },
      ],
      links: [
        [1, 1, 0, 2, 0, 'MASK'],
        [2, 2, 0, 3, 0, 'MASK'],
      ],
      groups: [],
      version: 0.4,
    }

    expect(app.openDocument(litegraph, 'Dynamic maintained group')).toEqual([])
    const tab = app.activeTab()!
    expect(Object.keys(tab.store.doc.graphs.g0!.nodes).sort()).toEqual(['n1', 'n3'])
    expect(nodeType(tab, 'n1')).toBe('fixture.mask-source')
    expect(nodeType(tab, 'n3')).toBe('fixture.slot-modern')
    expect(tab.store.doc.graphs.g0!.nodes.n3).toMatchObject({
      dynamic: { mask: { selected: 'mask' } },
      values: { 'mask.mask_polarity': 'white' },
    })
    expect(tab.store.doc.graphs.g0!.links.l1).toMatchObject({
      from: { node: 'n1', port: 'mask' },
      to: { node: 'n3', port: 'mask' },
    })
    expect(app.problems.get()).not.toContainEqual(expect.objectContaining({
      code: 'import.comfyGroup.review',
    }))
    expect(app.problems.get()).not.toContainEqual(expect.objectContaining({
      code: 'replace.schemaAuthorityUnavailable',
    }))
  })

  it('collapses and replaces a maintained exact group while reporting grouped confidence', () => {
    const backend = app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, maintainedGroupPayload())
    backend.registry.set(registry)
    expect(registry.comfyGroups?.records).toHaveLength(1)

    const litegraph = {
      nodes: [
        {
          id: 1,
          type: 'EmptyImage',
          pos: [0, 0],
          outputs: [{ name: 'IMAGE', links: [1] }],
          widgets_values: [64, 32, 2, 7],
        },
        {
          id: 2,
          type: 'PreviewImage',
          pos: [300, 50],
          inputs: [{ name: 'images', link: 1 }],
        },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE']],
      groups: [],
      version: 0.4,
    }
    expect(app.openDocument(litegraph, 'Maintained group')).toEqual([])
    const tab = app.activeTab()!
    expect(Object.keys(tab.store.doc.graphs.g0!.nodes)).toEqual(['n2'])
    expect(nodeType(tab, 'n2')).toBe('comfy.EmptyImage')
    expect(tab.store.doc.graphs.g0!.nodes.n2!.values).toEqual({
      width: 64,
      height: 32,
      batch_size: 2,
      color: 7,
    })
    expect(tab.store.doc.view.graphs.g0!.nodes.n2!.position).toEqual({ x: 300, y: 50 })
    expect(app.problems.get().find((problem) => problem.code === 'import.comfyAlias.confidence.op')?.message)
      .toContain('total=1; confidence exact=0, parametric=0, equivalent=0, grouped=1')
    expect(app.problems.get().some((problem) => problem.code === 'schema.unresolvedType')).toBe(false)

    const translated = structuredClone(tab.store.doc)
    expect(tab.store.undo()).toBe(true)
    expect(Object.keys(tab.store.doc.graphs.g0!.nodes).sort()).toEqual(['n1', 'n2'])
    expect(nodeType(tab, 'n1')).toBe('comfy_group_source:comfy-core/EmptyImage')
    expect(nodeType(tab, 'n2')).toBe('comfy_group_source:comfy-core/PreviewImage')
    expect(Object.values(tab.store.doc.graphs.g0!.links)).toEqual([
      { id: 'l1', from: { node: 'n1', port: 'image' }, to: { node: 'n2', port: 'images' } },
    ])
    expect(tab.store.redo()).toBe(true)
    expect(tab.store.doc).toEqual(translated)
  })

  it('replaces a matched tiled-upscale chain with its native carrier atomically', () => {
    const backend = app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, maintainedTiledGroupPayload())
    backend.registry.set(registry)
    expect(registry.comfyGroups?.records).toHaveLength(1)

    const litegraph = {
      nodes: [
        {
          id: 1,
          type: 'EmptyImage',
          outputs: [{ name: 'IMAGE', links: [1] }],
          widgets_values: [64, 64, 1, 0],
        },
        {
          id: 2,
          type: 'ImageTileSplit',
          inputs: [{ name: 'image', link: 1 }],
          outputs: [{ name: 'TILES', links: [2] }],
          widgets_values: [512],
        },
        {
          id: 3,
          type: 'ImageScaleBy',
          inputs: [{ name: 'image', link: 2 }],
          outputs: [{ name: 'IMAGE', links: [3] }],
          widgets_values: ['nearest-exact', 2],
        },
        {
          id: 4,
          type: 'ImageTileMerge',
          pos: [600, 80],
          inputs: [{ name: 'tiles', link: 3 }],
          outputs: [{ name: 'IMAGE', links: [4] }],
          widgets_values: [32],
        },
        {
          id: 5,
          type: 'PreviewImage',
          inputs: [{ name: 'images', link: 4 }],
        },
      ],
      links: [
        [1, 1, 0, 2, 0, 'IMAGE'],
        [2, 2, 0, 3, 0, 'IMAGE'],
        [3, 3, 0, 4, 0, 'IMAGE'],
        [4, 4, 0, 5, 0, 'IMAGE'],
      ],
      groups: [],
      version: 0.4,
    }

    expect(app.openDocument(litegraph, 'Tiled upscale group')).toEqual([])
    const tab = app.activeTab()!
    expect(Object.keys(tab.store.doc.graphs.g0!.nodes).sort()).toEqual(['n1', 'n4', 'n5'])
    expect(nodeType(tab, 'n4')).toBe('comfy.TiledUpscale')
    expect(tab.store.doc.graphs.g0!.nodes.n4!.values).toEqual({ tile_size: 512, scale_by: 2 })
    expect(tab.store.doc.view.graphs.g0!.nodes.n4!.position).toEqual({ x: 600, y: 80 })
    expect(Object.values(tab.store.doc.graphs.g0!.links)).toEqual([
      { id: 'l1', from: { node: 'n1', port: 'image' }, to: { node: 'n4', port: 'image' } },
      { id: 'l4', from: { node: 'n4', port: 'image' }, to: { node: 'n5', port: 'images' } },
    ])
    expect(Object.values(tab.store.doc.graphs.g0!.nodes).some((node) =>
      node.type.startsWith('comfy-group.') || node.type.startsWith('comfy_group_source:'))).toBe(false)

    const translated = structuredClone(tab.store.doc)
    expect(tab.store.undo()).toBe(true)
    expect(Object.keys(tab.store.doc.graphs.g0!.nodes).sort()).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
    expect(nodeType(tab, 'n2')).toBe('comfy_group_source:comfy-core/ImageTileSplit')
    expect(nodeType(tab, 'n3')).toBe('comfy_group_source:comfy-core/ImageScaleBy')
    expect(nodeType(tab, 'n4')).toBe('comfy_group_source:comfy-core/ImageTileMerge')
    expect(tab.store.redo()).toBe(true)
    expect(tab.store.doc).toEqual(translated)
  })

  it('retains the complete matched source graph when replacement review is enabled', () => {
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, maintainedGroupPayload()))
    app.reviewReplacements.set(true)
    const litegraph = {
      nodes: [
        {
          id: 1,
          type: 'EmptyImage',
          outputs: [{ name: 'IMAGE', links: [1] }],
          widgets_values: [64, 32, 2, 7],
        },
        {
          id: 2,
          type: 'PreviewImage',
          inputs: [{ name: 'images', link: 1 }],
        },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE']],
      groups: [],
      version: 0.4,
    }

    expect(app.openDocument(litegraph, 'Held group')).toEqual([])
    const tab = app.activeTab()!
    expect(Object.keys(tab.store.doc.graphs.g0!.nodes).sort()).toEqual(['n1', 'n2'])
    expect(Object.values(tab.store.doc.graphs.g0!.nodes).some((node) =>
      node.type.startsWith('comfy-group.'))).toBe(false)
    expect(tab.store.revision).toBe(0)
    expect(app.problems.get().some((problem) => problem.code === 'import.comfyGroup.review')).toBe(true)
  })

  it('uses maintained source snapshots before native aliases and reports op/family confidence separately', () => {
    const payload = maintainedAliasPayload([
      { nodeClass: 'EmptyImage', sourceType: 'comfy.LegacyEmptyImage' },
      {
        nodeClass: 'FamilyImage',
        sourceType: 'comfy.FamilyImage',
        mappingKind: 'family',
      },
    ])
    const backend = app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, payload)
    backend.registry.set(registry)
    expect(registry.resolve('comfy.LegacyEmptyImage')).toBeUndefined()
    expect(registry.comfyAliases?.sourceSchemas.has('comfy.LegacyEmptyImage')).toBe(true)
    expect(registry.resolve('comfy.EmptyImage')?.searchTerms).toContain('EmptyImage')
    expect(registry.resolve('comfy.EmptyImage')?.searchTerms).toContain('FamilyImage')

    const litegraph = {
      nodes: [
        { id: 1, type: 'EmptyImage', pos: [0, 0], widgets_values: [64, 64, 1, 0] },
        { id: 2, type: 'FamilyImage', pos: [300, 0], widgets_values: [32, 32, 1, 0] },
      ],
      links: [],
      groups: [],
      version: 0.4,
    }
    expect(app.openDocument(litegraph, 'Maintained aliases')).toEqual([])
    const tab = app.activeTab()!
    expect(nodeType(tab, 'n1')).toBe('comfy.EmptyImage')
    expect(nodeType(tab, 'n2')).toBe('comfy.EmptyImage')
    expect(tab.store.doc.graphs.g0!.nodes.n1!.values.width).toBe(64)
    expect(tab.store.doc.graphs.g0!.nodes.n2!.values.width).toBe(32)
    expect(app.problems.get().find((problem) => problem.code === 'import.comfyAlias.confidence.op')?.message)
      .toContain('total=1; confidence exact=1, parametric=0, equivalent=0, grouped=0')
    expect(app.problems.get().find((problem) => problem.code === 'import.comfyAlias.confidence.family')?.message)
      .toContain('total=1; confidence exact=0, parametric=1, equivalent=0, grouped=0; family providers available=0, unavailable=1, unknown=0; FamilyImage:unavailable')
  })

  it('holds every maintained alias when one item needs review', () => {
    const payload = maintainedAliasPayload([
      { nodeClass: 'EmptyImage', sourceType: 'comfy.LegacyEmptyImage' },
      {
        nodeClass: 'UnsafeImage',
        sourceType: 'comfy.UnsafeImage',
        mapOutput: false,
      },
    ])
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, payload))
    const litegraph = {
      nodes: [
        { id: 1, type: 'EmptyImage', pos: [0, 0], widgets_values: [64, 64, 1, 0] },
        {
          id: 2,
          type: 'UnsafeImage',
          pos: [300, 0],
          outputs: [{ name: 'IMAGE', links: [1] }],
          widgets_values: [32, 32, 1, 0],
        },
        {
          id: 3,
          type: 'PreviewImage',
          pos: [600, 0],
          inputs: [{ name: 'images', link: 1 }],
        },
      ],
      links: [[1, 2, 0, 3, 0, 'IMAGE']],
      groups: [],
      version: 0.4,
    }
    expect(app.openDocument(litegraph, 'Atomic aliases')).toEqual([])
    const tab = app.activeTab()!
    expect(nodeType(tab, 'n1')).toBe('comfy.LegacyEmptyImage')
    expect(nodeType(tab, 'n2')).toBe('comfy.UnsafeImage')
    expect(app.problems.get().filter((problem) => problem.code === 'replace.review')).toHaveLength(2)
    expect(app.problems.get().some((problem) => problem.code === 'schema.unresolvedType')).toBe(false)
  })

  it('canonicalizes LiteGraph aliases before replacement scanning', () => {
    loadNativeSchemas()
    const litegraph = {
      nodes: [
        {
          id: 1,
          type: 'EmptyImage',
          pos: [0, 0],
          outputs: [{ name: 'IMAGE', links: [1] }],
          widgets_values: [64, 64, 1, 0],
        },
        {
          id: 2,
          type: 'PreviewImage',
          pos: [300, 0],
          inputs: [{ name: 'images', link: 1 }],
        },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE']],
      groups: [],
      version: 0.4,
    }
    expect(app.openDocument(litegraph, 'LiteGraph aliases')).toEqual([])
    const tab = app.activeTab()!
    expect(nodeType(tab, 'n1')).toBe('comfy.EmptyImage')
    expect(nodeType(tab, 'n2')).toBe('comfy.PreviewImage')
    expect(tab.store.doc.graphs.g0!.nodes.n1!.values).toEqual({ width: 64, height: 64, batch_size: 1, color: 0 })
    expect(tab.store.doc.graphs.g0!.links.l1).toMatchObject({
      from: { node: 'n1', port: 'image' },
      to: { node: 'n2', port: 'images' },
    })
    expect(tab.store.revision).toBe(0)
    expect(app.scanTabReplacements(tab)).toEqual([])
    expect(app.problems.get().map((problem) => problem.code)).not.toContain('replace.applied')
    expect(app.compileTab(tab)?.ok).toBe(true)
  })

  it('auto-migrates bare types AND positional output ids in one undo step', () => {
    loadNativeSchemas()
    const json = docJson(
      'lin-legacy',
      { n0: { type: 'EmptyImage', values: { width: 64 } }, n1: { type: 'PreviewImage' } },
      { l2: { id: 'l2', from: { node: 'n0', port: 'out0' }, to: { node: 'n1', port: 'images' } } },
    )
    expect(app.openDocument(json, 'Legacy')).toEqual([])
    const tab = app.activeTab()!
    expect(nodeType(tab, 'n0')).toBe('comfy.EmptyImage')
    expect(nodeType(tab, 'n1')).toBe('comfy.PreviewImage')
    expect(tab.store.doc.graphs.g0!.links.l2!.from).toEqual({ node: 'n0', port: 'image' })
    expect(tab.store.revision).toBe(1)
    expect(app.problems.get().some((d) => d.code === 'replace.applied')).toBe(true)
    // The migrated document now compiles against the native backend.
    const result = app.compileTab(tab)
    expect(result?.ok).toBe(true)
  })

  it('the stock seed tabs open clean: no upgrade churn, no unresolved types', () => {
    loadNativeSchemas()
    const codes = app.problems.get().map((d) => d.code)
    expect(codes).not.toContain('replace.applied')
    expect(codes).not.toContain('replace.review')
    expect(codes).not.toContain('schema.unresolvedType')
  })

  it('the stock seeds silently migrate to canonical types: born-this-way, no undo step, compilable', () => {
    loadNativeSchemas()
    for (const tab of app.tabs.get()) {
      for (const graph of Object.values(tab.store.doc.graphs)) {
        for (const node of Object.values(graph.nodes)) {
          if (node.type.startsWith('#')) continue // subgraph instances resolve locally
          expect(node.type, `tab '${tab.title}' node '${node.id}'`).toMatch(/^comfy\./)
        }
      }
      expect(tab.store.canUndo, `tab '${tab.title}' must not carry a migration undo step`).toBe(false)
      expect(app.compileTab(tab)?.ok, `tab '${tab.title}' must compile on native`).toBe(true)
    }
  })

  it('a V1-first stock seed keeps its silent entitlement: retargeting to native migrates silently', () => {
    // V1 registry first: the seeds resolve natively as bare types, the
    // upgrade pass engages nothing, and stock provenance must survive.
    loadSchemas()
    const tab = app.tabs.get()[0]! // seed 'Basic'
    expect(nodeType(tab, 'n0')).toBe('EmptyImage') // untouched on V1
    expect(app.problems.get().map((d) => d.code)).not.toContain('replace.applied')
    // Point the tab at a native backend: the stock-pristine rearm must run
    // the silent baseline migration, not the loud badge flow.
    const native = app.addBackend('http://native.test', 'native', false, 'dinkster')!
    native.registry.set(buildDinksterRegistry(native.id, nodesPayload))
    app.setTabTarget(tab.id, native.id)
    expect(nodeType(tab, 'n0')).toBe('comfy.EmptyImage')
    expect(nodeType(tab, 'n1')).toBe('comfy.PreviewImage')
    expect(tab.store.canUndo).toBe(false)
    expect(app.problems.get().map((d) => d.code)).not.toContain('replace.applied')
  })

  it('a persisted pristine V1 stock seed migrates silently in a later native session', () => {
    const g = globalThis as { localStorage?: Storage }
    const map = new Map<string, string>()
    g.localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size
      },
    } as Storage
    try {
      // Session 1: V1 backend only; the seeds run unmigrated and persist
      // with their stock provenance intact.
      const first = new AppState()
      const firstBackend = first.backends.get()[0]!
      firstBackend.registry.set(buildSchemaRegistry(firstBackend.id, objectInfo))
      first.flushPersistTabs()
      // Session 2: restored tabs meet a native backend; the deferred stock
      // migration must be silent baseline normalization.
      const second = new AppState()
      const backend = second.backends.get()[0]!
      backend.registry.set(buildDinksterRegistry(backend.id, nodesPayload))
      const tab = second.tabs.get()[0]!
      expect(tab.store.doc.graphs[tab.store.doc.root]!.nodes.n0!.type).toBe('comfy.EmptyImage')
      expect(tab.store.canUndo).toBe(false)
      expect(second.problems.get().map((d) => d.code)).not.toContain('replace.applied')
    } finally {
      delete g.localStorage
    }
  })

  it('an edit made before schemas arrive keeps the seed upgrade loud and undoable', () => {
    const tab = app.tabs.get()[0]! // seed 'Basic': n0 EmptyImage / n1 PreviewImage
    // A user edit before any registry exists: the tab is no longer pristine,
    // so the later stock upgrade must stay reviewable, not silently rebased.
    const outcome = tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n0', inputId: 'width', value: 128 },
    })
    expect(outcome.ok).toBe(true)
    expect(tab.store.revision).toBeGreaterThan(0)
    loadNativeSchemas()
    expect(app.problems.get().some((d) => d.code === 'replace.applied')).toBe(true)
    expect(tab.store.canUndo).toBe(true)
  })
})

describe('unresolved-type reporting', () => {
  it('a type the backend lacks lands in Problems naming type, count, and backend', () => {
    loadNativeSchemas()
    expect(
      app.openDocument(docJson('lin-missing', { a: { type: 'NoSuchNode' }, b: { type: 'NoSuchNode' } }), 'T'),
    ).toEqual([])
    const found = app.problems.get().find((d) => d.code === 'schema.unresolvedType')
    expect(found).toBeDefined()
    expect(found!.message).toContain("'NoSuchNode'")
    expect(found!.message).toContain('2 node(s)')
    // Unresolved nodes are excluded from the executed closure (see compile's
    // unknown-schema demotion); the warning must not claim the workflow cannot run.
    expect(found!.message).toContain('excluded from execution')
    expect(found!.message).not.toContain('cannot run')
  })

  it('reports once per open, not again on later backend ticks', () => {
    loadNativeSchemas()
    expect(app.openDocument(docJson('lin-once', { a: { type: 'NoSuchNode' } }), 'T')).toEqual([])
    const count = () => app.problems.get().filter((d) => d.code === 'schema.unresolvedType').length
    expect(count()).toBe(1)
    app.backendsTick.update((v) => v + 1)
    expect(count()).toBe(1)
  })

  it('alias-resolved and subgraph-derived types are never reported', () => {
    loadNativeSchemas()
    expect(
      app.openDocument(docJson('lin-alias', { a: { type: 'EmptyImage' } }), 'T'),
    ).toEqual([])
    expect(app.problems.get().some((d) => d.code === 'schema.unresolvedType')).toBe(false)
  })
})

/**
 * Documents saved by the current release of each kind load through the one
 * shared document pipeline: every kind rides the same DocumentTypeAdapter
 * contract (load + invariants), the same LocalDocumentEngine, and the
 * registered migration chain. See fixtures/documents/README.md.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createWorkflowDocumentTypeAdapter,
  imageDocumentTypeAdapter,
} from '../src/commands/document-type.js'
import {
  LocalDocumentEngine,
  type DocumentTypeAdapter,
} from '../src/commands/document-engine.js'
import {
  checkVideoDocument,
  videoDocumentTypeAdapter,
} from '../src/commands/video-document.js'
import type { JsonObject } from '../src/format/document.js'
import { loadImageDocument, loadDocument, type MigrationStep } from '../src/format/migrate.js'
import { IMAGE_DOCUMENT_FORMAT_VERSION } from '../src/image-document/model.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/documents')
const loadFixture = (name: string): JsonObject =>
  JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8')) as JsonObject

const errorsOf = (diags: readonly { severity: string }[]) =>
  diags.filter((d) => d.severity === 'error')

const describeReleaseLoad = <D>(
  name: string,
  kind: string,
  adapter: DocumentTypeAdapter<D>,
) => {
  it(`${name}.json loads, passes invariants, and round-trips unchanged`, () => {
    const raw = loadFixture(name)
    const loaded = adapter.load(structuredClone(raw))
    expect(errorsOf(loaded.diagnostics)).toEqual([])
    expect(loaded.document).toBeDefined()
    expect(adapter.kind).toBe(kind)
    expect(adapter.check(loaded.document!)).toEqual([])
    expect(JSON.parse(JSON.stringify(loaded.document))).toEqual(raw)
  })

  it(`${name}.json stands up in the one shared LocalDocumentEngine`, () => {
    const engine = new LocalDocumentEngine(loadFixture(name) as unknown as D, adapter)
    expect(engine.revision).toBe(0)
    expect(engine.canUndo).toBe(false)
  })
}

describe('release document fixtures load through the shared pipeline', () => {
  describeReleaseLoad('workflow-release', 'dinkster.workflow', createWorkflowDocumentTypeAdapter())
  describeReleaseLoad('image-release', 'dinkster.image', imageDocumentTypeAdapter)
  describeReleaseLoad('video-release', 'dinkster.video', videoDocumentTypeAdapter)

  it('the video release document matches the shared video invariant check directly', () => {
    expect(checkVideoDocument(loadFixture('video-release') as never)).toEqual([])
  })
})

describe('release fixtures replay the migration chain', () => {
  it('workflow: a released migration stamps the release document forward', () => {
    // Pre-release the chain is synthetic (format.test.ts pattern); the step
    // must still replay over real release content, not only hand-built docs.
    const step: MigrationStep = {
      from: 1,
      description: 'test-only forward step over release content',
      migrate(doc) {
        return { doc, diagnostics: [] }
      },
    }
    const result = loadDocument(loadFixture('workflow-release'), {
      migrations: [step],
      targetVersion: 2,
    })
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.document).toBeDefined()
    expect(result.document!.formatVersion).toBe(2)
    expect(JSON.parse(JSON.stringify(result.document)).graphs).toEqual(
      loadFixture('workflow-release').graphs,
    )
  })

  it('image: the registered v1 -> v2 migration preserves release content', () => {
    // The only v2-only field this document carries is the canvas background;
    // stripping it yields the same document as a v1 save.
    const { background: _background, ...canvas } = loadFixture('image-release').canvas as Record<string, unknown>
    const asV1 = { ...loadFixture('image-release'), canvas, formatVersion: 1 }
    const result = loadImageDocument(structuredClone(asV1))
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.document).toBeDefined()
    expect(result.document!.formatVersion).toBe(IMAGE_DOCUMENT_FORMAT_VERSION)
    expect(JSON.parse(JSON.stringify(result.document))).toEqual({ ...asV1, formatVersion: 2 })
  })

  it('image: a future migration step replays over the release document', () => {
    const raw = loadFixture('image-release')
    const step = {
      from: IMAGE_DOCUMENT_FORMAT_VERSION,
      description: 'test-only forward step over release content',
      migrate(doc: JsonObject) {
        return { document: doc, diagnostics: [] }
      },
    }
    const result = loadImageDocument(structuredClone(raw), {
      migrations: [step],
      targetVersion: IMAGE_DOCUMENT_FORMAT_VERSION + 1,
    })
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.document).toBeDefined()
    expect(result.document!.formatVersion).toBe(IMAGE_DOCUMENT_FORMAT_VERSION + 1)
    expect(JSON.parse(JSON.stringify(result.document))).toEqual({
      ...raw,
      formatVersion: IMAGE_DOCUMENT_FORMAT_VERSION + 1,
    })
  })

  it('image: an unregistered future version refuses with a gap diagnostic', () => {
    const result = loadImageDocument({
      ...loadFixture('image-release'),
      formatVersion: IMAGE_DOCUMENT_FORMAT_VERSION + 1,
    })
    expect(result.document).toBeUndefined()
    expect(result.diagnostics.map((d) => d.code)).toContain('image.version.future')
  })
})

/**
 * The flattening cases the engine checks too (Dinkster
 * `tests/fixtures/flatten_v2.json`, copied byte for byte and pinned by sha),
 * so the engine and the editor give one node the same flattened ids.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDinksterSchema } from '../src/schema/dinkster-wire.js'
import { elabInputsOf, elabOutputsOf, elaborateInterface, type Connectivity } from '../src/schema/elaborate.js'
import { canonicalTypeIdOf } from '../src/schema/model.js'
import type { DynamicPortState, Json } from '../src/format/document.js'

const FIXTURE = new URL('./fixtures/flatten_v2.json', import.meta.url)
const FIXTURE_SHA256 = '3c95c96f05190c97c909783ee4126b9b334f496d3876014f5c74d6d2d6f26402'

interface FlattenCase {
  readonly id: string
  readonly body: readonly unknown[]
  readonly stored: readonly (readonly [string, Json])[]
  readonly members: Readonly<Record<string, readonly string[]>>
  readonly choices: Readonly<Record<string, string>>
  readonly outcome: 'flattened' | 'refused' | 'refused-at-load'
  readonly message?: string
  readonly inputs?: readonly (readonly [string, string, boolean, Json])[]
  readonly outputs?: readonly string[]
  readonly chose?: Readonly<Record<string, string>>
}

const bytes = readFileSync(FIXTURE)
const cases = (JSON.parse(bytes.toString('ascii')) as { cases: FlattenCase[] }).cases

/**
 * The document state that gives the case's run: values and wires as stored,
 * a group's member keys in the order the run names them (its member list
 * first, then keys found only in stored ids, the engine's discovery rule), and each choice's key.
 */
function documentOf(testCase: FlattenCase): {
  values: Record<string, Json>
  dynamic: Record<string, DynamicPortState>
  connectivity: Connectivity
} {
  const values: Record<string, Json> = {}
  const wired = new Set<string>()
  for (const [id, value] of testCase.stored) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { link?: unknown }).link === true) wired.add(id)
    else values[id] = value
  }
  const named = [...testCase.stored.map(([id]) => id), ...Object.keys(testCase.choices)]
  const dynamic: Record<string, { members?: string[]; selected?: string }> = {}
  const prefixes = new Set<string>()
  for (const id of [...named, ...Object.keys(testCase.members)]) {
    const parts = id.split('.')
    for (let end = 1; end <= parts.length; end++) prefixes.add(parts.slice(0, end).join('.'))
  }
  for (const path of prefixes) {
    const found = [...new Set(testCase.members[path] ?? [])]
    for (const id of named) {
      if (!id.startsWith(`${path}.`)) continue
      const key = id.slice(path.length + 1).split('.')[0]!
      if (key !== '' && !found.includes(key)) found.push(key)
    }
    if (found.length > 0) dynamic[path] = { members: found }
  }
  for (const [path, key] of Object.entries(testCase.choices)) dynamic[path] = { ...dynamic[path], selected: key }
  return {
    values,
    dynamic,
    connectivity: { isInputConnected: (port) => wired.has(port), isOutputConnected: () => false },
  }
}

describe('flattening cases shared with the engine', () => {
  it('is the case file both sides check', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FIXTURE_SHA256)
  })

  for (const testCase of cases) {
    it(testCase.id, () => {
      const parsed = parseDinksterSchema('cases.node', { schemaVersion: 2, nodeType: 'cases.node', body: testCase.body })
      if (testCase.outcome === 'refused-at-load') {
        expect(parsed.schema).toBeUndefined()
        expect(parsed.diagnostics.map((d) => d.message).join('\n')).toContain(testCase.message!)
        return
      }
      expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
      const { values, dynamic, connectivity } = documentOf(testCase)
      const elaborated = elaborateInterface(parsed.schema!, { values, dynamic }, connectivity, { promoteGhosts: false })
      const errors = elaborated.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)
      if (testCase.outcome === 'refused') {
        expect(errors.join('\n')).toContain(testCase.message!)
        return
      }
      expect(errors).toEqual([])
      const byId = <T extends readonly unknown[]>(a: T, b: T): number => String(a[0]).localeCompare(String(b[0]))
      const inputs = elabInputsOf(elaborated)
        .filter((input) => input.apiName !== undefined)
        .map((input) => [
          input.apiName!,
          canonicalTypeIdOf(input.spec.type) ?? null,
          !input.spec.optional,
          (input.spec.widget?.default ?? input.spec.ext?.['default'] ?? null) as Json,
        ] as const)
      expect([...inputs].sort(byId)).toEqual([...testCase.inputs!].sort(byId))
      const outputs = elabOutputsOf(elaborated).filter((output) => output.wireable !== false).map((output) => output.spec.id)
      expect([...outputs].sort()).toEqual([...testCase.outputs!].sort())
      expect(elaborated.choices ?? {}).toEqual(testCase.chose)
    })
  }
})

// A workflow loaded with an unresolved node feeding the executed output must
// refuse to queue with an explanation, not the bare compile diagnostics
// (issue #142): the Problems panel keeps saying WHY the run was refused, and
// the per-pass duplicate diagnostics for one node collapse to a single entry.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { DinksterNodesPayload } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState } from '../src/app-state.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const here = dirname(fileURLToPath(import.meta.url))
const nodesPayload = JSON.parse(
  readFileSync(join(here, '../../core/fixtures/dinkster-nodes-comfy.json'), 'utf8'),
) as DinksterNodesPayload
const workflowText = readFileSync(join(here, 'fixtures/unresolved-output-dependency.json'), 'utf8')

describe('queueing a loaded workflow whose output depends on an unresolved node', () => {
  it('refuses with one diagnostic per unresolved node explaining the refusal', async () => {
    const app = new AppState()
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, nodesPayload))
    const submit = vi.fn()
    ;(backend.connection as unknown as { submit: unknown }).submit = submit

    expect(await app.importWorkflowFile({
      name: 'unresolved-output-dependency.json',
      text: async () => workflowText,
    })).toBe(true)
    const tab = app.activeTab()!

    // Open-time behavior is unchanged: the unresolved type is reported once
    // with the exclusion explanation.
    const openTime = app.problems.get().filter((problem) => problem.code === 'schema.unresolvedType')
    expect(openTime).toHaveLength(1)
    expect(openTime[0]!.message).toContain("'comfy.Morphology'")
    expect(openTime[0]!.message).toContain('excluded from execution')

    await app.queue(tab)
    expect(submit).not.toHaveBeenCalled()

    const unknown = app.problems.get().filter((problem) => problem.code === 'compile.schema.unknown')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]!.severity).toBe('error')
    expect(unknown[0]!.message).toContain("node 'n1' of type 'comfy.Morphology'")
    expect(unknown[0]!.message).toContain('does not resolve on backend')
    expect(unknown[0]!.message).toContain('excluded from execution')
    expect(unknown[0]!.message).toContain('cannot be queued')
  })
})

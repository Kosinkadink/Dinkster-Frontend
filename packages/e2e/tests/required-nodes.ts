import { expect, type TestInfo } from '@playwright/test'
import { readFileSync } from 'node:fs'

const withdrawnDrafts = JSON.parse(
  readFileSync(new URL('./withdrawn-drafts.json', import.meta.url), 'utf8'),
) as {
  readonly nodes: readonly string[]
  readonly templates: Readonly<Record<string, readonly string[]>>
}

// Withdrawn nodes and templates remain recorded for per-item decisions:
// https://github.com/Kosinkadink/comfy-vibe-station/issues/661
const withdrawnDraftNodes: ReadonlySet<string> = new Set(withdrawnDrafts.nodes)
const withdrawnDraftTemplates: ReadonlySet<string> = new Set(
  Object.keys(withdrawnDrafts.templates),
)

export function requireBackendNodes(
  nodes: Readonly<Record<string, unknown>>,
  required: readonly string[],
  testInfo: TestInfo,
): void {
  const missing = required.filter((id) => !Object.hasOwn(nodes, id))
  const unexpected = missing.filter((id) => !withdrawnDraftNodes.has(id))
  expect(
    unexpected,
    `live catalog lacks required nodes: ${unexpected.join(', ')}`,
  ).toEqual([])
  testInfo.skip(
    missing.length > 0,
    `node withdrawn with the drafts, #661: ${missing.join(', ')}`,
  )
}

export function requireBackendTemplates(
  available: readonly string[],
  required: readonly string[],
  testInfo: TestInfo,
): void {
  const missing = required.filter((id) => !available.includes(id))
  const unexpected = missing.filter((id) => !withdrawnDraftTemplates.has(id))
  expect(
    unexpected,
    `live catalog lacks required templates: ${unexpected.join(', ')}`,
  ).toEqual([])
  testInfo.skip(
    missing.length > 0,
    `template withdrawn with the drafts, #661: ${missing
      .map(
        (id) =>
          `${id} (missing nodes: ${withdrawnDrafts.templates[id]?.join(', ') || 'none'})`,
      )
      .join('; ')}`,
  )
}

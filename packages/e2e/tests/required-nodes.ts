import { expect, type TestInfo } from '@playwright/test'

// Withdrawn nodes are preserved for per-node decisions, not backend aliases:
// https://github.com/Kosinkadink/comfy-vibe-station/issues/661
const withdrawnDraftNodes: ReadonlySet<string> = new Set([
  'dinkster.audio.envelope',
  'dinkster.curve.evaluate',
  'dinkster.int',
  'dinkster.layers.edit',
  'dinkster.layers.flatten',
  'dinkster.layers.load',
  'dinkster.mask.paint',
  'dinkster.route.gate',
  'dinkster.value.compare',
  'std.list.length',
  'std.math.add_ints',
  'std.string.concat',
  'std.string.split',
])

export function requireBackendNodes(
  nodes: Readonly<Record<string, unknown>>,
  required: readonly string[],
  testInfo: TestInfo,
): void {
  const missing = required.filter((id) => !Object.hasOwn(nodes, id))
  const unexpected = missing.filter((id) => !withdrawnDraftNodes.has(id))
  expect(unexpected, `live catalog lacks required nodes: ${unexpected.join(', ')}`).toEqual([])
  testInfo.skip(missing.length > 0, `node withdrawn with the drafts, #661: ${missing.join(', ')}`)
}

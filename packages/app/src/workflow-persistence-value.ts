import { canonicalJson, loadDocument, type WorkflowDocument } from '@dinkster/core'
import { blake3 } from '@noble/hashes/blake3.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export interface PreparedWorkflow {
  readonly path: readonly string[]
  readonly json: string
  readonly canonical: string
  readonly digest: string
  readonly document: WorkflowDocument | undefined
}

const workflows = new WeakMap<object, PreparedWorkflow>()
const parsedValues = new Map<string, unknown>()
let mergingValues: ReadonlyMap<string, unknown> | undefined

/** A merge must not evict an unread source from the small steady-state cache. */
export function withPersistenceSources(sources: ReadonlyMap<string, unknown>, merge: () => void): void {
  const previous = mergingValues
  mergingValues = sources
  try { merge() } finally { mergingValues = previous }
}

function rememberJson(json: string, value: unknown): void {
  parsedValues.delete(json)
  parsedValues.set(json, value)
  if (parsedValues.size > 16) parsedValues.delete(parsedValues.keys().next().value!)
}

export function cachedPersistenceJson(json: string): unknown {
  return mergingValues?.has(json) ? mergingValues.get(json) : parsedValues.get(json)
}

export function parsePersistenceJson(json: string): ReturnType<typeof JSON.parse> {
  if (mergingValues?.has(json)) return mergingValues.get(json)
  if (parsedValues.has(json)) return parsedValues.get(json)
  const value: unknown = JSON.parse(json)
  rememberJson(json, value)
  return value
}

/** Visit envelopes only; a workflow is a leaf, not a tree walked by the page. */
export function visitPersistedWorkflows(
  value: unknown,
  visit: (document: object, path: readonly string[]) => void,
  path: readonly string[] = [],
): void {
  if (value === null || typeof value !== 'object') return
  if ((value as { format?: unknown }).format === 'dinkster-workflow') {
    visit(value, path)
    return
  }
  for (const [key, child] of Object.entries(value)) visitPersistedWorkflows(child, visit, [...path, key])
}

/** Runs in the worker for browser autosaves, synchronously only without Workers. */
export function preparePersistenceValue(value: unknown): readonly PreparedWorkflow[] {
  const prepared: PreparedWorkflow[] = []
  visitPersistedWorkflows(value, (document, path) => {
    const canonical = canonicalJson(document)
    prepared.push({ path, json: JSON.stringify(document), canonical,
      digest: bytesToHex(blake3(new TextEncoder().encode(canonical))),
      document: loadDocument(document).document })
  })
  return prepared
}

export function acceptPersistenceValue(value: unknown, prepared: readonly PreparedWorkflow[], json?: string): void {
  for (const entry of prepared) {
    let document = value
    for (const key of entry.path) document = (document as Record<string, unknown>)[key]
    if (document !== null && typeof document === 'object') workflows.set(document, entry)
  }
  if (json !== undefined) rememberJson(json, value)
}

export function persistedWorkflowDocument(value: unknown): WorkflowDocument | undefined {
  return value !== null && typeof value === 'object' && workflows.has(value)
    ? workflows.get(value)!.document : loadDocument(value).document
}

export function persistedWorkflowDigest(value: unknown): string {
  const prepared = value !== null && typeof value === 'object' ? workflows.get(value) : undefined
  return prepared?.digest ?? bytesToHex(blake3(new TextEncoder().encode(canonicalJson(value))))
}

/** Join small recovery envelopes around the document bytes prepared off-thread. */
export function persistenceJson(value: unknown, canonical = false): string {
  const encode = (part: unknown): string => {
    if (part === null || typeof part !== 'object') return JSON.stringify(part) ?? 'null'
    const prepared = workflows.get(part)
    if (prepared) return canonical ? prepared.canonical : prepared.json
    if (Array.isArray(part)) return `[${part.map(encode).join(',')}]`
    const entries = Object.entries(part).filter(([, child]) => child !== undefined)
    if (canonical) entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`).join(',')}}`
  }
  const json = encode(value)
  if (!canonical) rememberJson(json, value)
  return json
}

export function persistenceValuePrepared(value: unknown): boolean {
  let prepared = true
  visitPersistedWorkflows(value, (document) => { if (!workflows.has(document)) prepared = false })
  return prepared
}

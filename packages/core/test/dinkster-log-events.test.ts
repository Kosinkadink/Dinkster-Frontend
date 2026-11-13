/**
 * node_event/log normalization: execution log records are info|warning only.
 * Errors are NOT a log level - they keep the single node_failed / job error
 * substrate - so a wire log claiming level "error" is malformed and dropped.
 */
import { describe, expect, it } from 'vitest'
import { asConnectionId, asPromptId } from '../src/ids.js'
import { DinksterNormalizer, type DinksterRawJson } from '../src/events/dinkster.js'
import type { NormalizedEvent } from '../src/events/contract.js'

const CONN = asConnectionId('conn-log')
const EXEC = { connection: CONN, prompt: asPromptId('job-log') }

function normalize(message: DinksterRawJson): {
  events: readonly NormalizedEvent[]
  malformed: string[]
} {
  const malformed: string[] = []
  const normalizer = new DinksterNormalizer(CONN, () => 42, (detail) => malformed.push(detail))
  return { events: normalizer.normalize(message), malformed }
}

const wireLog = (
  data: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
): DinksterRawJson => ({
  type: 'node_event',
  jobId: 'job-log',
  runId: 'run-log',
  event: 'log',
  seq: 1,
  ...envelope,
  data,
})

describe('node_event log normalization', () => {
  it('normalizes a node-attributed info record with full metadata', () => {
    const { events, malformed } = normalize(wireLog(
      {
        level: 'info',
        message: 'loading checkpoint',
        ts: 1755772800.25,
        origin: 'logging',
        logger: 'dinkster.engine',
      },
      { nodeId: 'sampler', seq: 7 },
    ))
    expect(malformed).toEqual([])
    expect(events).toEqual([{
      kind: 'log',
      execution: EXEC,
      timestamp: 42,
      runtimeNodeId: 'sampler',
      level: 'info',
      message: 'loading checkpoint',
      emittedAt: 1755772800250,
      origin: 'logging',
      logger: 'dinkster.engine',
      seq: 7,
    }])
  })

  it('normalizes a run-level warning without nodeId or optional metadata', () => {
    const { events, malformed } = normalize(wireLog({ level: 'warning', message: 'low vram' }))
    expect(malformed).toEqual([])
    expect(events).toEqual([{
      kind: 'log',
      execution: EXEC,
      timestamp: 42,
      level: 'warning',
      message: 'low vram',
      seq: 1,
    }])
  })

})

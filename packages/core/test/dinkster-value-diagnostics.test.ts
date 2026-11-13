import { describe, expect, it } from 'vitest'
import { asConnectionId } from '../src/ids.js'
import { DinksterNormalizer } from '../src/events/dinkster.js'

const CONN = asConnectionId('diagnostics-test')

describe('value_diagnostics normalization', () => {
  it('decodes the published alpha and mask payloads exactly', () => {
    const normalizer = new DinksterNormalizer(CONN, () => 42)
    expect(normalizer.normalize({
      type: 'value_diagnostics',
      runId: 'run-1',
      jobId: 'job-1',
      nodeId: 'composite',
      detail: {
        diagnostics: [
          {
            code: 'alpha_dropped',
            nodeId: 'composite',
            outputId: 'image',
            inputIds: ['foreground', 'mask'],
          },
          {
            code: 'mask_polarity_mismatch',
            nodeId: 'composite',
            inputId: 'mask',
            expected: 'coverage',
            actual: 'transparency',
          },
        ],
      },
    })).toEqual([{
      kind: 'valueDiagnostics',
      execution: { connection: CONN, prompt: 'job-1' },
      timestamp: 42,
      diagnostics: [
        {
          code: 'alpha_dropped',
          nodeId: 'composite',
          outputId: 'image',
          inputIds: ['foreground', 'mask'],
        },
        {
          code: 'mask_polarity_mismatch',
          nodeId: 'composite',
          inputId: 'mask',
          expected: 'coverage',
          actual: 'transparency',
        },
      ],
    }])
  })

  it('preserves the singular input identity on asset-coercion alpha loss', () => {
    const diagnostic = { code: 'alpha_dropped', nodeId: 'node', inputId: 'asset', outputId: 'image' }
    const events = new DinksterNormalizer(CONN, () => 1).normalize({
      type: 'value_diagnostics', jobId: 'coercion-job', nodeId: 'node',
      detail: { diagnostics: [diagnostic] },
    })
    expect(events).toEqual([{
      kind: 'valueDiagnostics', execution: { connection: CONN, prompt: 'coercion-job' },
      timestamp: 1, diagnostics: [diagnostic],
    }])
  })

  it('preserves nested runtime node identity without parsing or rewriting it', () => {
    const nodeId = 'outer[0]/inner[2]/composite'
    const events = new DinksterNormalizer(CONN, () => 1).normalize({
      type: 'value_diagnostics',
      jobId: 'nested-job',
      nodeId,
      detail: {
        diagnostics: [{ code: 'alpha_dropped', nodeId, outputId: 'image', inputIds: ['layer'] }],
      },
    })
    expect(events[0]).toMatchObject({
      kind: 'valueDiagnostics',
      diagnostics: [{ nodeId }],
    })
  })

})

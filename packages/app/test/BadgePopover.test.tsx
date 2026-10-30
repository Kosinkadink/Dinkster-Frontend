import { renderToString } from 'solid-js/web'
import { describe, expect, it } from 'vitest'
import { diag, type Diagnostic } from '@dinkster/core'
import { BadgePopover } from '../src/BadgePopover.js'

const runtimeDiagnostic = (hints?: NonNullable<Diagnostic['runtime']>['hints']): Diagnostic =>
  diag('error', 'runtime', 'runtime.RuntimeError', 'expected scalar type Half but found Float', {
    runtime: {
      exceptionType: 'RuntimeError',
      exceptionMessage: 'expected scalar type Half but found Float',
      traceback: ['raw traceback'],
      ...(hints !== undefined ? { hints } : {}),
    },
  })

const renderPopover = (diagnostic: Diagnostic): string => renderToString(() => (
  <BadgePopover
    anchor={{ x: 12, y: 34, nodeId: 'sampler', badge: { id: 'core.error', glyph: '!', color: '#f00' } }}
    errors={() => [diagnostic]}
    nodeLogs={() => []}
    problems={() => []}
    subgraphInfo={() => undefined}
    deprecationInfo={() => undefined}
    onOpenSubgraph={() => {}}
    onClose={() => {}}
  />
))

describe('BadgePopover runtime error hints', () => {
  it('places runtime hints between the error summary and raw traceback', () => {
    const html = renderPopover(runtimeDiagnostic([
      {
        code: 'dtype-mismatch',
        message: 'Input dtype Float does not match required dtype Half.',
      },
    ]))

    expect(html).toContain('Input dtype Float does not match required dtype Half.')
    expect(html).toMatch(/expected scalar type Half[\s\S]+Diagnostic code: dtype-mismatch[\s\S]+raw traceback/)
  })

  it('renders the raw error and traceback without an empty hint block', () => {
    const html = renderPopover(runtimeDiagnostic())
    expect(html).toContain('RuntimeError:')
    expect(html).toContain('expected scalar type Half but found Float')
    expect(html).toContain('raw traceback')
    expect(html).not.toContain('runtime-error-hint')
  })
})

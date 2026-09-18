import { renderToString } from 'solid-js/web'
import { describe, expect, it } from 'vitest'
import { diag, type Diagnostic } from '@dinkster/core'
import { BadgePopover } from '../src/BadgePopover.js'

const withoutSsrHydration = (html: string): string =>
  html.replace(/ data-hk="[^"]*"/g, '').replace(/<!--(?:!?\$|\/)-->/g, '')

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
    replacementInfo={() => undefined}
    onOpenSubgraph={() => {}}
    onApplyReplacement={() => {}}
    onClose={() => {}}
  />
))

describe('BadgePopover runtime error hints', () => {
  it('renders multiple hints with and without suggestions before the raw traceback', () => {
    const html = renderPopover(runtimeDiagnostic([
      {
        code: 'dtype-mismatch',
        message: 'Input dtype Float does not match required dtype Half.',
      },
      {
        code: 'cuda-oom',
        message: 'CUDA ran out of memory.',
        suggestion: 'Reduce the batch size.',
      },
    ]))

    expect(html.match(/class="runtime-error-hint"/g)).toHaveLength(2)
    expect(html.match(/class="runtime-error-hint-suggestion"/g)).toHaveLength(1)
    expect(html).toContain('data-tooltip-label="Diagnostic code: dtype-mismatch"')
    expect(html).not.toContain('title="Diagnostic code: dtype-mismatch"')
    expect(html).toContain('Input dtype Float does not match required dtype Half.')
    expect(html).toContain('data-tooltip-label="Diagnostic code: cuda-oom"')
    expect(html).not.toContain('title="Diagnostic code: cuda-oom"')
    expect(html).toContain('Reduce the batch size.')
    expect(html.indexOf('expected scalar type Half')).toBeLessThan(html.indexOf('Diagnostic code: dtype-mismatch'))
    expect(html.indexOf('Diagnostic code: cuda-oom')).toBeLessThan(html.indexOf('raw traceback'))
  })

  it('keeps the no-hints runtime detail markup unchanged', () => {
    expect(withoutSsrHydration(renderPopover(runtimeDiagnostic()))).toBe('<div class="badge-popover" data-testid="badge-popover" data-badge="core.error" tabindex="-1" style="left:12px;top:34px"><div class="badge-popover-title">Execution errors: sampler</div><div class="badge-error" data-testid="badge-error-detail"><div class="badge-error-head">RuntimeError: expected scalar type Half but found Float</div><pre class="traceback">raw traceback</pre></div></div>')
  })
})

/**
 * widgetCommitError (WidgetEditor.tsx): the shared commit gate for widget
 * value writes. What must hold:
 * a value failing the kind's SHAPE schema is BLOCKED, never silently passed
 * through to schema-blind node.setValue; shape-valid values then face the
 * kind's semantic validate; kindless specs commit unchecked (raw JSON is
 * the documented escape hatch for unknown widget types).
 */

import { describe, expect, it } from 'vitest'
import type { Json, WidgetKind, WidgetSpec } from '@dinkster/core'
import { colorKind, intKind } from '@dinkster/widgets'
import { parseNumericCommit, resolveTextCommit, widgetCommitError } from '../src/widget-commit.js'

const spec = (widgetType: string, options: Record<string, unknown> = {}): WidgetSpec => ({ widgetType, options })

describe('resolveTextCommit', () => {
  it('returns none when the editor did not change the open value', () => {
    expect(resolveTextCommit('abc', 'abc', 'abc')).toEqual({ kind: 'none' })
    expect(resolveTextCommit('abc', 'abc', 'remote abc')).toEqual({ kind: 'none' })
  })

  it('returns the local splice when the stored value did not change', () => {
    expect(resolveTextCommit('abc', 'axc', 'abc')).toEqual({
      kind: 'splice',
      splice: { offset: 1, deleteCount: 1, insert: 'x' },
    })
  })

  it('moves a local splice past a non-overlapping remote edit', () => {
    expect(resolveTextCommit('hello world', 'hello brave world', 'remote hello world')).toEqual({
      kind: 'splice',
      splice: { offset: 13, deleteCount: 0, insert: 'brave ' },
    })
  })

  it('uses text.splice overlap semantics', () => {
    expect(resolveTextCommit('abcdef', 'abXYef', 'abcZZef')).toEqual({
      kind: 'splice',
      splice: { offset: 2, deleteCount: 3, insert: 'XY' },
    })
  })

  it('falls back when either merge input is not a string', () => {
    expect(resolveTextCommit(null, 'edited', 'stored')).toEqual({ kind: 'setValue' })
    expect(resolveTextCommit('opened', 'edited', null)).toEqual({ kind: 'setValue' })
  })

  it('keeps a local edit after a remote whole-text replacement', () => {
    expect(resolveTextCommit('abc', 'abX', 'remote')).toEqual({
      kind: 'splice',
      splice: { offset: 6, deleteCount: 0, insert: 'X' },
    })
  })

  it('returns none when the remote edit already consumed the local deletion', () => {
    expect(resolveTextCommit('abc', 'ac', 'ac')).toEqual({ kind: 'none' })
  })
})

describe('widgetCommitError', () => {
  it('parses safe and unsafe integer text without precision loss', () => {
    expect(parseNumericCommit('42', 'INT')).toEqual({ ok: true, value: 42 })
    expect(parseNumericCommit('18446744073709551615', 'INT')).toEqual({ ok: true, value: '18446744073709551615' })
    expect(parseNumericCommit('-9223372036854775808', 'INT')).toEqual({ ok: true, value: '-9223372036854775808' })
    expect(parseNumericCommit('18446744073709551616', 'INT')).toEqual({
      ok: false,
      error: 'Enter an exact integer from -9223372036854775808 to 18446744073709551615.',
    })
    for (const raw of ['01', '-0', '1e3', '1.5']) {
      expect(parseNumericCommit(raw, 'INT')).toEqual({
        ok: false,
        error: 'Enter an exact integer from -9223372036854775808 to 18446744073709551615.',
      })
    }
  })

  it('quantizes FLOAT commits by round metadata without treating step as round', () => {
    expect(parseNumericCommit('1.2346', 'FLOAT', 0.001)).toEqual({ ok: true, value: 1.235 })
    expect(parseNumericCommit('1.24', 'FLOAT', 0.25)).toEqual({ ok: true, value: 1.25 })
    expect(parseNumericCommit('123456789012345.6', 'FLOAT', 0.1)).toEqual({ ok: true, value: 123456789012345.6 })
    expect(parseNumericCommit('1.23456789e-20', 'FLOAT', 1e-22)).toEqual({ ok: true, value: 1.23e-20 })
    expect(parseNumericCommit(String(Number.MAX_VALUE), 'FLOAT', Number.MIN_VALUE)).toEqual({ ok: true, value: Number.MAX_VALUE })
    expect(parseNumericCommit('1.2346', 'FLOAT')).toEqual({ ok: true, value: 1.2346 })
  })

  it('blocks shape-invalid values instead of letting them fall through to node.setValue', () => {
    expect(widgetCommitError(intKind as WidgetKind, 'not a number', spec('INT'))).toBe('Not a valid INT value.')
    expect(widgetCommitError(intKind as WidgetKind, null, spec('INT'))).toBe('Not a valid INT value.')
  })

  it('accepts exact unsafe INT values and checks their declared decimal range', () => {
    const uint64 = spec('INT', { min: 0, max: '18446744073709551615' })
    expect(widgetCommitError(intKind as WidgetKind, '18446744073709551615', uint64)).toBeUndefined()
    expect(intKind.validate('18446744073709551615', uint64)).toEqual([])
    expect(intKind.validate('-9223372036854775808', uint64).map((diagnostic) => diagnostic.code)).toEqual(['widget.INT.belowMin'])
  })

  it('passes shape-valid values to the kind semantic validate and surfaces only error-grade diagnostics', () => {
    // intKind range diagnostics are warnings: they surface elsewhere, never block.
    expect(widgetCommitError(intKind as WidgetKind, 500, spec('INT', { max: 100 }))).toBeUndefined()
    expect(widgetCommitError(intKind as WidgetKind, 7, spec('INT'))).toBeUndefined()
    const strict: WidgetKind = {
      type: 'TEST',
      valueSchema: { version: 1, validate: (v: unknown): v is Json => typeof v === 'number' },
      defaultValue: () => 0,
      validate: (v) => ((v as number) > 100 ? [{ severity: 'error', origin: 'schema', code: 'test.tooBig', message: 'too big' }] : []),
      defaultView: () => 'core.number',
    }
    expect(widgetCommitError(strict, 500, spec('TEST'))).toBe('too big')
    expect(widgetCommitError(strict, 7, spec('TEST'))).toBeUndefined()
  })

  it('commits unchecked when no kind is registered (raw JSON escape hatch)', () => {
    expect(widgetCommitError(undefined, { anything: true }, spec('MYSTERY'))).toBeUndefined()
  })

  it('passes every COLOR string exactly and still rejects non-string shapes', () => {
    expect(widgetCommitError(colorKind as WidgetKind, '#336699', spec('COLOR'))).toBeUndefined()
    expect(widgetCommitError(colorKind as WidgetKind, 'Not-A-Normalized-Color', spec('COLOR'))).toBeUndefined()
    expect(widgetCommitError(colorKind as WidgetKind, 0xff00ff, spec('COLOR'))).toBe('Not a valid COLOR value.')
  })
})

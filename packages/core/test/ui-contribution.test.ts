import { describe, expect, it } from 'vitest'
import {
  HOST_UI_MAX_CHILDREN,
  HOST_UI_MAX_DEPTH,
  HOST_UI_MAX_ID_LENGTH,
  HOST_UI_MAX_NODES,
  HOST_UI_MAX_PAYLOAD_JSON_BYTES,
  HOST_UI_MAX_VISIBLE_STRING_LENGTH,
  createHostUiProviderContextV1,
  decodeHostUiContributionV1,
  type HostUiProviderV1,
} from '../src/index.js'

const contribution = (root: unknown): unknown => ({ version: 1, root })
const text = (key = 'text'): unknown => ({ kind: 'text', key, text: 'hello' })
const codes = (value: unknown): string[] => decodeHostUiContributionV1(value).diagnostics.map((item) => item.message)

describe('HostUiContributionV1 decoding', () => {
  it('accepts every node kind and returns a recursively frozen host-owned copy', () => {
    const input = contribution({ kind: 'group', key: 'root', direction: 'row', children: [
      { kind: 'text', key: 'text', text: 'Text', tone: 'neutral' },
      { kind: 'status', key: 'status', text: 'Ready', tone: 'success', live: 'polite' },
      { kind: 'action', key: 'action', label: 'Run', command: 'demo.run', payload: { count: 2 }, tone: 'accent', disabled: false, disabledReason: 'Not now' },
    ] }) as { root: { children: Array<{ text?: string }> } }
    const decoded = decodeHostUiContributionV1(input)
    expect(decoded.diagnostics).toEqual([])
    expect(decoded.contribution).toEqual(input)
    expect(decoded.contribution).not.toBe(input)
    expect(Object.isFrozen(decoded.contribution)).toBe(true)
    expect(Object.isFrozen(decoded.contribution!.root)).toBe(true)
    expect(Object.isFrozen((decoded.contribution!.root as { children: readonly unknown[] }).children)).toBe(true)
    input.root.children[0]!.text = 'changed'
    expect((decoded.contribution!.root as { children: readonly { text?: string }[] }).children[0]!.text).toBe('Text')
  })

  it.each([
    ['function', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: { bad: () => {} } })],
    ['symbol', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: Symbol('bad') })],
    ['symbol key', () => {
      const node = { kind: 'text', key: 'a', text: 'A', [Symbol('bad')]: true }
      return contribution(node)
    }],
    ['bigint', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: 1n })],
    ['undefined', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: undefined })],
    ['date', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: new Date() })],
    ['class instance', () => contribution(new (class Node { kind = 'text'; key = 'a'; text = 'A' })())],
    ['NaN', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: Number.NaN })],
    ['infinity', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: Infinity })],
  ])('rejects forbidden %s values', (_name, make) => {
    expect(decodeHostUiContributionV1(make()).contribution).toBeUndefined()
  })

  it('rejects unknown keys, duplicate node keys, and malformed commands with paths', () => {
    expect(codes({ version: 1, extra: true, root: text() }).join('\n')).toContain('$["extra"]')
    expect(codes(contribution({ kind: 'group', key: 'root', direction: 'row', children: [text('same'), text('same')] })).join('\n')).toContain('$.root.children[1].key')
    expect(codes(contribution({ kind: 'action', key: 'a', label: 'A', command: 'not-dotted' })).join('\n')).toContain('$.root.command')
  })

  it('rejects cycles and shared aliases', () => {
    const cyclic: Record<string, unknown> = { kind: 'group', key: 'root', direction: 'row', children: [] }
    ;(cyclic.children as unknown[]).push(cyclic)
    expect(codes(contribution(cyclic)).join('\n')).toContain('cycle or shared')
    const shared = text('shared')
    expect(codes(contribution({ kind: 'group', key: 'root', direction: 'row', children: [shared, shared] })).join('\n')).toContain('cycle or shared')
  })

  it('enforces every exported limit', () => {
    expect(codes(contribution({ kind: 'group', key: 'root', direction: 'row', children: Array.from({ length: HOST_UI_MAX_CHILDREN + 1 }, (_, index) => text(`n-${index}`)) })).join('\n')).toContain('child limit')
    let deep: unknown = text('leaf')
    for (let index = 0; index < HOST_UI_MAX_DEPTH; index += 1) deep = { kind: 'group', key: `g-${index}`, direction: 'column', children: [deep] }
    expect(codes(contribution(deep)).join('\n')).toContain('depth limit')
    const branches = Array.from({ length: 5 }, (_, branch) => ({ kind: 'group', key: `branch-${branch}`, direction: 'row', children: Array.from({ length: 32 }, (_, index) => text(`n-${branch}-${index}`)) }))
    expect(codes(contribution({ kind: 'group', key: 'root', direction: 'row', children: branches })).join('\n')).toContain(`${HOST_UI_MAX_NODES} node`)
    expect(codes(contribution({ kind: 'text', key: 'a', text: 'x'.repeat(HOST_UI_MAX_VISIBLE_STRING_LENGTH + 1) })).join('\n')).toContain('character limit')
    expect(codes(contribution({ kind: 'text', key: 'x'.repeat(HOST_UI_MAX_ID_LENGTH + 1), text: 'x' })).join('\n')).toContain('character limit')
    expect(codes(contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: 'x'.repeat(HOST_UI_MAX_PAYLOAD_JSON_BYTES) })).join('\n')).toContain('byte JSON limit')
    expect(codes(contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: Array.from({ length: HOST_UI_MAX_NODES }, () => null) })).join('\n')).toContain('value limit')
  })

})

describe('HostUiProviderContextV1', () => {
  it('clones and recursively freezes JSON before provider invocation', () => {
    const data = { nested: { value: 'host' } }
    const context = createHostUiProviderContextV1('status', data)
    const provider: HostUiProviderV1 = (received) => {
      expect(Object.isFrozen(received)).toBe(true)
      expect(Object.isFrozen(received.data)).toBe(true)
      expect(() => { (received.data as { nested: { value: string } }).nested.value = 'extension' }).toThrow()
      return contribution(text())
    }
    provider(context)
    data.nested.value = 'changed'
    expect((context.data as { nested: { value: string } }).nested.value).toBe('host')
  })

})

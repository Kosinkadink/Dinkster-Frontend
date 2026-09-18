import { coreCommandRegistry } from '@dinkster/core'
import { describe, expect, it } from 'vitest'
import { commandCatalog } from '../src/catalog.js'

describe('command catalog', () => {
  it('documents every registered workflow command exactly once', () => {
    const registry = coreCommandRegistry()
    expect(commandCatalog.map(({ id }) => id).sort()).toEqual([...registry.keys()].sort())
    expect(commandCatalog.every(({ documentKind }) => documentKind === 'dinkster.workflow')).toBe(true)
  })
})

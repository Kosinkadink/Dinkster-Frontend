import { describe, expect, it } from 'vitest'
import type { AppCommand, SettingDefinition } from '../src/settings.js'
import { buildSettingsSearchIndex, querySettingsIndex } from '../src/settings-search.js'

const definitions: readonly SettingDefinition[] = [
  { id: 'canvas.grid.visible', name: 'Show grid', category: 'canvas', type: 'boolean', defaultValue: true },
  { id: 'shell.gridGuide', name: 'Grid guide', category: 'shell', type: 'boolean', defaultValue: false },
  { id: 'editor.guides', name: 'Editor guides', category: 'editor', description: 'Show a grid while aligning nodes', type: 'boolean', defaultValue: true },
]
const commands: readonly AppCommand[] = [
  { id: 'workflow.open', label: 'Open workflow library', run: () => {} },
]
const index = buildSettingsSearchIndex(definitions, (definition) => definition.category!, commands)

describe('settings search index', () => {
  it('returns cross-category groups ordered by their best match', () => {
    const groups = querySettingsIndex(index, 'grid')
    expect(groups.map((group) => group.category)).toEqual(['shell', 'canvas', 'editor'])
    expect(groups.flatMap((group) => group.matches.map((match) => match.id))).toEqual([
      'shell.gridGuide',
      'canvas.grid.visible',
      'editor.guides',
    ])
  })

  it('ranks exact names above id and description matches within a group', () => {
    const sameCategoryIndex = buildSettingsSearchIndex([
      { id: 'canvas.grid', name: 'Grid', category: 'canvas', type: 'boolean', defaultValue: true },
      { id: 'canvas.grid.visible', name: 'Visibility', category: 'canvas', type: 'boolean', defaultValue: true },
      { id: 'canvas.guides', name: 'Guides', category: 'canvas', description: 'Align to grid', type: 'boolean', defaultValue: true },
    ], (definition) => definition.category!)
    const ranked = querySettingsIndex(sameCategoryIndex, 'grid')[0]!.matches
    expect(ranked.map((match) => match.id)).toEqual(['canvas.grid', 'canvas.grid.visible', 'canvas.guides'])
    expect(ranked.map((match) => match.score)).toEqual([...ranked.map((match) => match.score)].sort((a, b) => b - a))
  })

  it('indexes keybindings by command name and id with an open action', () => {
    expect(querySettingsIndex(index, 'workflow.open')).toMatchObject([{
      category: 'keybindings',
      matches: [{
        id: 'workflow.open',
        source: 'keybinding',
        action: { kind: 'open-settings', category: 'keybindings', id: 'workflow.open' },
      }],
    }])
    expect(querySettingsIndex(index, 'library')[0]?.matches[0]?.name).toBe('Open workflow library')
  })

  it('preserves index and category order for an empty query', () => {
    expect(querySettingsIndex(index, '  ').map((group) => ({
      category: group.category,
      ids: group.matches.map((match) => match.id),
    }))).toEqual([
      { category: 'canvas', ids: ['canvas.grid.visible'] },
      { category: 'shell', ids: ['shell.gridGuide'] },
      { category: 'editor', ids: ['editor.guides'] },
      { category: 'keybindings', ids: ['workflow.open'] },
    ])
  })
})

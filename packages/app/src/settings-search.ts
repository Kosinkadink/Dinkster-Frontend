import { scoreMatch, type SearchField } from '@dinkster/core'
import type { AppCommand, SettingDefinition } from './settings.js'

export interface SettingsSearchAction {
  readonly kind: 'open-settings'
  readonly category: string
  readonly id: string
}

interface SettingsSearchBase {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly keywords: readonly string[]
  readonly action: SettingsSearchAction
}

export type SettingsSearchItem = SettingsSearchBase & (
  | { readonly source: 'setting'; readonly definition: SettingDefinition; readonly command?: never }
  | { readonly source: 'keybinding'; readonly command: AppCommand; readonly definition?: never }
)

export type SettingsSearchMatch = SettingsSearchItem & { readonly score: number }

export interface SettingsSearchGroup {
  readonly category: string
  readonly matches: readonly SettingsSearchMatch[]
}

const INTERNAL_SETTING_IDS = new Set(['keybindings.overrides', 'search.recentActivations'])

/** Settings represented by user-facing rows in SettingsDialog and search. */
export function searchableSettingsDefinitions(definitions: readonly SettingDefinition[]): readonly SettingDefinition[] {
  return definitions.filter((definition) => !INTERNAL_SETTING_IDS.has(definition.id))
}

/**
 * Build the settings corpus once, independently of any rendering surface.
 * The serializable action is suitable for SettingsDialog and search providers.
 */
export function buildSettingsSearchIndex(
  definitions: readonly SettingDefinition[],
  categoryOf: (definition: SettingDefinition) => string,
  commands: readonly AppCommand[] = [],
): readonly SettingsSearchItem[] {
  return [
    ...definitions.map((definition): SettingsSearchItem => {
      const category = categoryOf(definition)
      return {
        id: definition.id,
        name: definition.name,
        category,
        keywords: definition.description === undefined ? [] : [definition.description],
        action: { kind: 'open-settings', category, id: definition.id },
        source: 'setting',
        definition,
      }
    }),
    ...commands.map((command): SettingsSearchItem => ({
      id: command.id,
      name: command.label,
      category: 'keybindings',
      keywords: ['keybinding', 'keyboard shortcut'],
      action: { kind: 'open-settings', category: 'keybindings', id: command.id },
      source: 'keybinding',
      command,
    })),
  ]
}

function fields(item: SettingsSearchItem): readonly SearchField[] {
  return [
    { text: item.name, weight: 3 },
    { text: item.id, weight: 2 },
    ...item.keywords.map((text) => ({ text, weight: 1 })),
    { text: item.category, weight: 0.5 },
  ]
}

/** Rank globally, then group by category in best-match order. */
export function querySettingsIndex(
  index: readonly SettingsSearchItem[],
  query: string,
): readonly SettingsSearchGroup[] {
  const ranked: SettingsSearchMatch[] = []
  for (const item of index) {
    const score = scoreMatch(query, fields(item))
    if (score !== undefined) ranked.push({ ...item, score })
  }
  ranked.sort((a, b) => b.score - a.score)

  const groups = new Map<string, SettingsSearchMatch[]>()
  for (const match of ranked) groups.set(match.category, [...(groups.get(match.category) ?? []), match])
  return [...groups].map(([category, matches]) => ({ category, matches }))
}

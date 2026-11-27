import { t } from '@dinkster/core'
import type { SettingsRegistry } from './settings.js'

export const automaticFixKinds = [
  { id: 'unresolvedAutomatic', setting: 'automaticFixes.unresolvedAutomatic', wire: false },
  { id: 'listGrows', setting: 'automaticFixes.listGrows', wire: false },
  { id: 'listShrinks', setting: 'automaticFixes.listShrinks', wire: false },
  { id: 'listShrinksWithWires', setting: 'automaticFixes.listShrinksWithWires', wire: true },
  { id: 'boundaryFieldRemoved', setting: 'automaticFixes.boundaryFieldRemoved', wire: false },
  { id: 'subgraphRowRemoved', setting: 'automaticFixes.subgraphRowRemoved', wire: true },
  { id: 'numberOutsideLimits', setting: 'automaticFixes.numberOutsideLimits', wire: false },
  { id: 'switchBranchRemoved', setting: 'automaticFixes.switchBranchRemoved', wire: false },
  { id: 'itemOutsideList', setting: 'automaticFixes.itemOutsideList', wire: false },
  { id: 'nodeReplacement', setting: 'execution.reviewUpgrades', wire: false },
] as const

export type AutomaticFixKind = typeof automaticFixKinds[number]
export type AutomaticFixPreference = 'apply' | 'ask' | 'apply-remove-wire' | 'ask-remove-wire'

export function automaticFixPreference(settings: SettingsRegistry, kind: AutomaticFixKind): AutomaticFixPreference {
  return kind.id === 'nodeReplacement'
    ? settings.get<boolean>(kind.setting) ? 'ask' : 'apply'
    : settings.get<AutomaticFixPreference>(kind.setting)
}

export function setAutomaticFixPreference(settings: SettingsRegistry, kind: AutomaticFixKind, value: AutomaticFixPreference): void {
  settings.set(kind.setting, kind.id === 'nodeReplacement' ? value === 'ask' : value)
}

/** Personal overrides only; unattended changes use the built-in Apply policy. */
export function registerAutomaticFixSettings(settings: SettingsRegistry): void {
  for (const kind of automaticFixKinds) settings.register({
    id: kind.setting,
    category: 'automaticFixes',
    get name() { return t(`automaticFixes.kind.${kind.id}`) },
    get description() {
      return t(automaticFixPreference(settings, kind) === 'apply' ? 'automaticFixes.builtIn' : 'automaticFixes.personal')
    },
    type: kind.id === 'nodeReplacement' ? 'boolean' : 'combo',
    defaultValue: kind.id === 'nodeReplacement' ? false : 'apply',
    get options() {
      return [
        { value: 'apply', label: t('automaticFixes.apply') },
        { value: 'ask', label: t('automaticFixes.ask') },
        ...(kind.wire ? [
          { value: 'apply-remove-wire', label: `${t('automaticFixes.apply')}, ${t('automaticFixes.removeWire')}` },
          { value: 'ask-remove-wire', label: `${t('automaticFixes.ask')}, ${t('automaticFixes.removeWire')}` },
        ] : []),
      ]
    },
  })
}

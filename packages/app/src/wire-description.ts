import type { SceneLink } from '@dinkster/canvas'
import { typeExprFromTypeId, typeProblemWords } from '@dinkster/core'

/** Count facts describe a value without changing its matching type. */
export function wireDescription(wire: Pick<SceneLink, 'typeName' | 'fromType' | 'listCount' | 'listCountFact'>): string {
  const type = wire.typeName === undefined ? wire.fromType ?? { kind: 'wildcard' as const } : typeExprFromTypeId(wire.typeName)
  const resolved = type.kind === 'concrete' ? typeExprFromTypeId(type.name) : type
  if (resolved.kind !== 'list') return typeProblemWords(resolved, 'name')
  const fact = wire.listCountFact ?? (wire.listCount === undefined ? undefined : { kind: 'known' as const, count: wire.listCount })
  if (fact === undefined) return `${typeProblemWords(resolved, 'name')}, count unknown`
  const description = `list of ${fact.count} ${typeProblemWords(resolved.element, fact.count === 1 ? 'name' : 'plural')}`
  if (fact.kind === 'known') return description
  const sources = fact.sources.map(source => source === 'asset' ? 'asset facts' : 'last run').join(' and ')
  return `${description} (estimate from ${sources})`
}

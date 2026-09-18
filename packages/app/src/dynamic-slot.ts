import { typesCompatible, type TypeExpr } from '@dinkster/core'

export interface SlotVariant {
  readonly key: string
  readonly type: TypeExpr
}

/**
 * Pick only from a stable solved atom. This deliberately abstains rather than
 * guessing because the persisted choice must reproduce the user's gesture.
 */
export function autoSpecialization(
  producerType: TypeExpr,
  variants: readonly SlotVariant[],
  currentSelected: string | undefined,
): string | undefined {
  if (currentSelected !== undefined || producerType.kind !== 'concrete') return undefined
  const matches = variants.filter((variant) => typesCompatible(producerType, variant.type))
  return matches.length === 1 ? matches[0]!.key : undefined
}

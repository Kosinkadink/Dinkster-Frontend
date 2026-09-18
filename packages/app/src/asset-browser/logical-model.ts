import type { AssetRef } from '@dinkster/core'

export type LogicalModelSourceKind =
  | 'builtin-catalog'
  | 'local-scan'
  | 'resolver'
  | 'template-metadata'
  | 'provider'

export interface LogicalModelDescription {
  readonly logicalId: string
  readonly displayName: string
  readonly kind: string
  readonly aliases: readonly string[]
}

export interface SourceRef {
  readonly sourceId: string
  readonly sourceKind: LogicalModelSourceKind
  readonly label: string
}

export interface VariantDescription {
  readonly variantId: string
  readonly logicalId: string
  readonly dtype?: string
  readonly precision?: string
  readonly quantization?: string
  readonly format?: string
  readonly size?: number
  readonly digest?: string
  readonly providers: readonly SourceRef[]
  readonly availability: 'installed' | 'downloadable' | 'unavailable' | 'resolving'
  readonly compatibility: {
    readonly status: 'compatible' | 'incompatible' | 'unknown'
    readonly reason?: string
  }
  readonly localRef?: AssetRef
}

export interface IngestedLogicalModelDescription extends LogicalModelDescription {
  readonly variants: readonly VariantDescription[]
}

export interface LogicalModelAdapter {
  readonly source: SourceRef
  readonly descriptions: readonly unknown[]
}

export interface VariantConflict {
  readonly code: 'basename-digest-conflict'
  readonly basename: string
  readonly otherVariantId: string
}

export interface LogicalModelVariant extends VariantDescription {
  readonly conflicts: readonly VariantConflict[]
}

export interface LogicalModel extends LogicalModelDescription {
  readonly variants: readonly LogicalModelVariant[]
}

export interface LogicalModelDiagnostic {
  readonly code: string
  readonly sourceId: string
  readonly logicalId?: string
  readonly variantId?: string
  readonly message: string
}

export interface LogicalModelIngestionResult {
  readonly models: readonly LogicalModel[]
  readonly diagnostics: readonly LogicalModelDiagnostic[]
}

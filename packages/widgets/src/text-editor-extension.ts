import type { WidgetSpec } from '@dinkster/core'

export interface TextWidgetEditorContext {
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
  readonly nodeType: string
  readonly spec: WidgetSpec
  /** Current materialized member names, grouped by schema input-family id. */
  readonly inputFamilyMembers?: Readonly<Record<string, readonly string[]>>
}

export interface TextCompletionRequest extends TextWidgetEditorContext {
  readonly text: string
  readonly caret: number
  readonly trigger: string
  readonly signal: AbortSignal
}

export interface TextCompletion {
  readonly id: string
  readonly label: string
  readonly replacement: {
    readonly start: number
    readonly end: number
    readonly text: string
  }
  readonly detail?: string
}

export interface TextWidgetEditorExtension {
  readonly id: string
  supports(context: TextWidgetEditorContext): boolean
  complete(request: TextCompletionRequest): readonly TextCompletion[] | Promise<readonly TextCompletion[]>
}

export class TextWidgetEditorExtensionRegistry {
  private readonly extensions = new Map<string, TextWidgetEditorExtension>()

  register(extension: TextWidgetEditorExtension): () => void {
    if (this.extensions.has(extension.id)) {
      throw new Error(`text editor extension '${extension.id}' already registered`)
    }
    this.extensions.set(extension.id, extension)
    return () => {
      if (this.extensions.get(extension.id) === extension) this.extensions.delete(extension.id)
    }
  }

  providersFor(context: TextWidgetEditorContext): readonly TextWidgetEditorExtension[] {
    const supported: TextWidgetEditorExtension[] = []
    for (const extension of this.extensions.values()) {
      try {
        if (extension.supports(context)) supported.push(extension)
      } catch (error) {
        console.error(`text editor extension '${extension.id}' supports check failed`, error)
      }
    }
    return supported
  }
}

export function createTextWidgetEditorExtensionRegistry(): TextWidgetEditorExtensionRegistry {
  return new TextWidgetEditorExtensionRegistry()
}

const completionTokenRange = (
  text: string,
  caret: number,
  kind: 'identifier' | 'operator',
): { readonly start: number; readonly end: number; readonly query: string } => {
  const at = Math.max(0, Math.min(caret, text.length))
  const matches = kind === 'identifier'
    ? (character: string): boolean => /[A-Za-z0-9_]/.test(character)
    : (character: string): boolean => /[+\-*/%<>=!&|^~]/.test(character)
  let start = at
  let end = at
  while (start > 0 && matches(text[start - 1]!)) start -= 1
  while (end < text.length && matches(text[end]!)) end += 1
  return { start, end, query: text.slice(start, at).normalize('NFKC').toLowerCase() }
}

const completionTokenKindAt = (
  text: string,
  caret: number,
): 'identifier' | 'operator' | undefined => {
  const at = Math.max(0, Math.min(caret, text.length))
  const adjacent = [text[at - 1], text[at]]
  if (adjacent.some((character) => character !== undefined && /[A-Za-z0-9_]/.test(character))) {
    return 'identifier'
  }
  if (adjacent.some((character) => character !== undefined && /[+\-*/%<>=!&|^~]/.test(character))) {
    return 'operator'
  }
  return undefined
}

/** Generic runtime adapter for schema wire-36 text completion declarations. */
export class SchemaTextCompletionProvider implements TextWidgetEditorExtension {
  readonly id = 'core.schema-text-completions'

  supports(context: TextWidgetEditorContext): boolean {
    return context.spec.widgetType === 'STRING' && context.spec.textCompletions !== undefined
  }

  complete(request: TextCompletionRequest): readonly TextCompletion[] {
    const declared = request.spec.textCompletions
    if (declared === undefined || request.signal.aborted) return []
    const tokenKind = completionTokenKindAt(request.text, request.caret)
    const familyItems = declared.inputFamilies.flatMap((family) =>
      (request.inputFamilyMembers?.[family] ?? []).map((value) => ({
        value,
        label: value,
        insertText: value,
        detail: 'Input',
        kind: 'identifier' as const,
      })),
    )
    return [...declared.items, ...familyItems].flatMap((item, index) => {
      if (tokenKind !== undefined && item.kind !== tokenKind) return []
      const range = completionTokenRange(request.text, request.caret, item.kind)
      if (!item.value.normalize('NFKC').toLowerCase().startsWith(range.query)) return []
      return [{
        id: `schema:${item.kind}:${item.value}:${index}`,
        label: item.label,
        replacement: { start: range.start, end: range.end, text: item.insertText },
        ...(item.detail === '' ? {} : { detail: item.detail }),
      }]
    })
  }
}

export interface EmbeddingAndLoraCatalog {
  readonly embeddings: readonly string[]
  readonly loras: readonly string[]
}

interface EmbeddingAndLoraMatch {
  readonly route: EmbeddingAndLoraChoiceRoute
  readonly query: string
  readonly start: number
  readonly caret: number
}

export type EmbeddingAndLoraChoiceRoute =
  | '/api/choices/comfy.files.embeddings'
  | '/api/choices/comfy.files.loras'

export interface TextCompletionInventoryRequest {
  readonly text: string
  readonly caret: number
  readonly signal: AbortSignal
  readonly refresh?: boolean
}

export interface TextCompletionInventoryItem {
  readonly completion: TextCompletion
  readonly filterText: string
  readonly sourceOrder: number
}

interface TextCompletionInventoryStateCommon {
  readonly scopeId: string
  readonly query: string
}

export type TextCompletionInventoryLoadingState = TextCompletionInventoryStateCommon & {
  readonly status: 'loading'
}

export type TextCompletionInventorySettledState = TextCompletionInventoryStateCommon & (
  | { readonly status: 'ready'; readonly items: readonly TextCompletionInventoryItem[] }
  | { readonly status: 'empty' }
  | { readonly status: 'error'; readonly message: string }
)

export interface TextCompletionInventoryRequestHandle {
  readonly loading: TextCompletionInventoryLoadingState
  /** Undefined means the request was cancelled, superseded, or changed scope. */
  readonly settled: Promise<TextCompletionInventorySettledState | undefined>
}

const normalizeCompletionFilterText = (value: string): string =>
  value.normalize('NFKC').toLowerCase()

function embeddingAndLoraMatch(request: { readonly text: string; readonly caret: number }): EmbeddingAndLoraMatch | undefined {
  const caret = Math.max(0, Math.min(request.caret, request.text.length))
  let start = caret
  while (start > 0 && !/\s/.test(request.text[start - 1]!)) start -= 1
  const token = request.text.slice(start, caret)
  const route = token.startsWith('embedding:')
    ? '/api/choices/comfy.files.embeddings' as const
    : token.startsWith('<lora:')
      ? '/api/choices/comfy.files.loras' as const
      : undefined
  if (route === undefined) return undefined
  const prefix = route === '/api/choices/comfy.files.embeddings' ? 'embedding:' : '<lora:'
  return { route, query: normalizeCompletionFilterText(token.slice(prefix.length)), start, caret }
}

function embeddingAndLoraCompletions(
  match: EmbeddingAndLoraMatch,
  names: readonly string[],
): readonly TextCompletion[] {
  return names
    .filter((name) => normalizeCompletionFilterText(name).startsWith(match.query))
    .map((name) => embeddingAndLoraCompletion(match, name))
}

function embeddingAndLoraCompletion(match: EmbeddingAndLoraMatch, name: string): TextCompletion {
  return match.route === '/api/choices/comfy.files.embeddings'
    ? {
        id: `embedding:${name}`,
        label: `embedding:${name}`,
        replacement: { start: match.start, end: match.caret, text: `embedding:${name}` },
        detail: 'Embedding',
      }
    : {
        id: `lora:${name}`,
        label: `<lora:${name}:1.0>`,
        replacement: { start: match.start, end: match.caret, text: `<lora:${name}:1.0>` },
        detail: 'LoRA',
      }
}

export class EmbeddingAndLoraCompletionProvider implements TextWidgetEditorExtension {
  readonly id = 'core.embedding-and-lora-completions'

  constructor(private readonly catalog: EmbeddingAndLoraCatalog) {}

  supports(context: TextWidgetEditorContext): boolean {
    return context.spec.widgetType === 'STRING'
  }

  complete(request: TextCompletionRequest): readonly TextCompletion[] {
    if (request.signal.aborted) return []
    const match = embeddingAndLoraMatch(request)
    if (match === undefined) return []
    return embeddingAndLoraCompletions(
      match,
      match.route === '/api/choices/comfy.files.embeddings' ? this.catalog.embeddings : this.catalog.loras,
    )
  }
}

export interface TextCompletionChoiceSource {
  choices(
    route: EmbeddingAndLoraChoiceRoute,
    options: { readonly signal: AbortSignal; readonly refresh?: boolean },
  ): Promise<readonly string[]>
}

export interface TextCompletionInventoryScope {
  readonly id: string
  readonly source: TextCompletionChoiceSource
  readonly isCurrent: () => boolean
}

export interface TextCompletionInventoryScopeSource {
  capture(): TextCompletionInventoryScope | undefined
}

const immutableCompletion = (completion: TextCompletion): TextCompletion => Object.freeze({
  ...completion,
  replacement: Object.freeze({ ...completion.replacement }),
})

const inventoryMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

export class LiveEmbeddingAndLoraInventoryProvider {
  private generation = 0

  constructor(private readonly scopes: TextCompletionInventoryScopeSource) {}

  isScopeCurrent(scopeId: string): boolean {
    const scope = this.scopes.capture()
    return scope?.id === scopeId && scope.isCurrent()
  }

  load(request: TextCompletionInventoryRequest): TextCompletionInventoryRequestHandle | undefined {
    const mine = ++this.generation
    const match = embeddingAndLoraMatch(request)
    if (match === undefined || request.signal.aborted) return undefined
    const scope = this.scopes.capture()
    if (scope === undefined) return undefined
    const common = Object.freeze({ scopeId: scope.id, query: match.query })
    const loading = Object.freeze({ ...common, status: 'loading' as const })
    const settled = (async (): Promise<TextCompletionInventorySettledState | undefined> => {
      let names: readonly string[]
      try {
        names = await scope.source.choices(match.route, {
          signal: request.signal,
          ...(request.refresh === true ? { refresh: true } : {}),
        })
      } catch (error) {
        if (request.signal.aborted || mine !== this.generation || !scope.isCurrent()) return undefined
        return Object.freeze({ ...common, status: 'error', message: inventoryMessage(error) })
      }
      if (request.signal.aborted || mine !== this.generation || !scope.isCurrent()) return undefined
      if (names.length === 0) return Object.freeze({ ...common, status: 'empty' })
      const items = Object.freeze(names.map((name, sourceOrder) => Object.freeze({
        completion: immutableCompletion(embeddingAndLoraCompletion(match, name)),
        filterText: normalizeCompletionFilterText(name),
        sourceOrder,
      })))
      return Object.freeze({ ...common, status: 'ready', items })
    })()
    return Object.freeze({ loading, settled })
  }
}

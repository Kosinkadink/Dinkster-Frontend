import { type DataPanelRow, type SceneNode } from '@dinkster/canvas'
import { dataPanelForNode, type DataLensContext } from './data-lens.js'

/** Presentation-only canvas lens extension point. */
export interface LensDefinition {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly detailedPinTooltips?: boolean
  readonly widgetRowAffordance?: boolean
  readonly previewSurfaceAffordance?: boolean
  readonly typeAdornments?: boolean
  readonly nodeBodyContent?: (node: SceneNode, context: DataLensContext) => readonly DataPanelRow[] | null
}

export class LensRegistry {
  private readonly definitions = new Map<string, LensDefinition>()

  constructor(readonly defaultId = 'standard') {}

  register(definition: LensDefinition): () => void {
    if (this.definitions.has(definition.id)) throw new Error(`lens '${definition.id}' already registered`)
    this.definitions.set(definition.id, definition)
    return () => this.definitions.delete(definition.id)
  }

  list(): readonly LensDefinition[] { return [...this.definitions.values()] }
  get(id: string): LensDefinition | undefined { return this.definitions.get(id) }
  resolve(id: string | undefined): LensDefinition {
    const lens = this.definitions.get(id ?? this.defaultId) ?? this.definitions.get(this.defaultId)
    if (!lens) throw new Error(`default lens '${this.defaultId}' is not registered`)
    return lens
  }
}

export function createCoreLensRegistry(): LensRegistry {
  const registry = new LensRegistry()
  registry.register({ id: 'standard', label: 'Standard', description: 'The standard graph editing view.' })
  registry.register({
    id: 'types',
    label: 'Types',
    description: 'Emphasize pin and noodle data types.',
    detailedPinTooltips: true,
    typeAdornments: true,
  })
  registry.register({
    id: 'data',
    label: 'Data',
    description: 'Show recorded execution states and outputs on node bodies.',
    nodeBodyContent: dataPanelForNode,
  })
  registry.register({
    id: 'exposure',
    label: 'Exposure',
    description: 'Show and toggle inputs and preview surfaces exposed in App view.',
    widgetRowAffordance: true,
    previewSurfaceAffordance: true,
  })
  return registry
}

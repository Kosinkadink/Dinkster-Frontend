import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerCoreWidgets,
  type WidgetRegistrationDoors,
} from '@dinkster/widgets'
import { AppState } from '../src/app-state.js'

let app: AppState
beforeEach(() => {
  vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
  app = new AppState({ defaultProtocol: 'dinkster' })
})
afterEach(() => {
  app.dispose()
  vi.unstubAllGlobals()
})

describe('core extension door dogfooding', () => {
  it('registers every built-in widget kind through the widgetKind door', () => {
    const kinds: string[] = []
    const doors: WidgetRegistrationDoors = {
      widgetKind: (id, kind) => {
        expect(id).toBe(kind.type)
        kinds.push(id)
      },
      widgetView: (id, view) => expect(id).toBe(view.id),
      previewRenderer: (id, renderer) => expect(id).toBe(renderer.id),
    }

    registerCoreWidgets(doors)

    expect(kinds).toEqual([
      'INT',
      'FLOAT',
      'STRING',
      'BOOLEAN',
      'COMBO',
      'MULTI_COMBO',
      'LIST',
      'COLOR',
      'CURVE',
      'COMPOSITOR',
      'ASSET',
      'SAVE_TARGET',
      'VIDEO_EDIT',
      'BUTTON',
      'MARKDOWN',
      'COLORS',
      'AUDIO_RECORD',
    ])
  })

  it('publishes the built-in commands and executes shell actions from the registry', () => {
    expect(app.commands.list().map((command) => command.id).sort()).toEqual([
      'backend.open', 'edit.delete', 'edit.deleteBackspace', 'edit.redo', 'edit.redoLegacy', 'edit.selectAll', 'edit.undo',
      'layout.customize', 'node.bypass', 'node.help', 'node.minimize', 'node.mute',
      'region.createFold', 'region.createMap', 'region.createWhile', 'search.open', 'settings.open',
      'subgraph.createEmpty', 'subgraph.extract', 'subgraph.flatten', 'subgraph.manageDefinitions',
      'view.fitSelection', 'view.zoomIn', 'view.zoomOut',
      'workflow.export', 'workflow.importFile', 'workflow.open', 'workflow.queue', 'workflow.save',
    ])
    expect(app.keybindings.combo('search.open')).toBe('ctrl+k')
    expect(app.keybindings.combo('workflow.queue')).toBe('ctrl+enter')
    expect(app.searchOpen.get()).toBe(false)
    app.commands.get('search.open')!.run()
    expect(app.searchOpen.get()).toBe(true)
    app.settingsOpenRequest.set({ category: 'canvas', id: 'old' })
    app.commands.get('settings.open')!.run()
    expect(app.settingsOpenRequest.get()).toBeUndefined()
    expect(app.modalPanel.get()).toBe('settings')
    app.commands.get('layout.customize')!.run()
    expect(app.modalPanel.get()).toBe('customize-layout')
  })

  it('preserves live command properties through the public command door', () => {
    let label = 'First label'
    const unregister = app.frontendDoors.command('test.live-label', {
      get label() {
        return label
      },
      run: () => {},
    })

    expect(app.commands.get('test.live-label')?.label).toBe('First label')
    label = 'Second label'
    expect(app.commands.get('test.live-label')?.label).toBe('Second label')
    unregister()
    expect(app.commands.get('test.live-label')).toBeUndefined()
  })

  it('publishes a background grid that draws world-anchored dots through the layer registry', () => {
    const layers = app.canvasLayers.get()
    expect(layers.map((layer) => layer.id)).toEqual(['core.canvas.grid'])
    const grid = layers[0]!
    expect(grid.position).toBe('background')
    expect(grid.order).toBe(-1000)
    const dots: number[][] = []
    const context = {
      beginPath() {}, moveTo() {}, fill() {},
      arc: (x: number, y: number, radius: number) => dots.push([x, y, radius]),
    } as unknown as CanvasRenderingContext2D
    grid.draw({ context, viewport: { x: 17, y: 9, width: 40, height: 55, scale: 1 }, nodes: [] })
    expect(dots).toEqual([
      [0, 0, 1.5], [32, 0, 1.5], [0, 32, 1.5], [32, 32, 1.5], [0, 64, 1.5], [32, 64, 1.5],
    ])
  })

  it('publishes distinct non-interactive mode badges through the decoration registry', () => {
    const decorations = app.nodeDecorations.get()
    expect(decorations.map((decoration) => decoration.id)).toEqual(['core.node.mode'])
    const mode = decorations[0]!
    const node = { documentId: 'doc', graphId: 'g0', id: 'n0', type: 'X', title: 'Example' }
    expect(mode.decorate({ ...node, mode: 'active' })).toBeUndefined()
    expect(mode.decorate({ ...node, mode: 'muted' })?.badges).toEqual([
      expect.objectContaining({ id: 'core.mode.muted', glyph: 'Muted', variant: 'label', interactive: false }),
    ])
    expect(mode.decorate({ ...node, mode: 'bypassed' })?.badges).toEqual([
      expect.objectContaining({ id: 'core.mode.bypassed', glyph: 'Bypassed', variant: 'label', interactive: false }),
    ])
  })
})

import { render } from 'solid-js/web'
import { afterEach, expect, it } from 'vitest'
import { createWidgetRegistry } from '@dinkster/widgets'
import type { AppState, Tab } from '../src/app-state.js'
import { WidgetEditor, type WidgetEditorProps, type WidgetEditorState } from '../src/WidgetEditor.js'

afterEach(() => document.body.replaceChildren())

it('renders an editor registered at runtime for a new widget type', () => {
  const registry = createWidgetRegistry()
  const RuntimeEditor = (props: WidgetEditorProps) => (
    <div data-testid="runtime-widget-editor">Editing {props.ed.label}</div>
  )
  expect(registry.editorFor('pack.TIMELINE')).toBeUndefined()
  registry.registerEditor('pack.TIMELINE', RuntimeEditor)

  const tab = {} as Tab
  const app = {
    widgetRegistry: registry,
    widgetRegistryForTab: () => registry,
  } as unknown as AppState
  const ed: WidgetEditorState = {
    tab,
    graphId: 'g0',
    target: { kind: 'input', nodeId: 'n0', valueKey: 'timeline' },
    label: 'Timeline',
    spec: { widgetType: 'pack.TIMELINE', options: {} },
    multiline: false,
    rect: { x: 0, y: 0, width: 100, height: 24 },
    initial: null,
  }

  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => (
    <WidgetEditor
      app={app}
      ed={ed}
      viewport={() => ({ x: 0, y: 0, scale: 1 })}
      onClose={() => {}}
    />
  ), root)

  expect(root.querySelector('[data-testid="runtime-widget-editor"]')?.textContent).toBe('Editing Timeline')
  unmount()
})

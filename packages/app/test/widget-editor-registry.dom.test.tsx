import { render } from 'solid-js/web'
import { afterEach, expect, it } from 'vitest'
import { createWidgetRegistry } from '@dinkster/widgets'
import { coreCommandRegistry, DocumentStore, importLitegraph, inputsOf, parseDinksterSchema } from '@dinkster/core'
import type { AppState, Tab } from '../src/app-state.js'
import { WidgetEditor, type WidgetEditorProps, type WidgetEditorState } from '../src/WidgetEditor.js'

afterEach(() => document.body.replaceChildren())

it('edits only the schema-backed mount string, preserving prefix and undoable default selection', async () => {
  const schema = parseDinksterSchema('SaveFixture', { interface: [
    { role: 'input', id: 'filename_prefix', type: { kind: 'concrete', types: ['STRING'] }, default: 'frames/session' },
    { role: 'input', id: 'mount', type: { kind: 'concrete', types: ['STRING'] }, required: false, default: null, widget: { type: 'MOUNT' }, adjacentTo: 'filename_prefix' },
  ] }).schema!
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: ['frames/session', null] }], links: [] }, () => schema)
  const store = new DocumentStore(imported.document!, coreCommandRegistry())
  const tab = { store } as unknown as Tab
  const registry = createWidgetRegistry()
  const app = {
    widgetRegistry: registry,
    widgetRegistryForTab: () => registry,
    backendForTab: () => ({ protocol: 'dinkster', connection: { fetchMountSettings: async () => ({ mounts: [
      { id: 'archive', mode: 'readwrite', state: 'ready' },
      { id: 'reference', mode: 'read', state: 'ready' },
      { id: 'offline', mode: 'readwrite', state: 'missing' },
    ] }) } }),
    dispatchTo: (_tab: Tab, command: Parameters<DocumentStore['dispatch']>[0]) => store.dispatch(command),
  } as unknown as AppState
  const root = document.createElement('div')
  document.body.append(root)
  const open = () => render(() => <WidgetEditor app={app} ed={{
    tab, graphId: 'g0', target: { kind: 'input', nodeId: 'n1', valueKey: 'mount' }, label: 'Mount',
    spec: inputsOf(schema)[1]!.widget, declaredType: inputsOf(schema)[1]!.type,
    multiline: false, rect: { x: 0, y: 0, width: 180, height: 24 }, initial: store.doc.graphs.g0!.nodes.n1!.values.mount,
  }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
  let dispose = open()
  await Promise.resolve(); await Promise.resolve()
  const choice = root.querySelector<HTMLButtonElement>('[data-testid="mount-widget-choice"]')!
  expect(choice.textContent).toContain('Default output mount')
  choice.click()
  expect(Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent)).toEqual(['Default output mount', 'archive'])
  ;(document.querySelector('[data-option-id="archive"]') as HTMLElement).click()
  expect(store.doc.graphs.g0!.nodes.n1!.values).toEqual({ filename_prefix: 'frames/session', mount: null })
  root.querySelector<HTMLButtonElement>('[data-testid="mount-widget-apply"]')!.click()
  expect(store.doc.graphs.g0!.nodes.n1!.values).toEqual({ filename_prefix: 'frames/session', mount: 'archive' })
  expect(Object.keys(store.doc.graphs.g0!.nodes)).toEqual(['n1'])
  dispose()
  dispose = open()
  await Promise.resolve(); await Promise.resolve()
  root.querySelector<HTMLButtonElement>('[data-testid="mount-widget-choice"]')!.click()
  ;(document.querySelector('[data-option-id=""]') as HTMLElement).click()
  root.querySelector<HTMLButtonElement>('[data-testid="mount-widget-apply"]')!.click()
  expect(store.doc.graphs.g0!.nodes.n1!.values.mount).toBeNull()
  expect(store.undo()).toBe(true)
  expect(store.doc.graphs.g0!.nodes.n1!.values.mount).toBe('archive')
  expect(store.doc.graphs.g0!.nodes.n1!.values.filename_prefix).toBe('frames/session')
  dispose()
})

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

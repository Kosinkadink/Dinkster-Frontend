// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asConnectionId, asPromptId, DINKSTER_SCHEMA_WIRE_VERSION, type DinksterNodesPayload } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState } from '../src/app-state.js'
import { GlslEditor } from '../src/GlslEditor.js'
import type { GlslShaderRunner } from '../src/glsl-shader-runner.js'

const INITIAL_SOURCE = `#version 300 es
precision highp float;
layout(location = 0) out vec4 fragColor0;
void main() { fragColor0 = vec4(0.25); }`

const payload = {
  schemaVersion: 1,
  nodes: {
    'dinkster.image.glsl_shader': {
      schemaVersion: 1,
      displayName: 'GLSL Shader',
      category: 'image/shader',
      idempotent: false,
      outputNode: true,
      editorRole: 'glsl',
      interface: [
        {
          role: 'input', id: 'fragment_shader', required: false,
          type: { kind: 'concrete', types: ['core.string'] },
          default: INITIAL_SOURCE,
          widget: { type: 'STRING', multiline: true },
        },
        { role: 'output', id: 'image0', type: { kind: 'concrete', types: ['dinkster.image'] } },
      ],
    },
  },
} as unknown as DinksterNodesPayload

function mount() {
  const app = new AppState()
  const tab = app.tabs.get()[0]!
  app.registry.set(buildDinksterRegistry(asConnectionId('local'), payload))
  const graphId = tab.store.doc.root
  const seedNodeIds = Object.keys(tab.store.doc.graphs[graphId]!.nodes)
  if (seedNodeIds.length > 0 && !app.dispatchTo(tab, {
    command: 'node.remove', params: { graphId, nodeIds: seedNodeIds },
  }).ok) throw new Error('failed to clear GLSL fixture graph')
  const before = new Set(Object.keys(tab.store.doc.graphs[graphId]!.nodes))
  if (!app.dispatchTo(tab, {
    command: 'node.add',
    params: { graphId, type: 'dinkster.image.glsl_shader', position: { x: 20, y: 30 } },
  }).ok) throw new Error('failed to add GLSL fixture node')
  const nodeId = Object.keys(tab.store.doc.graphs[graphId]!.nodes).find((id) => !before.has(id))!
  const target = app.glslTargetForInput(tab, graphId, nodeId, 'fragment_shader')!
  const compiled = app.compileTab(tab)
  if (!compiled?.ok) throw new Error(`failed to compile GLSL fixture: ${JSON.stringify(compiled?.diagnostics)}`)
  const ref = { connection: asConnectionId('local'), prompt: asPromptId('glsl-run') }
  app.registerRun(tab, ref, compiled.artifact, 1)
  const runtimeNodeId = Object.values(compiled.artifact.provenance.fromSource).flat()[0]!
  app.store.apply({
    kind: 'preview', execution: ref, timestamp: 2, runtimeNodeId,
    channel: 'application/vnd.dinkster.glsl-state+json', stream: 'glsl-state',
    payload: {
      width: 8,
      height: 4,
      inputs: [{ name: 'u_image1', stream: 'glsl-input-u_image1' }],
      floats: { u_float3: 0.5 },
      ints: { u_int2: 7 },
      bools: { u_bool1: true },
      curves: {},
    },
  })
  app.store.apply({
    kind: 'preview', execution: ref, timestamp: 3, runtimeNodeId,
    channel: 'image/png', stream: 'glsl-input-u_image1', payload: new Blob(['png'], { type: 'image/png' }),
  })
  if (!app.openGlslEditor(target)) throw new Error('failed to open GLSL fixture')
  const runner: GlslShaderRunner = {
    render: vi.fn((draw) => ({
      ok: false as const,
      diagnostics: [`Shader output ${draw.output} refused for ${draw.source.length} bytes`],
    })),
    dispose: vi.fn(),
  }
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:glsl-input')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue()
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <GlslEditor app={app} createRunner={() => runner} />, root)
  return { app, tab, graphId, nodeId, root, runner, ref, runtimeNodeId, dispose }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
  localStorage.clear()
})

describe('GlslEditor', () => {
  it('selects the preview output, shows runner diagnostics, and applies the exact source', async () => {
    const mounted = mount()
    const select = mounted.root.querySelector<HTMLSelectElement>('select[aria-label="Preview output"]')!
    select.value = '2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(mounted.runner.render).toHaveBeenLastCalledWith(expect.objectContaining({
      output: 2,
      images: { u_image1: expect.any(HTMLImageElement) },
    })))
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain('Shader output 2 refused')
    expect(mounted.root.textContent).toContain('u_float3')

    const next = `${INITIAL_SOURCE}\n// exact replacement`
    const source = mounted.root.querySelector<HTMLTextAreaElement>('[data-testid="glsl-source"]')!
    source.value = next
    source.dispatchEvent(new InputEvent('input', { bubbles: true }))
    mounted.root.querySelector<HTMLButtonElement>('button.primary')!.click()
    expect(mounted.tab.store.doc.graphs[mounted.graphId]!.nodes[mounted.nodeId]!.values['fragment_shader']).toBe(next)
    expect(mounted.app.glslEditorTarget.get()).toBeUndefined()
    mounted.dispose()
    expect(mounted.runner.dispose).toHaveBeenCalledOnce()
    mounted.app.dispose()
  })

  it('disables apply when the source changes concurrently', async () => {
    const mounted = mount()
    expect(mounted.app.dispatchTo(mounted.tab, {
      command: 'node.setValue',
      params: {
        graphId: mounted.graphId,
        nodeId: mounted.nodeId,
        inputId: 'fragment_shader',
        value: 'concurrent source',
      },
    }).ok).toBe(true)
    const apply = mounted.root.querySelector<HTMLButtonElement>('button.primary')!
    await vi.waitFor(() => expect(apply.disabled).toBe(true))
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain('no longer available')
    expect(mounted.tab.store.doc.graphs[mounted.graphId]!.nodes[mounted.nodeId]!.values['fragment_shader']).toBe('concurrent source')
    expect(mounted.app.glslEditorTarget.get()).toBeDefined()
    mounted.dispose()
    mounted.app.dispose()
  })

  it('clears the previous result while newer runtime inputs decode', async () => {
    const mounted = mount()
    await vi.waitFor(() => expect(mounted.root.querySelector('[role="alert"]')?.textContent)
      .toContain('Shader output 0 refused'))
    vi.mocked(HTMLImageElement.prototype.decode).mockImplementation(() => new Promise(() => {}))

    mounted.app.store.apply({
      kind: 'preview', execution: mounted.ref, timestamp: 4, runtimeNodeId: mounted.runtimeNodeId,
      channel: 'application/vnd.dinkster.glsl-state+json', stream: 'glsl-state',
      payload: {
        width: 16,
        height: 8,
        inputs: [{ name: 'u_image1', stream: 'glsl-input-u_image1' }],
        floats: {},
        ints: {},
        bools: {},
        curves: {},
      },
    })

    await vi.waitFor(() => expect(mounted.root.querySelector('[role="alert"]')).toBeNull())
    expect(mounted.root.textContent).toContain('Browser preview unavailable.')
    mounted.dispose()
    mounted.app.dispose()
  })
})

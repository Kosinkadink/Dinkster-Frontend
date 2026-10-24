// @vitest-environment happy-dom

import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetDtoV1WireContract, CandidateV1 } from '@dinkster/client'
import { registerCatalog, setLocale } from '@dinkster/core'
import type { AppState, Tab } from '../src/app-state.js'
import { ModalSurface } from '../src/ModalSurface.js'
import { WidgetEditor, type WidgetEditorState } from '../src/WidgetEditor.js'

beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  })
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
})

afterEach(() => {
  document.body.replaceChildren()
  setLocale('en')
  vi.restoreAllMocks()
})

function mount(blocked = false, onBackdropPointerDown?: (event: PointerEvent) => void) {
  const root = document.createElement('div')
  document.body.append(root)
  const close = vi.fn()
  const [open, setOpen] = createSignal(true)
  const unmount = render(() => (
    <Show when={open()}>
      <ModalSurface
        title="Asset picker"
        ariaLabel="Edit image asset"
        describedBy="asset-help"
        modalId="widget-asset"
        dismissBlocked={blocked}
        onRequestClose={() => { close(); setOpen(false) }}
        {...(onBackdropPointerDown !== undefined ? { onBackdropPointerDown } : {})}
      >
        <p id="asset-help">Browse compatible images.</p>
        <button type="button">Choose</button>
      </ModalSurface>
    </Show>
  ), root)
  return { root, close, unmount }
}

function widgetState(
  type: string,
  options: Record<string, unknown>,
  initial: WidgetEditorState['initial'],
  multiline = false,
  overrides: { valueKey?: string; label?: string; nodeType?: string } = {},
): WidgetEditorState {
  const valueKey = overrides.valueKey ?? type.toLowerCase()
  return {
    tab: {
      store: {
        doc: {
          graphs: {
            g0: {
              nodes: { n0: { type: overrides.nodeType, values: { [valueKey]: initial } } },
              links: {},
              nets: {},
            },
          },
        },
      },
    } as unknown as Tab,
    graphId: 'g0',
    target: { kind: 'input', nodeId: 'n0', valueKey },
    label: overrides.label ?? `${type} value`,
    spec: { widgetType: type, options },
    multiline,
    rect: { x: 20, y: 20, width: 180, height: 24 },
    initial,
  }
}

function mountWidget(ed: WidgetEditorState) {
  const root = document.createElement('div')
  document.body.append(root)
  const close = vi.fn()
  const dispatchTo = vi.fn()
  let clickAway: (() => void) | undefined
  const [open, setOpen] = createSignal(true)
  const [viewport, setViewport] = createSignal({ x: 0, y: 0, scale: 1 })
  const app = {
    backendForTab: () => ({
      protocol: 'v1',
      scopedClient: {
        query: vi.fn().mockResolvedValue({
          mounts: [{ id: 'output', mode: 'readwrite', state: 'ready' }],
        }),
      },
    }),
    dispatchTo,
    widgetRegistry: { kind: () => undefined },
    widgetRegistryForTab: () => app.widgetRegistry,
  } as unknown as AppState
  const unmount = render(() => (
    <Show when={open()}>
      <WidgetEditor
        app={app}
        ed={ed}
        viewport={viewport}
        bindClickAway={(handler) => { clickAway = handler }}
        onClose={() => { close(); setOpen(false) }}
      />
    </Show>
  ), root)
  return { root, close, dispatchTo, setViewport, clickAway: () => clickAway?.(), unmount }
}

describe('ModalSurface', () => {
  it('updates an open video document modal and source status when the locale changes', () => {
    registerCatalog('de-DE', {
      'videoDocument.source.missing': '[Dokument fehlt]',
      'videoDocument.type': '[Videodokument]',
    })
    const ed = widgetState('STRING', {}, '{"scalar":1}', true, {
      valueKey: 'params',
      label: 'Parameters',
      nodeType: 'dinkster.video_document.retime',
    })
    const mounted = mountWidget(ed)
    const dialog = mounted.root.querySelector<HTMLDialogElement>('[data-modal="widget-video-document"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Edit Parameters video document')
    expect(dialog.textContent).toContain('Connect the document input')

    setLocale('de-DE')

    expect(dialog.getAttribute('aria-label')).toBe('Edit Parameters [Videodokument]')
    expect(dialog.textContent).toContain('[Dokument fehlt]')
    mounted.unmount()
  })

  it('opens a named, described native modal with explicit close chrome', () => {
    const mounted = mount()
    const dialog = mounted.root.querySelector('dialog')!
    expect(dialog.open).toBe(true)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Edit image asset')
    expect(dialog.getAttribute('aria-describedby')).toBe('asset-help')
    expect(dialog.getAttribute('data-modal')).toBe('widget-asset')

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="modal-close"]')!.click()
    expect(mounted.close).toHaveBeenCalledOnce()
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalled()
    mounted.unmount()
  })

  it('does not let a retiring dialog close its immediate successor', () => {
    vi.mocked(HTMLDialogElement.prototype.close).mockImplementation(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    })
    const root = document.createElement('div')
    document.body.append(root)
    const staleClose = vi.fn()
    const [instance, setInstance] = createSignal<'first' | 'second' | undefined>('first')
    const unmount = render(() => (
      <Show when={instance()} keyed>
        {(id) => (
          <ModalSurface
            title={id}
            modalId={id}
            onRequestClose={() => { staleClose(id); setInstance(undefined) }}
          >
            <button type="button">Choose</button>
          </ModalSurface>
        )}
      </Show>
    ), root)

    setInstance('second')

    expect(staleClose).not.toHaveBeenCalled()
    expect(root.querySelector('dialog')?.dataset['modal']).toBe('second')
    unmount()
    expect(staleClose).not.toHaveBeenCalled()
  })

  it('maps Escape cancellation to native close and can block it during an owned operation', () => {
    const open = mount()
    const dialog = open.root.querySelector('dialog')!
    const cancel = new Event('cancel', { bubbles: false, cancelable: true })
    expect(dialog.dispatchEvent(cancel)).toBe(true)
    expect(cancel.defaultPrevented).toBe(false)
    dialog.dispatchEvent(new Event('close'))
    expect(open.close).toHaveBeenCalledOnce()

    const blocked = mount(true)
    const blockedCancel = new Event('cancel', { bubbles: false, cancelable: true })
    expect(blocked.root.querySelector('dialog')!.dispatchEvent(blockedCancel)).toBe(false)
    expect(blockedCancel.defaultPrevented).toBe(true)
    expect(blocked.close).not.toHaveBeenCalled()
    const blockedClose = blocked.root.querySelector<HTMLButtonElement>('[data-testid="modal-close"]')!
    expect(blockedClose.disabled).toBe(true)
    blockedClose.click()
    expect(blocked.close).not.toHaveBeenCalled()
    blocked.unmount()
  })

  it('closes from a synthetic backdrop pointer without handing it to the canvas', () => {
    const handoff = vi.fn()
    const mounted = mount(false, handoff)
    const dialog = mounted.root.querySelector('dialog')!
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, left: 100, top: 100, right: 500, bottom: 400,
      width: 400, height: 300, toJSON: () => ({}),
    })
    dialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 200 }))
    expect(mounted.close).not.toHaveBeenCalled()
    const backdrop = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    expect(dialog.dispatchEvent(backdrop)).toBe(false)
    expect(backdrop.defaultPrevented).toBe(true)
    expect(mounted.close).toHaveBeenCalledOnce()
    expect(backdrop.isTrusted).toBeFalsy()
    expect(handoff).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('does not hand off a blocked or non-primary backdrop press', () => {
    const handoff = vi.fn()
    const blocked = mount(true, handoff)
    const blockedDialog = blocked.root.querySelector('dialog')!
    vi.spyOn(blockedDialog, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, left: 100, top: 100, right: 500, bottom: 400,
      width: 400, height: 300, toJSON: () => ({}),
    })
    blockedDialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 20 }))
    expect(blocked.close).not.toHaveBeenCalled()
    expect(handoff).not.toHaveBeenCalled()
    blocked.unmount()

    const secondary = mount(false, handoff)
    const secondaryDialog = secondary.root.querySelector('dialog')!
    vi.spyOn(secondaryDialog, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, left: 100, top: 100, right: 500, bottom: 400,
      width: 400, height: 300, toJSON: () => ({}),
    })
    secondaryDialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, clientX: 20, clientY: 20 }))
    expect(secondary.close).toHaveBeenCalledOnce()
    expect(handoff).not.toHaveBeenCalled()
    secondary.unmount()
  })
})

describe('ASSET widget modal integration', () => {
  const candidate = (digest = `blake3:${'c'.repeat(64)}`): CandidateV1 => ({
    logicalId: 'provider/checkpoint', family: 'Provider checkpoint', assetKind: 'model/checkpoint',
    variantId: 'fp16', dtype: 'float16', quantization: 'none', format: 'safetensors', role: 'base',
    requirements: { loaders: [], runtimes: [], hardware: [] }, digest, size: 42,
    mediaType: 'application/x-safetensors', availability: { status: 'downloadable', reason: 'remote' },
    compatibility: { status: 'compatible', reason: '' },
    providerSources: [{ source: { providerId: 'provider', sourceId: 'catalog' }, status: 'available', reason: '', requires: {} }],
  })

  const federatedContract = (encodeRequest: ReturnType<typeof vi.fn>, items: readonly CandidateV1[]): AssetDtoV1WireContract => ({
    paths: { catalog: '/catalog', candidates: '/candidates' },
    catalog: { encodeRequest: (request) => request, decodeResponse: () => ({ contractVersion: 1, items: [] }) },
    candidates: {
      encodeRequest,
      decodeResponse: () => ({ contractVersion: 1, status: 'missing', items }),
    },
    decodeError: () => { throw new Error('unexpected federated error') },
  })

  const catalogAssetEditor = (
    kind: string,
    declaredType: WidgetEditorState['declaredType'] = { kind: 'concrete', name: 'dinkster.asset' },
    initial: WidgetEditorState['initial'] = null,
    mountEditor = true,
  ) => {
    const root = document.createElement('div')
    document.body.append(root)
    const close = vi.fn()
    const dispatchTo = vi.fn()
    const digestA = `blake3:${'a'.repeat(64)}`
    const digestB = `blake3:${'b'.repeat(64)}`
    const connection = {
      listMounts: vi.fn().mockResolvedValue([
        { id: 'left', mode: 'read', state: 'ready', kind },
        { id: 'right', mode: 'read', state: 'ready', kind },
      ]),
      listMountEntries: vi.fn(async (mountId: string) => ({
        entries: mountId === 'left'
          ? [{ digest: digestA, name: 'shared.safetensors', size: 100, mediaType: 'application/x-safetensors', kind, virtualPath: 'a/shared.safetensors' }]
          : [{ digest: digestB, name: 'shared.safetensors', size: 200, mediaType: 'application/x-safetensors', kind, virtualPath: 'b/shared.safetensors' }],
      })),
      assetUrl: vi.fn((digest: string) => `/api/assets/${digest}`),
    }
    const ed: WidgetEditorState = {
      tab: {} as Tab,
      graphId: 'g0',
      target: { kind: 'input', nodeId: 'n0', valueKey: 'asset' },
      label: 'Asset',
      spec: { widgetType: 'ASSET', kind, options: { accept: ['application/x-safetensors'] } },
      declaredType,
      multiline: false,
      rect: { x: 20, y: 20, width: 180, height: 24 },
      initial,
    }
    const app = {
      backendForTab: () => ({ protocol: 'dinkster', id: 'native', connection }),
      dispatchTo,
      widgetRegistry: { kind: () => undefined },
    } as unknown as AppState
    const unmount = mountEditor
      ? render(() => <WidgetEditor app={app} ed={ed} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={close} />, root)
      : () => {}
    return { root, close, dispatchTo, connection, ed, digestA, digestB, unmount }
  }

  it('uses grouped model variants with kind-scoped scans and commits an exact variant ref', async () => {
    const mounted = catalogAssetEditor('model/checkpoint')
    await vi.waitFor(() => expect(mounted.root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(2))

    // Model kinds show no upload-limit copy: the generic 16 MiB enforcement
    // bound is not an authoritative model limit.
    expect(mounted.root.querySelector('[data-testid="asset-schema-metadata"]')?.textContent).not.toContain('per file')
    expect(mounted.root.querySelectorAll('[data-testid="collection-group"]')).toHaveLength(1)
    expect(mounted.root.querySelectorAll('[data-testid="logical-model-conflict"]')).toHaveLength(0)
    expect(mounted.root.querySelector('[data-testid="collection-panel"]')).not.toBeNull()
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-upload-trigger"]')?.disabled).toBe(true)
    expect(mounted.connection.listMountEntries).toHaveBeenCalledWith('left', expect.objectContaining({
      kind: 'model/checkpoint', recursive: true,
    }))
    const choices = mounted.root.querySelectorAll<HTMLElement>('[data-testid="collection-entry"]')
    choices[1]!.click()
    expect(choices[1]!.classList.contains('selected')).toBe(true)
    expect(mounted.root.querySelectorAll('[data-testid="logical-model-conflict"]')).toHaveLength(1)
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-apply"]')!.click()
    expect(mounted.dispatchTo).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(mounted.ed.tab, {
      command: 'node.setValue',
      params: {
        graphId: 'g0', nodeId: 'n0', inputId: 'asset',
        value: {
          digest: mounted.digestB,
          name: 'shared.safetensors',
          size: 200,
          mediaType: 'application/x-safetensors',
          virtualPath: 'b/shared.safetensors',
        },
      },
    })
    mounted.unmount()
  })

  it('stages an empty selection through Remove and only commits at the footer', async () => {
    const mounted = catalogAssetEditor('model/checkpoint')
    await vi.waitFor(() => expect(mounted.root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(2))

    expect(mounted.root.querySelector('[data-testid="asset-selection-remove"]')).toBeNull()
    mounted.root.querySelector<HTMLElement>('[data-testid="collection-entry"]')!.click()
    const remove = mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-selection-remove"]')
    expect(remove).not.toBeNull()
    remove!.click()
    expect(mounted.root.querySelector('[data-testid="asset-selection-remove"]')).toBeNull()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-apply"]')!.click()
    expect(mounted.dispatchTo).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(mounted.ed.tab, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n0', inputId: 'asset', value: null },
    })
    mounted.unmount()
  })

  it('requests model candidates with the declared widget and existing schema context, then groups the result', async () => {
    const encodeRequest = vi.fn((request) => request)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response)
    const mounted = catalogAssetEditor('model/checkpoint', undefined, null, false)
    const ed = {
      ...mounted.ed,
      tab: { store: { doc: { graphs: { g0: { nodes: { n0: { type: 'CheckpointLoader' } } } } } } } as unknown as Tab,
    }
    const root = document.createElement('div')
    document.body.append(root)
    const dispatchTo = vi.fn()
    const unmount = render(() => (
      <WidgetEditor
        app={({ backendForTab: () => ({ protocol: 'dinkster', id: 'native', connection: mounted.connection }), dispatchTo, widgetRegistry: { kind: () => undefined } } as unknown as AppState)}
        federatedAssets={federatedContract(encodeRequest, [candidate()])}
        ed={ed}
        viewport={() => ({ x: 0, y: 0, scale: 1 })}
        onClose={() => {}}
      />
    ), root)

    await vi.waitFor(() => expect(encodeRequest).toHaveBeenCalledOnce())
    expect(encodeRequest).toHaveBeenCalledOnce()
    expect(encodeRequest.mock.calls[0]![0].context).toEqual({
      assetKind: 'model/checkpoint',
      schema: { nodeType: 'CheckpointLoader', inputId: 'asset' },
      accept: ['application/x-safetensors'],
    })
    await vi.waitFor(() => expect(root.textContent).toContain('Provider checkpoint'))
    expect(root.querySelectorAll('[data-testid="collection-group"]')).toHaveLength(1)
    expect(root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(3)
    const remote = [...root.querySelectorAll<HTMLElement>('[data-testid="collection-entry"]')]
      .find((entry) => entry.textContent?.includes('Provider checkpoint'))!
    remote.click()
    expect(remote.classList.contains('selected')).toBe(true)
    expect(root.querySelector('[data-testid="asset-selection-summary"]')?.textContent).toContain('Provider checkpoint')
    expect(root.querySelector('[data-testid="logical-model-variant-details"]')?.textContent).toContain('Download unavailable')
    expect(root.querySelector<HTMLButtonElement>('[data-testid="logical-model-download"]')?.disabled).toBe(true)
    expect(root.querySelector<HTMLButtonElement>('[data-testid="asset-apply"]')?.disabled).toBe(true)
    expect(dispatchTo).not.toHaveBeenCalled()
    unmount()
  })

  it('forwards Candidate cursors and retains exact variants from every page', async () => {
    const requests: unknown[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(init?.body as string))
      return { ok: true, json: async () => ({ page: requests.length }) } as Response
    })
    const first = candidate(`blake3:${'c'.repeat(64)}`)
    const second = { ...candidate(`blake3:${'d'.repeat(64)}`), variantId: 'fp8' }
    const mounted = catalogAssetEditor('model/checkpoint', undefined, null, false)
    const ed = {
      ...mounted.ed,
      tab: { store: { doc: { graphs: { g0: { nodes: { n0: { type: 'CheckpointLoader' } } } } } } } as unknown as Tab,
    }
    const contract = federatedContract(vi.fn((request) => request), [])
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <WidgetEditor
        app={({ backendForTab: () => ({ protocol: 'dinkster', id: 'native', connection: mounted.connection }), dispatchTo: vi.fn(), widgetRegistry: { kind: () => undefined } } as unknown as AppState)}
        federatedAssets={{
          ...contract,
          candidates: {
            ...contract.candidates,
            decodeResponse: (response) => (response as { page: number }).page === 1
              ? { contractVersion: 1, status: 'missing', items: [first], nextCursor: 'candidate-page-2' }
              : { contractVersion: 1, status: 'missing', items: [second] },
          },
        }}
        ed={ed}
        viewport={() => ({ x: 0, y: 0, scale: 1 })}
        onClose={() => {}}
      />
    ), root)

    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0]).not.toHaveProperty('cursor')
    expect(requests[1]).toMatchObject({ cursor: 'candidate-page-2', limit: 100 })
    await vi.waitFor(() => {
      const row = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="collection-group"]'))
        .find((entry) => entry.textContent?.includes('Provider checkpoint'))
      expect(row?.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(2)
      expect(row?.textContent).toContain('fp16')
      expect(row?.textContent).toContain('fp8')
      // Digests stay out of rows; they belong to the selection Details.
      expect(row?.querySelectorAll('code')).toHaveLength(0)
    })
    unmount()
  })

  it('keeps exact local model choices when Candidate decoding fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response)
    const mounted = catalogAssetEditor('model/checkpoint', undefined, null, false)
    const ed = {
      ...mounted.ed,
      tab: { store: { doc: { graphs: { g0: { nodes: { n0: { type: 'CheckpointLoader' } } } } } } } as unknown as Tab,
    }
    const contract = federatedContract(vi.fn((request) => request), [])
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <WidgetEditor
        app={({ backendForTab: () => ({ protocol: 'dinkster', id: 'native', connection: mounted.connection }), dispatchTo: vi.fn(), widgetRegistry: { kind: () => undefined } } as unknown as AppState)}
        federatedAssets={{ ...contract, candidates: { ...contract.candidates, decodeResponse: () => { throw new Error('candidate decode failed') } } }}
        ed={ed}
        viewport={() => ({ x: 0, y: 0, scale: 1 })}
        onClose={() => {}}
      />
    ), root)
    await vi.waitFor(() => expect(root.textContent).toContain('candidate decode failed'))
    expect(root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(2)
    unmount()
  })

  it('aborts superseded Candidate pagination and publishes the replacement local scan', async () => {
    let fetchCall = 0
    let supersededSignal: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      fetchCall += 1
      if (fetchCall === 1) return { ok: true, json: async () => ({ page: 1 }) } as Response
      if (fetchCall === 2) {
        supersededSignal = init?.signal as AbortSignal
        return await new Promise<Response>((_resolve, reject) => {
          supersededSignal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        })
      }
      return { ok: true, json: async () => ({ page: 2 }) } as Response
    })
    const mounted = catalogAssetEditor('model/checkpoint', undefined, null, false)
    const ed = {
      ...mounted.ed,
      tab: { store: { doc: { graphs: { g0: { nodes: { n0: { type: 'CheckpointLoader' } } } } } } } as unknown as Tab,
    }
    const contract = federatedContract(vi.fn((request) => request), [])
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <WidgetEditor
        app={({ backendForTab: () => ({ protocol: 'dinkster', id: 'native', connection: mounted.connection }), dispatchTo: vi.fn(), widgetRegistry: { kind: () => undefined } } as unknown as AppState)}
        federatedAssets={{
          ...contract,
          candidates: {
            ...contract.candidates,
            decodeResponse: (response) => (response as { page: number }).page === 1
              ? { contractVersion: 1, status: 'missing', items: [], nextCursor: 'next' }
              : { contractVersion: 1, status: 'missing', items: [] },
          },
        }}
        ed={ed}
        viewport={() => ({ x: 0, y: 0, scale: 1 })}
        onClose={() => {}}
      />
    ), root)
    await vi.waitFor(() => expect(fetchCall).toBe(2))
    const refresh = root.querySelector<HTMLButtonElement>('[data-testid="logical-model-refresh"]')!
    refresh.disabled = false
    refresh.click()
    await vi.waitFor(() => expect(supersededSignal?.aborted).toBe(true))
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(2))
    expect(fetchCall).toBe(3)
    unmount()
  })

  it.each([
    ['value source', { kind: 'valueSource', valueSourceId: 'v0' }],
    ['missing graph and node', { kind: 'input', nodeId: 'missing', valueKey: 'asset' }],
  ] as const)('keeps the local model scan and makes zero candidate calls for a %s target', async (_label, target) => {
    const encodeRequest = vi.fn((request) => request)
    const mounted = catalogAssetEditor('model/checkpoint', undefined, null, false)
    const ed = { ...mounted.ed, tab: { store: { doc: { graphs: {} } } } as unknown as Tab, target }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <WidgetEditor
        app={({ backendForTab: () => ({ protocol: 'dinkster', id: 'native', connection: mounted.connection }), dispatchTo: vi.fn(), widgetRegistry: { kind: () => undefined } } as unknown as AppState)}
        federatedAssets={federatedContract(encodeRequest, [candidate()])}
        ed={ed}
        viewport={() => ({ x: 0, y: 0, scale: 1 })}
        onClose={() => {}}
      />
    ), root)
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(2))
    expect(encodeRequest).not.toHaveBeenCalled()
    expect(mounted.connection.listMountEntries).toHaveBeenCalled()
    unmount()
  })

  it('keeps every media kind on the CollectionPanel grid by default', async () => {
    localStorage.removeItem('dinkster.assetBrowser.view.v1')
    const mounted = catalogAssetEditor('media/image')
    await vi.waitFor(() => expect(mounted.root.querySelector('[data-testid="collection-panel"]')).not.toBeNull())
    expect(mounted.root.querySelector('[data-testid="collection-items"]')?.getAttribute('data-mode')).toBe('grid')
    expect(mounted.connection.listMountEntries).toHaveBeenCalledWith('left', expect.objectContaining({ kind: 'media/image' }))
    mounted.unmount()

    const video = catalogAssetEditor('media/video')
    await vi.waitFor(() => expect(video.root.querySelector('[data-testid="collection-panel"]')).not.toBeNull())
    expect(video.root.querySelector('[data-testid="collection-items"]')?.getAttribute('data-mode')).toBe('grid')
    video.unmount()
  })

  it('offers media source facets by adapter ID while retaining unclassified assets only in All assets', async () => {
    const mounted = catalogAssetEditor('media/image', undefined, null, false)
    mounted.connection.listMounts.mockResolvedValue([
      { id: 'comfy-input', mode: 'read', state: 'ready', kind: 'media/image' },
      { id: 'comfy-output', mode: 'read', state: 'ready', kind: 'media/image' },
      { id: 'archive', mode: 'read', state: 'ready', kind: 'media/image' },
    ])
    mounted.connection.listMountEntries.mockImplementation(async (mountId: string) => ({ entries: [{
      digest: `blake3:${mountId === 'comfy-input' ? '1' : mountId === 'comfy-output' ? '2' : '3'}`.padEnd(71, mountId === 'archive' ? '3' : '0'),
      name: `${mountId}.png`, size: 10, mediaType: 'application/x-safetensors', kind: 'media/image', virtualPath: `${mountId}.png`,
    }] }))
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <WidgetEditor app={({ backendForTab: () => ({ protocol: 'dinkster', id: 'native', connection: mounted.connection }), dispatchTo: vi.fn(), widgetRegistry: { kind: () => undefined } } as unknown as AppState)} ed={mounted.ed} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(3))
    expect(root.textContent).toContain('archive.png')
    const source = root.querySelector<HTMLButtonElement>('[data-testid="collection-source-select"]')!
    expect(source.textContent).toContain('All assets')
    source.click()
    expect(document.body.textContent).toContain('Imported')
    expect(document.body.textContent).toContain('Generated')
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent === 'Imported')!.click()
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(1))
    expect(root.textContent).toContain('comfy-input.png')
    expect(root.textContent).not.toContain('archive.png')
    root.querySelector<HTMLButtonElement>('[data-testid="collection-source-select"]')!.click()
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent === 'Generated')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('comfy-output.png'))
    expect(root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(1)
    expect(root.textContent).toContain('comfy-output.png')
    expect(root.textContent).not.toContain('comfy-input.png')
    expect(root.textContent).not.toContain('archive.png')
    unmount()
  })

  it('uses the shared source control for models without media facet labels', async () => {
    const mounted = catalogAssetEditor('model/checkpoint')
    await vi.waitFor(() => expect(mounted.root.querySelector('[data-testid="collection-panel"]')).not.toBeNull())
    expect(mounted.root.querySelector('[data-testid="collection-source-select"]')?.textContent).toContain('Models')
    expect(mounted.root.textContent).not.toContain('All assets')
    expect(mounted.root.textContent).not.toContain('Imported')
    expect(mounted.root.textContent).not.toContain('Generated')
    mounted.unmount()
  })

  it('stages exact grouped variant refs for one multi-select Apply command', async () => {
    const mounted = catalogAssetEditor('model/checkpoint', {
      kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.MODEL' } },
    })
    await vi.waitFor(() => expect(mounted.root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(2))
    mounted.root.querySelectorAll<HTMLElement>('[data-testid="collection-entry"]')[1]!.click()
    expect(mounted.root.querySelector('[data-testid="asset-chip"]')!.textContent).toContain('shared.safetensors')
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-apply"]')!.click()
    expect(mounted.dispatchTo).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo.mock.calls[0]?.[1]).toMatchObject({
      command: 'node.setValue',
      params: { value: [{
        digest: mounted.digestB,
        name: 'shared.safetensors',
        size: 200,
        mediaType: 'application/x-safetensors',
        virtualPath: 'b/shared.safetensors',
      }] },
    })
    mounted.unmount()
  })

  it('uses digest identity when a grouped multi-selection starts on a non-primary alias', async () => {
    const aliasRef = {
      digest: `blake3:${'a'.repeat(64)}`,
      name: 'renamed-shared.safetensors',
      size: 100,
      mediaType: 'application/x-safetensors',
      virtualPath: 'legacy/renamed-shared.safetensors',
    }
    const mounted = catalogAssetEditor('model/checkpoint', {
      kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.MODEL' } },
    }, [aliasRef])
    await vi.waitFor(() => expect(mounted.root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(2))
    const canonical = mounted.root.querySelectorAll<HTMLElement>('[data-testid="collection-entry"]')[0]!

    expect(canonical.getAttribute('aria-selected')).toBe('true')
    expect(canonical.classList.contains('selected')).toBe(true)
    expect(mounted.root.querySelector('[data-testid="logical-model-variant-details"]')).not.toBeNull()
    canonical.click()
    expect(mounted.root.querySelectorAll('[data-testid="asset-chip"]')).toHaveLength(0)
    canonical.click()
    expect(mounted.root.querySelectorAll('[data-testid="asset-chip"]')).toHaveLength(1)
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-apply"]')!.click()
    const value = (mounted.dispatchTo.mock.calls[0]?.[1] as { params: { value: readonly typeof aliasRef[] } }).params.value
    expect(value).toHaveLength(1)
    expect(value[0]).toEqual({
      digest: aliasRef.digest,
      name: 'shared.safetensors',
      size: 100,
      mediaType: 'application/x-safetensors',
      virtualPath: 'a/shared.safetensors',
    })
    expect(new Set(value.map((ref) => ref.digest)).size).toBe(value.length)
    mounted.unmount()
  })

  it('deduplicates same-digest aliases on grouped Apply without requiring a toggle', async () => {
    const first = {
      digest: `blake3:${'a'.repeat(64)}`,
      name: 'first-alias.safetensors',
      size: 100,
      mediaType: 'application/x-safetensors',
      virtualPath: 'legacy/first-alias.safetensors',
    }
    const second = { ...first, name: 'second-alias.safetensors', virtualPath: 'legacy/second-alias.safetensors' }
    const mounted = catalogAssetEditor('model/checkpoint', {
      kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.MODEL' } },
    }, [first, second])
    await vi.waitFor(() => expect(mounted.root.querySelector('[data-testid="collection-panel"]')).not.toBeNull())

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-apply"]')!.click()
    const value = (mounted.dispatchTo.mock.calls[0]?.[1] as { params: { value: readonly typeof first[] } }).params.value
    expect(value).toEqual([first])
    mounted.unmount()
  })

  it('settles a failed grouped scan and lets Refresh retry successfully', async () => {
    const mounted = catalogAssetEditor('model/checkpoint')
    mounted.connection.listMountEntries.mockRejectedValueOnce(new Error('catalog unavailable'))
    await vi.waitFor(() => expect(mounted.root.textContent).toContain('catalog unavailable'))

    const refresh = mounted.root.querySelector<HTMLButtonElement>('[data-testid="logical-model-refresh"]')!
    expect(mounted.root.textContent).not.toContain('loading grouped models...')
    expect(refresh.disabled).toBe(false)
    refresh.click()
    await vi.waitFor(() => expect(mounted.root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(2))
    mounted.unmount()
  })

  const unresolvedAssetEditor = (
    overrides: Partial<AppState> = {},
    initial = 'models/checkpoints/missing-model.safetensors',
    declaredType: WidgetEditorState['declaredType'] = { kind: 'concrete', name: 'dinkster.asset' },
  ) => {
    const root = document.createElement('div')
    document.body.append(root)
    const close = vi.fn()
    const dispatchTo = vi.fn()
    const connection = {
      listMounts: vi.fn().mockResolvedValue([]),
      guessAssets: vi.fn().mockResolvedValue([]),
    }
    const ed: WidgetEditorState = {
      tab: {} as Tab,
      graphId: 'g0',
      target: { kind: 'input', nodeId: 'n0', valueKey: 'ckpt_name' },
      label: 'Checkpoint',
      spec: {
        widgetType: 'ASSET',
        kind: 'model/checkpoint',
        options: { accept: ['application/x-safetensors', 'application/octet-stream'] },
      },
      declaredType,
      multiline: false,
      rect: { x: 20, y: 20, width: 180, height: 24 },
      initial,
    }
    const app = {
      backendForTab: () => ({ protocol: 'dinkster', id: 'native', connection }),
      dispatchTo,
      widgetRegistry: { kind: () => undefined },
      widgetRegistryForTab: () => app.widgetRegistry,
      ...overrides,
    } as unknown as AppState
    const unmount = render(() => (
      <WidgetEditor app={app} ed={ed} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={close} />
    ), root)
    return { root, close, dispatchTo, connection, ed, unmount }
  }

  it('renders actionable unresolved-import details and an honest disabled download state', async () => {
    const mounted = unresolvedAssetEditor()
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const details = mounted.root.querySelector('[data-testid="asset-unresolved-import"]')!.textContent!
    expect(details).toContain('models/checkpoints/missing-model.safetensors')
    expect(details).toContain('missing-model.safetensors')
    expect(details).toContain('model/checkpoint')
    expect(details).toContain('application/x-safetensors, application/octet-stream')
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-download"]')!.disabled).toBe(true)
    expect(mounted.root.querySelector('[data-testid="asset-acquisition-unavailable"]')!.textContent).toContain('no download source or acquisition contract')
    mounted.unmount()
  })

  it('retries matching, lists complete candidates, and commits one explicit pick', async () => {
    const mounted = unresolvedAssetEditor()
    const candidate = {
      digest: `blake3:${'a'.repeat(64)}`,
      name: 'held-model.safetensors',
      confidence: 'stem' as const,
      held: true,
      virtualPath: 'checkpoints/held-model.safetensors',
      size: 123456,
      mediaType: 'application/x-safetensors',
    }
    mounted.connection.guessAssets.mockResolvedValue([{ query: mounted.ed.initial as string, candidates: [
      { digest: candidate.digest, name: 'incomplete.safetensors', confidence: 'name', held: true },
      candidate,
    ] }])
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-retry-match"]')!.click()
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const row = mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-match-candidate"]')!
    expect(mounted.connection.guessAssets).toHaveBeenCalledWith([mounted.ed.initial])
    expect(mounted.root.querySelectorAll('[data-testid="asset-match-candidate"]')).toHaveLength(1)
    expect(row.textContent).toContain(candidate.name)
    expect(row.textContent).toContain(candidate.virtualPath)
    expect(row.textContent).toContain(String(candidate.size))
    expect(row.textContent).toContain(candidate.digest)
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    row.click()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-apply"]')!.click()
    expect(mounted.dispatchTo).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(mounted.ed.tab, {
      command: 'node.setValue',
      params: {
        graphId: 'g0', nodeId: 'n0', inputId: 'ckpt_name',
        value: {
          digest: candidate.digest,
          name: candidate.name,
          size: candidate.size,
          mediaType: candidate.mediaType,
          virtualPath: candidate.virtualPath,
        },
      },
    })
    mounted.unmount()
  })

  it('keeps the unresolved string untouched on cancel and reports retry transport failures inline', async () => {
    const mounted = unresolvedAssetEditor()
    mounted.connection.guessAssets.mockRejectedValue(new Error('backend unavailable'))
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-retry-match"]')!.click()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(mounted.root.querySelector('[data-testid="asset-match-error"]')!.textContent).toContain('backend unavailable')
    const dialog = mounted.root.querySelector<HTMLDialogElement>('[data-modal="widget-asset"]')!
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    dialog.dispatchEvent(new Event('close'))
    expect(mounted.close).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('stages a retry candidate for a multi-select ASSET and applies one array command', async () => {
    const mounted = unresolvedAssetEditor({}, undefined, {
      kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.MODEL' } },
    })
    const candidate = {
      digest: `blake3:${'c'.repeat(64)}`,
      name: 'held-model.safetensors',
      confidence: 'name' as const,
      held: true,
      virtualPath: 'checkpoints/held-model.safetensors',
      size: 100,
      mediaType: 'application/x-safetensors',
    }
    mounted.connection.guessAssets.mockResolvedValue([{ query: mounted.ed.initial as string, candidates: [candidate] }])
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-retry-match"]')!.click()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-match-candidate"]')!.click()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="asset-apply"]')!.click()
    expect(mounted.dispatchTo).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo.mock.calls[0]?.[1]).toMatchObject({
      command: 'node.setValue', params: { value: [{ digest: candidate.digest, virtualPath: candidate.virtualPath }] },
    })
    mounted.unmount()
  })

  it('uses the product modal, exposes schema-owned metadata, and has no drag or resize affordance', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const close = vi.fn()
    const [open, setOpen] = createSignal(true)
    const ed: WidgetEditorState = {
      tab: {} as Tab,
      graphId: 'g0',
      target: { kind: 'input', nodeId: 'n0', valueKey: 'image' },
      label: 'Reference image',
      spec: {
        widgetType: 'ASSET',
        kind: 'media/image',
        options: { accept: ['image/png', 'image/webp'] },
      },
      declaredType: {
        kind: 'list',
        element: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } },
      },
      multiline: false,
      rect: { x: 20, y: 20, width: 180, height: 24 },
      initial: null,
    }
    const app = {
      backendForTab: () => ({ protocol: 'v1' }),
      dispatchTo: vi.fn(),
      widgetRegistry: { kind: () => undefined },
    } as unknown as AppState
    const unmount = render(() => (
      <Show when={open()}>
        <WidgetEditor
          app={app}
          ed={ed}
          viewport={() => ({ x: 0, y: 0, scale: 1 })}
          onClose={() => { close(); setOpen(false) }}
        />
      </Show>
    ), root)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const dialog = root.querySelector<HTMLDialogElement>('[data-modal="widget-asset"]')!
    expect(dialog.open).toBe(true)
    expect(dialog.getAttribute('aria-label')).toBe('Edit Reference image asset')
    expect(dialog.getAttribute('aria-describedby')).toBe('widget-editor-description')
    const metadata = root.querySelector('[data-testid="asset-schema-metadata"]')!.textContent
    expect(metadata).toContain('Multiple assets')
    expect(metadata).toContain('media/image')
    expect(metadata).toContain('image/png, image/webp')
    expect(metadata).toContain('256 MiB per file')
    expect(root.querySelector('[data-testid="widget-editor-resize-handle"]')).toBeNull()
    expect(root.querySelector('.asset-editor')!.classList.contains('widget-modal-editor')).toBe(true)

    root.querySelector<HTMLButtonElement>('[aria-label="Close Reference image asset editor"]')!.click()
    expect(close).toHaveBeenCalledOnce()
    expect(root.querySelector('[data-modal="widget-asset"]')).toBeNull()
    unmount()
  })

  it('keeps an opaque asset upload on the generic route and 16 MiB limit', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const clickInput = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    let resolveUpload!: (digest: string) => void
    const pendingUpload = new Promise<string>((resolve) => { resolveUpload = resolve })
    const uploadAsset = vi.fn((_body: Blob, _signal?: AbortSignal) => pendingUpload)
    const dispatchTo = vi.fn()
    const close = vi.fn()
    const ed: WidgetEditorState = {
      tab: {} as Tab,
      graphId: 'g0',
      target: { kind: 'input', nodeId: 'n0', valueKey: 'file' },
      label: 'Reference file',
      spec: { widgetType: 'ASSET', options: { accept: ['application/octet-stream'] } },
      declaredType: { kind: 'concrete', name: 'dinkster.asset' },
      multiline: false,
      rect: { x: 20, y: 20, width: 180, height: 24 },
      initial: null,
    }
    const app = {
      backendForTab: () => ({ protocol: 'dinkster', connection: { uploadAsset }, registry: { listCollections: () => [] } }),
      dispatchTo,
      widgetRegistry: { kind: () => undefined },
    } as unknown as AppState
    const unmount = render(() => (
      <WidgetEditor app={app} ed={ed} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={close} />
    ), root)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(root.querySelector('[data-testid="asset-schema-metadata"]')?.textContent).toContain('16 MiB per file')
    const bytes = new Uint8Array([0, 1, 2, 3, 0, 255, 17])
    const file = new File([bytes], 'byte-proof.bin', { type: 'application/octet-stream' })
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!
    const trigger = root.querySelector<HTMLButtonElement>('[data-testid="asset-upload-trigger"]')!
    expect(trigger).not.toBeNull()
    expect(trigger.type).toBe('button')
    expect(trigger.getAttribute('aria-label')).toBe('Upload file')
    expect(trigger.disabled).toBe(false)
    expect(input.hidden).toBe(true)
    expect(input.accept).toBe('application/octet-stream')
    expect(input.multiple).toBe(false)

    trigger.click()
    expect(clickInput).toHaveBeenCalledOnce()
    trigger.blur()
    input.dispatchEvent(new Event('cancel'))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(document.activeElement).toBe(trigger)

    trigger.blur()
    Object.defineProperty(input, 'value', { configurable: true, writable: true, value: 'C:\\fakepath\\byte-proof.bin' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(input.value).toBe('')
    expect(trigger.disabled).toBe(true)
    expect(uploadAsset).toHaveBeenCalledOnce()
    expect(uploadAsset.mock.calls[0]?.[0]).toBe(file)
    expect(new Uint8Array(await (uploadAsset.mock.calls[0]?.[0] as File).arrayBuffer())).toEqual(bytes)
    expect(dispatchTo).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()

    const digest = `blake3:${'d'.repeat(64)}`
    resolveUpload(digest)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    // The upload stages into the selection panel; Apply commits.
    expect(close).not.toHaveBeenCalled()
    expect(dispatchTo).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="asset-selection-summary"]')?.textContent).toContain('byte-proof.bin')
    root.querySelector<HTMLButtonElement>('[data-testid="asset-apply"]')!.click()
    expect(close).toHaveBeenCalledOnce()
    expect(dispatchTo).toHaveBeenCalledOnce()
    expect(dispatchTo).toHaveBeenCalledWith(ed.tab, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n0', inputId: 'file', value: {
        digest,
        name: 'byte-proof.bin',
        size: bytes.length,
        mediaType: 'application/octet-stream',
        virtualPath: '',
      } },
    })
    expect(dispatchTo.mock.invocationCallOrder[0]).toBeGreaterThan(uploadAsset.mock.invocationCallOrder[0]!)
    unmount()
  })

  it('presents latent-specific states and commits the exact classified upload response', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const canonical = {
      digest: `blake3:${'f'.repeat(64)}`,
      name: 'canonical.latent',
      size: 4096,
      mediaType: 'application/x-comfy-latent',
      virtualPath: '',
    }
    const uploadLatentAsset = vi.fn(async () => canonical)
    const uploadAsset = vi.fn()
    const dispatchTo = vi.fn()
    const close = vi.fn()
    const ed: WidgetEditorState = {
      tab: {} as Tab,
      graphId: 'g0',
      target: { kind: 'input', nodeId: 'latent', valueKey: 'samples' },
      label: 'Samples',
      spec: {
        widgetType: 'ASSET',
        kind: 'data/latent',
        options: { accept: ['application/x-comfy-latent'] },
      },
      declaredType: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.LATENT' } },
      multiline: false,
      rect: { x: 20, y: 20, width: 180, height: 24 },
      initial: null,
    }
    const app = {
      backendForTab: () => ({
        protocol: 'dinkster',
        id: 'native',
        connection: {
          listMounts: vi.fn().mockResolvedValue([{ id: 'latents', mode: 'read', state: 'ready', kind: 'data/latent' }]),
          listMountEntries: vi.fn().mockResolvedValue({ entries: [] }),
          uploadAsset,
          uploadLatentAsset,
        },
      }),
      dispatchTo,
      widgetRegistry: { kind: () => undefined },
    } as unknown as AppState
    const unmount = render(() => (
      <WidgetEditor app={app} ed={ed} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={close} />
    ), root)
    await vi.waitFor(() => expect(root.querySelector('[data-testid="collection-search"]')).not.toBeNull())

    const dialog = root.querySelector<HTMLDialogElement>('[data-modal="widget-asset"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Edit Samples latent asset')
    expect(root.querySelector('[data-testid="asset-schema-metadata"]')?.textContent).toContain('Single latent')
    expect(root.querySelector('[data-testid="asset-schema-metadata"]')?.textContent).toContain('1 GiB per file')
    expect(root.querySelector('.asset-browser-section')?.getAttribute('aria-label')).toBe('Latents')
    expect(root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')?.getAttribute('aria-label')).toBe('Search latents')
    expect(root.querySelector<HTMLButtonElement>('[data-testid="asset-upload-trigger"]')?.textContent).toContain('Upload latent')

    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!
    const incompatible = new File([new Uint8Array([1, 2, 3])], 'wrong.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { configurable: true, value: [incompatible] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(root.querySelector('.asset-error')?.textContent).toContain('Unsupported file type: image/png'))
    expect(uploadLatentAsset).not.toHaveBeenCalled()
    expect(dispatchTo).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()

    const file = new File([new Uint8Array([1, 2, 3])], 'chosen.safetensors')
    Object.defineProperty(input, 'value', { configurable: true, writable: true, value: 'C:\\fakepath\\chosen.safetensors' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))

    await vi.waitFor(() => expect(root.querySelector('[data-testid="asset-selection-summary"]')?.textContent).toContain('canonical.latent'))
    expect(uploadAsset).not.toHaveBeenCalled()
    expect(uploadLatentAsset).toHaveBeenCalledWith(file, {
      scope: 'local',
      name: 'chosen.safetensors',
      signal: expect.any(AbortSignal),
    })
    expect(dispatchTo).not.toHaveBeenCalled()
    root.querySelector<HTMLButtonElement>('[data-testid="asset-apply"]')!.click()
    expect(close).toHaveBeenCalledOnce()
    expect(dispatchTo).toHaveBeenCalledWith(ed.tab, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'latent', inputId: 'samples', value: canonical },
    })
    unmount()
  })

  it('renders a selected video from the server asset URL with controls and a download fallback', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const digest = `blake3:${'e'.repeat(64)}`
    const assetUrl = vi.fn((value: string) => `/api/assets/${encodeURIComponent(value)}`)
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL')
    const ed: WidgetEditorState = {
      tab: {} as Tab,
      graphId: 'g0',
      target: { kind: 'input', nodeId: 'video', valueKey: 'video' },
      label: 'Source video',
      spec: { widgetType: 'ASSET', kind: 'media/video', options: { accept: ['video/*'] } },
      declaredType: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.VIDEO' } },
      multiline: false,
      rect: { x: 20, y: 20, width: 180, height: 24 },
      initial: { digest, name: 'clip.webm', size: 4043, mediaType: 'video/webm', virtualPath: 'clip.webm' },
    }
    const app = {
      backendForTab: () => ({ protocol: 'dinkster', id: 'native', connection: {
        assetUrl,
        listMounts: vi.fn().mockResolvedValue([]),
      } }),
      dispatchTo: vi.fn(),
      widgetRegistry: { kind: () => undefined },
    } as unknown as AppState
    const unmount = render(() => <WidgetEditor app={app} ed={ed} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const video = root.querySelector<HTMLVideoElement>('[data-testid="asset-video-preview"]')!
    expect(video).not.toBeNull()
    expect(video.controls).toBe(true)
    expect(video.preload).toBe('metadata')
    expect(video.getAttribute('src')).toBe(`/api/assets/${encodeURIComponent(digest)}`)
    expect(assetUrl).toHaveBeenCalledWith(digest)
    expect(createObjectUrl).not.toHaveBeenCalled()

    video.dispatchEvent(new Event('error'))
    const fallback = root.querySelector<HTMLElement>('[data-testid="asset-video-fallback"]')!
    expect(fallback.textContent).toContain('Video preview unavailable.')
    const download = fallback.querySelector<HTMLAnchorElement>('a')!
    expect(download.getAttribute('href')).toBe(`/api/assets/${encodeURIComponent(digest)}`)
    expect(download.download).toBe('clip.webm')
    unmount()
  })

  it('replaces an undecodable selected image with a semantic download fallback', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const digest = `blake3:${'f'.repeat(64)}`
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image-preview')
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const ed: WidgetEditorState = {
      tab: {} as Tab,
      graphId: 'g0',
      target: { kind: 'input', nodeId: 'image', valueKey: 'image' },
      label: 'Source image',
      spec: { widgetType: 'ASSET', kind: 'media/image', options: { accept: ['image/*'] } },
      declaredType: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } },
      multiline: false,
      rect: { x: 20, y: 20, width: 180, height: 24 },
      initial: { digest, name: 'broken.png', size: 4, mediaType: 'image/png', virtualPath: 'broken.png' },
    }
    const app = {
      backendForTab: () => ({ protocol: 'dinkster', id: 'native', connection: {
        fetchAssetBytes: vi.fn().mockResolvedValue(new Uint8Array([0, 1, 2, 3])),
        listMounts: vi.fn().mockResolvedValue([]),
      } }),
      dispatchTo: vi.fn(),
      widgetRegistry: { kind: () => undefined },
    } as unknown as AppState
    const unmount = render(() => <WidgetEditor app={app} ed={ed} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
    await vi.waitFor(() => expect(root.querySelector<HTMLImageElement>('img[alt="Asset preview"]')).not.toBeNull())

    root.querySelector<HTMLImageElement>('img[alt="Asset preview"]')!.dispatchEvent(new Event('error'))
    const fallback = root.querySelector<HTMLElement>('[data-testid="asset-image-fallback"]')!
    expect(fallback.textContent).toContain('Image preview unavailable.')
    const download = fallback.querySelector<HTMLAnchorElement>('a')!
    expect(download.getAttribute('href')).toBe('blob:image-preview')
    expect(download.download).toBe('broken.png')
    unmount()
    expect(createObjectUrl).toHaveBeenCalledOnce()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:image-preview')
  })

  it('routes a native typed video widget through classified media upload without sourceFilename', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const digest = `blake3:${'f'.repeat(64)}`
    const canonical = {
      digest,
      name: 'large.webm',
      size: 17 * 1024 * 1024,
      mediaType: 'video/webm',
      virtualPath: '',
    }
    let resolveUpload!: (value: typeof canonical) => void
    const uploadMediaAsset = vi.fn<(file: File, options: unknown) => Promise<typeof canonical>>(
      () => new Promise<typeof canonical>((resolve) => { resolveUpload = resolve }),
    )
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:video-upload')
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const dispatchTo = vi.fn()
    const close = vi.fn()
    const ed: WidgetEditorState = {
      tab: {} as Tab,
      graphId: 'g0',
      target: { kind: 'input', nodeId: 'video', valueKey: 'video' },
      label: 'Source video',
      spec: { widgetType: 'ASSET', kind: 'media/video', options: { accept: ['video/*'] } },
      declaredType: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.VIDEO' } },
      multiline: false,
      rect: { x: 20, y: 20, width: 180, height: 24 },
      initial: null,
    }
    const app = {
      backendForTab: () => ({ protocol: 'dinkster', id: 'native', connection: {
        uploadMediaAsset,
        listMounts: vi.fn().mockResolvedValue([]),
      } }),
      dispatchTo,
      widgetRegistry: { kind: () => undefined },
    } as unknown as AppState
    const unmount = render(() => <WidgetEditor app={app} ed={ed} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={close} />, root)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(root.querySelector('[data-testid="asset-schema-metadata"]')?.textContent).toContain('1 GiB per file')
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.accept).toBe('video/*')

    const image = new File(['image'], 'wrong.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { configurable: true, value: [image] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(root.querySelector('.asset-error')?.textContent).toContain('Unsupported file type: image/png'))
    expect(uploadMediaAsset).not.toHaveBeenCalled()

    const oversized = new File(['video'], 'too-large.webm', { type: 'video/webm' })
    Object.defineProperty(oversized, 'size', { configurable: true, value: 1024 * 1024 * 1024 + 1 })
    Object.defineProperty(input, 'files', { configurable: true, value: [oversized] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(root.querySelector('.asset-error')?.textContent).toContain('File exceeds the 1 GiB upload limit'))
    expect(uploadMediaAsset).not.toHaveBeenCalled()

    const file = new File(['webm bytes'], 'large.webm', { type: 'video/webm' })
    Object.defineProperty(file, 'size', { configurable: true, value: canonical.size })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(uploadMediaAsset).toHaveBeenCalledOnce())
    expect(uploadMediaAsset.mock.calls[0]?.[0]).toBe(file)
    expect(uploadMediaAsset.mock.calls[0]?.[1]).toMatchObject({ scope: 'local', kind: 'media/video', name: 'large.webm' })
    const video = root.querySelector<HTMLVideoElement>('[data-testid="asset-video-preview"]')!
    expect(video.getAttribute('src')).toBe('blob:video-upload')
    expect(video.controls).toBe(true)

    resolveUpload(canonical)
    await vi.waitFor(() => expect(root.querySelector('[data-testid="asset-selection-summary"]')?.textContent).toContain('large.webm'))
    expect(close).not.toHaveBeenCalled()
    expect(dispatchTo).not.toHaveBeenCalled()
    root.querySelector<HTMLButtonElement>('[data-testid="asset-apply"]')!.click()
    expect(close).toHaveBeenCalledOnce()
    expect(dispatchTo).toHaveBeenCalledWith(ed.tab, expect.objectContaining({
      command: 'node.setValue', params: expect.objectContaining({ value: canonical }),
    }))
    unmount()
    expect(createObjectUrl).toHaveBeenCalledWith(file)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:video-upload')
  })
})

describe('registered interactive widget expanded-editor integration', () => {
  it.each([
    ['INT', 314],
    ['FLOAT', 3.14],
  ] as const)('focuses and selects the complete %s value when the editor opens', async (type, initial) => {
    const mounted = mountWidget(widgetState(type, {}, initial))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const field = mounted.root.querySelector<HTMLInputElement>('[data-testid="widget-editor"] input')!
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(field.value.length)
    mounted.unmount()
  })

  it('focuses a STRING editor without selecting the complete value', async () => {
    const mounted = mountWidget(widgetState('STRING', {}, 'hello'))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const field = mounted.root.querySelector<HTMLInputElement>('[data-testid="widget-editor"] input')!
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(field.selectionEnd)
    expect([field.selectionStart, field.selectionEnd]).not.toEqual([0, field.value.length])
    mounted.unmount()
  })

  it('preserves the pre-existing COLOR select-all behavior', async () => {
    const mounted = mountWidget(widgetState('COLOR', {}, '#123456'))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const field = mounted.root.querySelector<HTMLInputElement>('[data-testid="color-text"]')!
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(field.value.length)
    mounted.unmount()
  })

  it('replaces a freshly opened INT value when text is inserted', async () => {
    const mounted = mountWidget(widgetState('INT', {}, 314))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const field = mounted.root.querySelector<HTMLInputElement>('[data-testid="widget-editor"] input')!
    field.setRangeText('8', field.selectionStart!, field.selectionEnd!, 'end')
    field.dispatchEvent(new InputEvent('input', { bubbles: true, data: '8', inputType: 'insertText' }))
    expect(field.value).toBe('8')
    mounted.unmount()
  })

  it('leaves ArrowRight unprevented for native caret handling', async () => {
    const mounted = mountWidget(widgetState('INT', {}, 314))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const field = mounted.root.querySelector<HTMLInputElement>('[data-testid="widget-editor"] input')!
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length])
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    expect(field.dispatchEvent(arrow)).toBe(true)
    expect(arrow.defaultPrevented).toBe(false)
    mounted.unmount()
  })

  it.each([
    ['STRING', {}, 'hello', false, 'widget-editor'],
    ['INT', { min: 0, max: 10, step: 1 }, 3, false, 'widget-editor'],
    ['FLOAT', { min: 0, max: 1, step: 0.1 }, 0.5, false, 'widget-editor'],
    ['COLOR', {}, '#123456', false, 'color-editor'],
    ['COMBO', { options: ['one', 'two'] }, 'one', false, 'combo-dropdown'],
    ['SAVE_TARGET', { suffix: '.png' }, { mount: 'output', prefix: 'images/test' }, false, 'save-target-editor'],
  ] as const)('renders %s as a non-modal anchored popover', async (type, options, initial, multiline, testId) => {
    const mounted = mountWidget(widgetState(type, options, initial, multiline))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const editor = mounted.root.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!
    expect(editor.getAttribute('role')).toBe('dialog')
    expect(editor.getAttribute('data-editor-surface')).toBe('popover')
    expect(editor.getAttribute('aria-label')).toBe(`Edit ${type} value ${type}`)
    expect(editor.classList.contains('floating-surface')).toBe(true)
    expect(mounted.root.querySelector('[data-testid="widget-modal-surface"]')).toBeNull()
    expect(mounted.root.querySelector('[data-testid="widget-editor-resize-handle"]')).toBeNull()
    mounted.unmount()
  })

  it('renders multiline node input STRING as a live in-node editor', async () => {
    const mounted = mountWidget({
      ...widgetState('STRING', { multiline: true }, 'hello\nworld', true),
      rect: { x: 20, y: 30, width: 180, height: 76 },
    })
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const editor = mounted.root.querySelector<HTMLElement>('[data-testid="widget-editor"]')!
    const textarea = editor.querySelector('textarea')!
    expect(editor.getAttribute('data-editor-surface')).toBe('in-node')
    expect(editor.getAttribute('data-editor-target')).toBe('input')
    expect(editor.classList.contains('widget-editor-popover')).toBe(false)
    expect(editor.style.left).toBe('20px')
    expect(editor.style.top).toBe('30px')
    expect(editor.style.width).toBe('180px')
    expect(editor.style.height).toBe('76px')
    expect(editor.style.padding).toBe('2px 0px')
    expect(editor.querySelector<HTMLElement>('.widget-editor-in-node-label')?.style.width).toBe('100%')
    expect(editor.querySelector<HTMLElement>('.widget-editor-in-node-label')?.style.height).toBe('18px')
    expect(textarea.value).toBe('hello\nworld')
    expect(textarea.style.width).toBe('calc(100% - 2px)')
    expect(textarea.style.scrollbarGutter).toBe('stable')
    expect(textarea.style.getPropertyValue('--multiline-scrollbar-width')).toBe('6px')
    expect(mounted.dispatchTo).not.toHaveBeenCalled()

    mounted.setViewport({ x: 5, y: 7, scale: 1.5 })
    expect(editor.style.left).toBe('35px')
    expect(editor.style.top).toBe('52px')
    expect(editor.style.width).toBe('270px')
    expect(editor.style.height).toBe('114px')
    expect(textarea.style.fontSize).toBe('21px')
    expect(textarea.style.lineHeight).toBe('30px')
    expect(textarea.style.padding).toBe('9px')
    expect(editor.querySelector<HTMLElement>('.widget-editor-in-node-label')?.style.height).toBe('27px')
    expect(textarea.style.width).toBe('calc(100% - 3px)')
    expect(textarea.style.getPropertyValue('--multiline-scrollbar-width')).toBe('9px')
    mounted.unmount()
  })

  it('keeps value-source multiline STRING and raw JSON fallback in popovers', async () => {
    const valueSource = mountWidget({
      ...widgetState('STRING', { multiline: true }, 'hello\nworld', true),
      target: { kind: 'valueSource', valueSourceId: 'v0' },
    })
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(valueSource.root.querySelector('[data-testid="widget-editor"]')?.getAttribute('data-editor-surface')).toBe('popover')
    valueSource.unmount()

    const raw = mountWidget({
      ...widgetState('JSON', {}, '{"stored":true}', true),
      target: { kind: 'valueSource', valueSourceId: 'v0' },
      spec: undefined,
    })
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(raw.root.querySelector('[data-testid="widget-editor"]')?.getAttribute('data-editor-surface')).toBe('popover')
    raw.unmount()
  })

  it('commits multiline node input on blur, commits on Ctrl+Enter, and never mutates on cancel', async () => {
    const unchanged = mountWidget(widgetState('STRING', { multiline: true }, 'old', true))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    unchanged.root.querySelector<HTMLTextAreaElement>('textarea')!.dispatchEvent(new FocusEvent('blur'))
    expect(unchanged.close).toHaveBeenCalledOnce()
    expect(unchanged.dispatchTo).not.toHaveBeenCalled()

    const blurred = mountWidget(widgetState('STRING', { multiline: true }, 'old', true))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const blurField = blurred.root.querySelector<HTMLTextAreaElement>('textarea')!
    blurField.value = 'blurred\nvalue'
    blurField.dispatchEvent(new FocusEvent('blur'))
    expect(blurred.dispatchTo).toHaveBeenCalledWith(expect.anything(), {
      command: 'text.splice',
      params: { graphId: 'g0', nodeId: 'n0', inputId: 'string', offset: 0, deleteCount: 3, insert: 'blurred\nvalue' },
    })

    const entered = mountWidget(widgetState('STRING', { multiline: true }, 'old', true))
    const enterField = entered.root.querySelector<HTMLTextAreaElement>('textarea')!
    enterField.value = 'entered\nvalue'
    enterField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    expect(entered.dispatchTo).toHaveBeenCalledWith(expect.anything(), {
      command: 'text.splice',
      params: { graphId: 'g0', nodeId: 'n0', inputId: 'string', offset: 0, deleteCount: 3, insert: 'entered\nvalue' },
    })

    const cancelled = mountWidget(widgetState('STRING', { multiline: true }, 'old', true))
    const cancelField = cancelled.root.querySelector<HTMLTextAreaElement>('textarea')!
    cancelField.value = 'discard me'
    cancelled.unmount()
    expect(cancelled.dispatchTo).not.toHaveBeenCalled()
  })

  it('rebases a multiline STRING commit over a stored remote edit', async () => {
    const ed = widgetState('STRING', { multiline: true }, 'hello world', true)
    const mounted = mountWidget(ed)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const values = ed.tab.store.doc.graphs['g0']!.nodes['n0']!.values as Record<string, unknown>
    values['string'] = 'remote hello world'
    const field = mounted.root.querySelector<HTMLTextAreaElement>('textarea')!
    field.value = 'hello brave world'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    expect(mounted.dispatchTo).toHaveBeenCalledWith(ed.tab, {
      command: 'text.splice',
      params: {
        graphId: 'g0',
        nodeId: 'n0',
        inputId: 'string',
        offset: 13,
        deleteCount: 0,
        insert: 'brave ',
      },
    })
  })

  it('falls back to node.setValue when a multiline STRING stored value is no longer text', async () => {
    const ed = widgetState('STRING', { multiline: true }, 'hello world', true)
    const mounted = mountWidget(ed)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const values = ed.tab.store.doc.graphs['g0']!.nodes['n0']!.values as Record<string, unknown>
    values['string'] = null
    const field = mounted.root.querySelector<HTMLTextAreaElement>('textarea')!
    field.value = 'hello brave world'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    expect(mounted.dispatchTo).toHaveBeenCalledWith(ed.tab, {
      command: 'node.setValue',
      params: {
        graphId: 'g0',
        nodeId: 'n0',
        inputId: 'string',
        value: 'hello brave world',
      },
    })
  })

  it.each([
    ['INT', 'after_generate', { min: 0, max: 10, step: 1 }, 3],
    ['COMBO', 'after_refresh', { options: ['one', 'two'] }, 'one'],
  ] as const)('keeps the compact controller menu as the only %s controller surface', (type, controller, options, initial) => {
    const state = widgetState(type, options, initial)
    const mounted = mountWidget({ ...state, spec: { ...state.spec!, controller } })
    expect(mounted.root.querySelector('[data-testid="widget-editor-controller"]')).toBeNull()
    expect(mounted.root.querySelector('.widget-editor-controller')).toBeNull()
    mounted.unmount()
  })

  it('moves focus from the COLOR field to Cancel and discards the draft on click', async () => {
    const mounted = mountWidget(widgetState('COLOR', {}, '#123456'))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const field = mounted.root.querySelector<HTMLInputElement>('[data-testid="color-text"]')!
    field.value = '#abcdef'
    field.dispatchEvent(new InputEvent('input', { bubbles: true }))
    field.focus()
    const cancelButton = mounted.root.querySelector<HTMLButtonElement>('.color-editor-footer button')!
    cancelButton.focus()
    expect(document.activeElement).toBe(cancelButton)
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    cancelButton.click()
    expect(mounted.close).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
  })

  it('does not commit numeric edits on blur or Cancel, but Enter still validates and commits', async () => {
    const cancelled = mountWidget(widgetState('INT', { min: 0, max: 10, step: 1 }, 3))
    expect(cancelled.root.querySelector('[data-testid="widget-editor-meta"]')?.textContent).toContain('Minimum0')
    expect(cancelled.root.querySelector('[data-testid="widget-editor-meta"]')?.textContent).toContain('Maximum10')
    expect(cancelled.root.querySelector('[data-testid="widget-editor-meta"]')?.textContent).toContain('Step1')
    const field = cancelled.root.querySelector<HTMLInputElement>('[data-testid="widget-editor"] input')!
    field.value = '7'
    field.dispatchEvent(new InputEvent('input', { bubbles: true }))
    field.blur()
    expect(cancelled.dispatchTo).not.toHaveBeenCalled()
    cancelled.root.querySelector<HTMLButtonElement>('[data-testid="widget-editor-cancel"]')!.click()
    expect(cancelled.dispatchTo).not.toHaveBeenCalled()

    const committed = mountWidget(widgetState('INT', { min: 0, max: 10, step: 1 }, 3))
    const commitField = committed.root.querySelector<HTMLInputElement>('[data-testid="widget-editor"] input')!
    commitField.value = '8'
    commitField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(committed.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: 'node.setValue',
      params: expect.objectContaining({ value: 8 }),
    }))
  })

  it('commits a valid changed popover value on click-away exactly once', () => {
    const mounted = mountWidget(widgetState('INT', { min: 0, max: 10, step: 1 }, 3))
    const field = mounted.root.querySelector<HTMLInputElement>('[data-testid="widget-editor"] input')!
    field.value = '7'
    mounted.clickAway()

    expect(mounted.close).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: 'node.setValue',
      params: expect.objectContaining({ value: 7 }),
    }))

    field.dispatchEvent(new FocusEvent('blur'))
    mounted.clickAway()
    expect(mounted.dispatchTo).toHaveBeenCalledOnce()
  })

  it.each([
    ['unchanged', '3'],
    ['invalid', 'not-a-number'],
    ['rounded to the stored value', '3.4'],
  ] as const)('closes %s popover text on click-away without a write', (_case, draft) => {
    const mounted = mountWidget(widgetState('INT', { min: 0, max: 10, step: 1 }, 3))
    mounted.root.querySelector<HTMLInputElement>('[data-testid="widget-editor"] input')!.value = draft
    mounted.clickAway()

    expect(mounted.close).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
  })

  it('does not write normalized FLOAT or raw JSON values equal to the stored value', () => {
    const float = mountWidget(widgetState('FLOAT', { min: 0, max: 3, step: 1 }, 3))
    float.root.querySelector<HTMLInputElement>('[data-testid="widget-editor"] input')!.value = '10'
    float.clickAway()
    expect(float.close).toHaveBeenCalledOnce()
    expect(float.dispatchTo).not.toHaveBeenCalled()

    const rawState = { ...widgetState('JSON', {}, '{\n  "stored": true\n}', true), spec: undefined }
    const raw = mountWidget({ ...rawState, target: { kind: 'valueSource', valueSourceId: 'v0' } })
    raw.root.querySelector<HTMLTextAreaElement>('textarea')!.value = '{"stored":true}'
    raw.clickAway()
    expect(raw.close).toHaveBeenCalledOnce()
    expect(raw.dispatchTo).not.toHaveBeenCalled()
  })

  it('closes value-source multiline STRING on click-away without committing its draft', () => {
    const state = widgetState('STRING', { multiline: true }, 'stored', true)
    const mounted = mountWidget({ ...state, target: { kind: 'valueSource', valueSourceId: 'v0' } })
    mounted.root.querySelector<HTMLTextAreaElement>('textarea')!.value = 'draft'
    mounted.clickAway()
    expect(mounted.close).toHaveBeenCalledOnce()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
  })

  it('applies click-away commit-or-drop semantics to COLOR, SAVE_TARGET, and raw JSON', async () => {
    const color = mountWidget(widgetState('COLOR', {}, '#123456'))
    const colorField = color.root.querySelector<HTMLInputElement>('[data-testid="color-text"]')!
    colorField.value = '#abcdef'
    colorField.dispatchEvent(new InputEvent('input', { bubbles: true }))
    color.clickAway()
    expect(color.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      params: expect.objectContaining({ value: '#abcdef' }),
    }))

    const invalidColor = mountWidget(widgetState('COLOR', {}, '#123456'))
    const invalidColorField = invalidColor.root.querySelector<HTMLInputElement>('[data-testid="color-text"]')!
    invalidColorField.value = 'invalid'
    invalidColorField.dispatchEvent(new InputEvent('input', { bubbles: true }))
    invalidColor.clickAway()
    expect(invalidColor.close).toHaveBeenCalledOnce()
    expect(invalidColor.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      params: expect.objectContaining({ value: 'invalid' }),
    }))

    const saveTarget = mountWidget(widgetState('SAVE_TARGET', { suffix: '.png' }, { mount: 'output', prefix: 'old' }))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const prefix = saveTarget.root.querySelector<HTMLInputElement>('[data-testid="save-target-prefix"]')!
    prefix.value = 'new/path'
    prefix.dispatchEvent(new InputEvent('input', { bubbles: true }))
    saveTarget.clickAway()
    expect(saveTarget.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      params: expect.objectContaining({ value: { mount: 'output', prefix: 'new/path' } }),
    }))

    const rawState = { ...widgetState('JSON', {}, '{"stored":true}', true), spec: undefined }
    const raw = mountWidget({ ...rawState, target: { kind: 'valueSource', valueSourceId: 'v0' } })
    const rawField = raw.root.querySelector<HTMLTextAreaElement>('textarea')!
    rawField.value = '{"stored":false}'
    raw.clickAway()
    expect(raw.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      params: expect.objectContaining({ value: { stored: false } }),
    }))
  })

  it('shows truthful unbounded limits and the effective default FLOAT step', () => {
    const mounted = mountWidget(widgetState('FLOAT', {}, 3.5))
    const constraints = mounted.root.querySelector('[data-testid="widget-numeric-constraints"]')!
    expect(constraints.getAttribute('aria-label')).toBe('Numeric constraints')
    expect(constraints.textContent).toContain('Minimumunbounded')
    expect(constraints.textContent).toContain('Maximumunbounded')
    expect(constraints.textContent).toContain('Step0.1 (default)')
  })

  it('keeps a composing Escape inside the editor without closing or committing', () => {
    const mounted = mountWidget(widgetState('STRING', {}, 'old'))
    const field = mounted.root.querySelector<HTMLInputElement>('[data-testid="widget-editor"] input')!
    field.value = 'composing draft'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))
    expect(mounted.close).not.toHaveBeenCalled()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
  })

  it.each([
    ['INT', { min: 0, max: 4, step: 3 }, 2, '4', 4],
    ['FLOAT', { min: 0, max: 0.3, step: 0.1 }, 0.2, '0.27', 0.27],
  ] as const)('keeps compact stepping out of the optional %s popover and commits exact text explicitly', (type, options, initial, draft, committedValue) => {
    const mounted = mountWidget(widgetState(type, options, initial))
    const field = mounted.root.querySelector<HTMLInputElement>('[data-testid="widget-editor"] input')!
    expect(mounted.root.querySelector('[data-testid="widget-editor-step-controls"]')).toBeNull()
    expect(mounted.root.querySelector('[data-testid="widget-editor-decrease"]')).toBeNull()
    expect(mounted.root.querySelector('[data-testid="widget-editor-increase"]')).toBeNull()
    field.value = draft
    field.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="widget-editor-commit"]')!.click()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: 'node.setValue',
      params: expect.objectContaining({ value: committedValue }),
    }))
  })

  it('keeps STRING Ctrl+Enter, exact COLOR strings, and COMBO keyboard selection semantics', () => {
    const string = mountWidget(widgetState('STRING', { multiline: true }, 'old', true))
    expect(string.root.querySelector('[data-testid="widget-editor"]')?.getAttribute('data-editor-surface')).toBe('in-node')
    const textarea = string.root.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = 'new\nvalue'
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    expect(string.dispatchTo).toHaveBeenCalledWith(expect.anything(), {
      command: 'text.splice',
      params: { graphId: 'g0', nodeId: 'n0', inputId: 'string', offset: 0, deleteCount: 3, insert: 'new\nvalue' },
    })

    const color = mountWidget(widgetState('COLOR', {}, '#123456'))
    const colorField = color.root.querySelector<HTMLInputElement>('[data-testid="color-text"]')!
    colorField.value = 'not-a-color'
    colorField.dispatchEvent(new InputEvent('input', { bubbles: true }))
    colorField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(color.root.querySelector('[data-testid="color-error"]')).toBeNull()
    expect(color.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      params: expect.objectContaining({ value: 'not-a-color' }),
    }))

    const combo = mountWidget(widgetState('COMBO', { options: ['one', 'two'] }, 'one'))
    expect([...combo.root.querySelectorAll('.combo-option')].map((row) => row.textContent)).toEqual(['one', 'two'])
    const search = combo.root.querySelector<HTMLInputElement>('[data-testid="combo-search"]')!
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(combo.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      params: expect.objectContaining({ value: 'two' }),
    }))
  })

  it('retains SAVE_TARGET constraints and commits only a valid structured target', async () => {
    const state = widgetState('SAVE_TARGET', { suffix: '.png' }, { mount: 'output', prefix: 'images/test' })
    const mounted = mountWidget({ ...state, declaredType: { kind: 'concrete', name: 'dinkster.save_target' } })
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(mounted.root.querySelector('[data-testid="widget-editor-type"]')?.textContent).toBe('dinkster.save_target')
    expect(mounted.root.querySelector('[data-testid="save-target-output-format"]')?.textContent).toBe('.png')
    expect(mounted.root.querySelector('[data-testid="save-target-suffix"]')?.textContent).toBe('.png')
    const mount = mounted.root.querySelector<HTMLButtonElement>('[data-testid="save-target-mount"]')!
    expect(mount.getAttribute('role')).toBe('combobox')
    mount.click()
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!
    expect(listbox).not.toBeNull()
    listbox.querySelector<HTMLElement>('[role="option"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
    expect(mounted.root.querySelector('[data-testid="save-target-editor"]')).not.toBeNull()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    mount.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.activeElement).toBe(mount)
    const prefix = mounted.root.querySelector<HTMLInputElement>('[data-testid="save-target-prefix"]')!
    prefix.value = '../bad'
    prefix.dispatchEvent(new InputEvent('input', { bubbles: true }))
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="save-target-save"]')!.click()
    expect(mounted.root.querySelector('[data-testid="save-target-error"]')).not.toBeNull()
    expect(mounted.dispatchTo).not.toHaveBeenCalled()
    prefix.value = 'images/good'
    prefix.dispatchEvent(new InputEvent('input', { bubbles: true }))
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="save-target-save"]')!.click()
    expect(mounted.dispatchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      params: expect.objectContaining({ value: { mount: 'output', prefix: 'images/good' } }),
    }))
  })
})

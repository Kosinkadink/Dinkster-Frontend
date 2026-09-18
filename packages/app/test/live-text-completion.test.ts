import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppState, type Backend, type Tab } from '../src/app-state.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

let app: AppState
let tab: Tab

beforeEach(() => {
  app = new AppState()
  tab = app.tabs.get()[0]!
})

const addBackend = (): Backend => {
  const backend = app.addBackend('http://selected:8000', 'Selected', false, 'dinkster')
  if (backend === undefined) throw new Error('backend rejected')
  return backend
}

describe('live prompt inventory scope', () => {
  it('loads from the active tab selected backend rather than the default backend', async () => {
    const selected = addBackend()
    app.setTabTarget(tab.id, selected.id)
    const defaultChoices = vi.spyOn(app.scopedClient, 'remoteChoices')
    const selectedChoices = vi.spyOn(selected.scopedClient, 'remoteChoices').mockResolvedValue(['portrait'])
    const controller = new AbortController()

    const request = app.liveEmbeddingAndLoraInventory.load({
      text: '<lora:p', caret: 7, signal: controller.signal,
    })

    expect(request?.loading.scopeId).toBe(JSON.stringify([tab.id, selected.id]))
    await expect(request?.settled).resolves.toMatchObject({ status: 'ready' })
    expect(selectedChoices).toHaveBeenCalledWith('/api/choices/comfy.files.loras', {
      signal: controller.signal,
    })
    expect(defaultChoices).not.toHaveBeenCalled()
  })

  it('refuses a result after the active tab changes', async () => {
    let resolve!: (names: readonly string[]) => void
    vi.spyOn(app.scopedClient, 'remoteChoices').mockImplementation(
      () => new Promise<readonly string[]>((done) => { resolve = done }),
    )
    const settled = app.liveEmbeddingAndLoraInventory.load({
      text: 'embedding:c', caret: 11, signal: new AbortController().signal,
    })!.settled

    app.createWorkflow()
    resolve(['cats'])

    await expect(settled).resolves.toBeUndefined()
  })

  it('refuses a result after the active tab target backend changes', async () => {
    const selected = addBackend()
    app.setTabTarget(tab.id, selected.id)
    let resolve!: (names: readonly string[]) => void
    vi.spyOn(selected.scopedClient, 'remoteChoices').mockImplementation(
      () => new Promise<readonly string[]>((done) => { resolve = done }),
    )
    const settled = app.liveEmbeddingAndLoraInventory.load({
      text: 'embedding:c', caret: 11, signal: new AbortController().signal,
    })!.settled

    app.setTabTarget(tab.id, app.backends.get()[0]!.id)
    resolve(['cats'])

    await expect(settled).resolves.toBeUndefined()
  })
})

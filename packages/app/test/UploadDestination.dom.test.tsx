import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UploadDestination } from '../src/UploadDestination.js'
import { readUploadDestination, saveUploadDestination, type UploadDestinationChoice } from '../src/upload-destination.js'

afterEach(() => { document.body.replaceChildren(); localStorage.clear() })

describe('import destination', () => {
  it('changes future imports only after explicit Remember, independently per backend and project', () => {
    const choice = { mount: 'plates', folder: 'scene-a', remember: false }
    expect(readUploadDestination('server-a', 'alpha', localStorage)).toEqual({ remember: false })
    saveUploadDestination('server-a', 'alpha', choice, localStorage)
    expect(readUploadDestination('server-a', 'alpha', localStorage)).toEqual({ remember: false })
    saveUploadDestination('server-a', 'alpha', { ...choice, remember: true }, localStorage)
    expect(readUploadDestination('server-a', 'alpha', localStorage)).toEqual({ ...choice, remember: true })
    expect(readUploadDestination('server-a', 'beta', localStorage)).toEqual({ remember: false })
    expect(readUploadDestination('server-b', 'alpha', localStorage)).toEqual({ remember: false })
    saveUploadDestination('server-a', 'alpha', { mount: 'one-off', remember: false }, localStorage)
    expect(readUploadDestination('server-a', 'alpha', localStorage)).toEqual({ ...choice, remember: true })
    saveUploadDestination('server-a', 'alpha', { remember: true }, localStorage)
    expect(readUploadDestination('server-a', 'alpha', localStorage)).toEqual({ mount: '', folder: '', remember: true })
  })

  it.each(['capture', null, undefined, 'revoked', 'readonly', 'outside-project'])('shows only the advertised active writable standard import root (%s)', async (importMount) => {
    const mount = (id: string, mode: 'read' | 'readwrite' = 'readwrite') => ({ id, mode, state: 'ready', path: `/live/${id}` })
    const connection = {
      onMountsChanged: () => () => {},
      fetchMountSettings: async () => ({ mountChangesAllowed: false, outputMount: 'renders', mounts: [mount('capture'), mount('imports'), mount('renders'), mount('revoked'), mount('readonly', 'read')] }),
      fetchMountLocations: async () => ({ importMount, mounts: [{ id: 'capture', path: '/configured/NOT-ACTIVE' }], activeMounts: [mount('capture'), mount('imports'), mount('renders'), mount('readonly', 'read'), mount('outside-project')] }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <UploadDestination connection={connection} machine="Studio machine" value={{ remember: false }} onChange={() => {}} />, root)
    try {
      if (importMount === 'capture') await vi.waitFor(() => expect(root.textContent).toContain('Destination root: /live/capture'))
      else await vi.waitFor(() => expect(root.textContent).toContain('standard import destination is unavailable or not advertised'))
      expect(root.textContent).not.toContain('/configured/NOT-ACTIVE')
      expect(root.textContent).not.toContain('Destination root: /live/imports')
      expect(root.textContent).not.toContain('Destination root: /live/renders')
      expect(root.textContent).not.toContain('Destination root: /live/readonly')
      expect(root.textContent).not.toContain('Destination root: /live/outside-project')
    } finally { dispose() }
  })

  it('offers only active writable project members, not configured paths or the selected output', async () => {
    const mount = (id: string, mode: 'read' | 'readwrite' = 'readwrite') => ({ id, mode, state: 'ready', path: `/active/${id}` })
    const connection = {
      onMountsChanged: () => () => {},
      fetchMountSettings: async () => ({ mountChangesAllowed: false, restartRequired: true, outputMount: 'output', mounts: [mount('plates'), mount('pending'), mount('readonly', 'read')] }),
      fetchMountLocations: async () => ({ mounts: [{ id: 'plates', path: '/configured/NOT-ACTIVE' }], activeMounts: [mount('plates'), mount('other-project'), mount('readonly', 'read')] }),
    }
    const [value, setValue] = createSignal<UploadDestinationChoice>({ remember: false })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <UploadDestination connection={connection} machine="Studio machine" value={value()} onChange={setValue} />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('Only active writable project folders'))
      root.querySelector<HTMLButtonElement>('[data-testid="upload-destination-mount"]')!.click()
      expect([...document.querySelectorAll('[data-option-id]')].map((item) => item.getAttribute('data-option-id'))).toEqual(['', 'plates'])
      document.querySelector<HTMLElement>('[data-option-id="plates"]')!.click()
      expect(root.textContent).toContain('/active/plates')
      expect(root.textContent).not.toContain('/configured/NOT-ACTIVE')
      expect(value()).toEqual({ mount: 'plates', folder: '', remember: false })
      root.querySelector<HTMLButtonElement>('[data-testid="upload-destination-remember"]')!.click()
      expect(value().remember).toBe(true)
      expect(localStorage.length).toBe(0)
      expect(root.textContent).toContain('Studio machine')
    } finally { dispose() }
  })
})

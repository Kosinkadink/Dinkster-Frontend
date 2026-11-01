import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetFileLocation } from '../src/AssetFileLocation.js'
import { MountFolderForm } from '../src/MountFolderForm.js'
import { desktopBridge, desktopFileBridge, resolveDroppedAsset, type DinksterDesktopBridge } from '../src/desktop-bridge.js'

const digest = `blake3:${'a'.repeat(64)}`
afterEach(() => { delete window.dinksterDesktop; document.body.replaceChildren(); vi.restoreAllMocks() })

describe('exact asset location actions', () => {
  it('detects native files independently while preserving the full lifecycle bridge', () => {
    expect(desktopBridge()).toBeUndefined()
    expect(desktopFileBridge()).toBeUndefined()
    const files = {
      fileCapabilities: async () => ({ nativeFolderChoice: true, reveal: true }),
      chooseDirectory: async () => undefined,
    }
    window.dinksterDesktop = files
    expect(desktopBridge()).toBeUndefined()
    expect(desktopFileBridge()).toBe(files)
    for (const lifecycle of [{ locale: async () => 'en' }, { status: async () => ({ phase: 'running' }) }, { locale: 'en', status: 'running' }]) {
      window.dinksterDesktop = { ...files, ...lifecycle } as unknown as DinksterDesktopBridge
      expect(desktopBridge()).toBeUndefined()
    }
    const full = { ...files, locale: async () => 'en', status: async () => ({ phase: 'running', detail: '' }) } as unknown as DinksterDesktopBridge
    window.dinksterDesktop = full
    expect(desktopBridge()).toBe(full)
    expect(desktopFileBridge()).toBe(full)
  })

  it('offers native folder choice with only the file bridge', async () => {
    const chooseDirectory = vi.fn(async () => '/native/models')
    window.dinksterDesktop = { fileCapabilities: async () => ({ nativeFolderChoice: true, reveal: false }), chooseDirectory }
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <MountFolderForm connection={{ addMount: vi.fn() }} backendUrl="" />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('Choose folder'))
      ;[...root.querySelectorAll('button')].find((button) => button.textContent === 'Choose folder')!.click()
      await vi.waitFor(() => expect(root.textContent).toContain('/native/models'))
      expect(chooseDirectory).toHaveBeenCalledWith(`${window.location.origin}/`)
      expect(desktopBridge()).toBeUndefined()
    } finally { dispose() }
  })

  it.each([undefined, false])('does not send a File when resolvePath is %s and fails closed on capability errors', async (resolvePath) => {
    const resolveDroppedFile = vi.fn()
    const file = new File(['original'], 'original.png', { type: 'image/png' })
    window.dinksterDesktop = { fileCapabilities: async () => ({ nativeFolderChoice: true, reveal: false, resolvePath }), resolveDroppedFile } as unknown as DinksterDesktopBridge
    expect(await resolveDroppedAsset('http://remote.test', file, () => true)).toBeUndefined()
    expect(resolveDroppedFile).not.toHaveBeenCalled()
    window.dinksterDesktop.fileCapabilities = async () => { throw new Error('/private/path') }
    await expect(resolveDroppedAsset('', file, () => true)).rejects.toThrow('Could not resolve the existing file. Nothing was uploaded.')
    expect(resolveDroppedFile).not.toHaveBeenCalled()
  })

  it('resolves the original File with resolvePath even when native folder choice is unavailable', async () => {
    const file = new File(['original'], 'original.png', { type: 'image/png' })
    const asset = { digest, name: 'original.png', size: 0, mediaType: 'image/png', virtualPath: 'mounts/input/nested/original.png' }
    const resolveDroppedFile = vi.fn().mockResolvedValue({ status: 'resolved', asset })
    window.dinksterDesktop = { fileCapabilities: async () => ({ nativeFolderChoice: false, reveal: false, resolvePath: true }), resolveDroppedFile } as unknown as DinksterDesktopBridge
    expect(await resolveDroppedAsset('', file, () => true)).toEqual(asset)
    expect(resolveDroppedFile).toHaveBeenCalledWith(`${window.location.origin}/`, file)
  })

  it.each(['/imports/scene-2.png', '/vault/aa/asset'])('reveals identity, not operator path %s, and preserves copy after a rejection', async (path) => {
    const revealFile = vi.fn().mockRejectedValue(new Error('Project authorization changed'))
    window.dinksterDesktop = { fileCapabilities: async () => ({ nativeFolderChoice: false, reveal: true }), revealFile } as unknown as DinksterDesktopBridge
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    let current = true
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetFileLocation connection={{ fetchAssetLocations: async () => [path] }} backendUrl="" digest={digest} project="p-film" isCurrent={() => current} />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('Show file on this computer'))
      ;[...root.querySelectorAll('button')].find((b) => b.textContent === 'Show file on this computer')!.click()
      await vi.waitFor(() => expect(root.textContent).toContain('Project authorization changed'))
      expect(revealFile).toHaveBeenCalledWith(`${window.location.origin}/`, { digest, scope: 'local', project: 'p-film' })
      ;[...root.querySelectorAll('button')].find((b) => b.textContent === 'Copy server path')!.click()
      await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(path))
      current = false
      ;[...root.querySelectorAll('button')].find((b) => b.textContent === 'Show file on this computer')!.click()
      expect(revealFile).toHaveBeenCalledTimes(1)
    } finally { dispose() }
  })

  it.each(['absent', 'denied', 'error'])('keeps copy without invoking native reveal when capability is %s', async (capability) => {
    const revealFile = vi.fn()
    window.dinksterDesktop = {
      ...(capability === 'absent' ? {} : { fileCapabilities: async () => {
        if (capability === 'error') throw new Error('Unsupported runtime')
        return { nativeFolderChoice: true, reveal: false }
      } }), revealFile,
    } as unknown as DinksterDesktopBridge
    const root = document.createElement('div')
    const dispose = render(() => <AssetFileLocation connection={{ fetchAssetLocations: async () => ['/server/only'] }} backendUrl="http://remote.test:3639" digest={digest} project="default" />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('Copy server path'))
      expect(root.textContent).not.toContain('Show file on this computer')
      expect(revealFile).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('discards old capabilities and paths when connection or asset identity changes', async () => {
    let finish!: (value: { nativeFolderChoice: boolean; reveal: boolean }) => void
    let paths!: (value: readonly string[]) => void
    window.dinksterDesktop = { fileCapabilities: () => new Promise((resolve) => { finish = resolve }), revealFile: vi.fn() } as unknown as DinksterDesktopBridge
    const [connection, setConnection] = createSignal({ fetchAssetLocations: () => new Promise<readonly string[]>((resolve) => { paths = resolve }) })
    const root = document.createElement('div')
    const dispose = render(() => <AssetFileLocation connection={connection()} backendUrl="" digest={digest} project="default" />, root)
    try {
      const oldCapability = finish
      setConnection({ fetchAssetLocations: async () => ['/new-server/current'] })
      await vi.waitFor(() => expect(root.textContent).toContain('/new-server/current'))
      oldCapability({ nativeFolderChoice: true, reveal: true })
      paths(['/old-server/stale'])
      await Promise.resolve()
      expect(root.textContent).not.toContain('Show file on this computer')
      expect(root.textContent).not.toContain('/old-server/stale')
    } finally { dispose() }
  })
})

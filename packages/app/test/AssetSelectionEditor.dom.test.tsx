import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import type { AssetSelectionOption } from '@dinkster/client'
import { AssetSelectionEditor } from '../src/editors/AssetSelectionEditor.js'

afterEach(() => document.body.replaceChildren())

it('stages exact names, searches, cancels, and commits only currently granted options', async () => {
  let options: readonly AssetSelectionOption[] = [
    { name: 'vendor/vae.safetensors', shape: 'file' }, { name: 'taesd', shape: 'pair' },
    { name: 'pixel_space', shape: 'literal' },
  ]
  const connection = { listAssetSelections: vi.fn(async () => options) }
  const commit = vi.fn()
  const close = vi.fn()
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <AssetSelectionEditor connection={connection} kind="model/vae"
    initial="pixel_space" commit={commit} close={close} />, root)
  await vi.waitFor(() => expect(root.querySelector('[data-entry="pixel_space"]')).not.toBeNull())
  expect(root.textContent).toContain('This option opens no file.')
  const search = root.querySelector<HTMLInputElement>('input[type="search"]')!
  search.value = 'taesd'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => {
    expect(root.querySelector('[data-entry="taesd"]')).not.toBeNull()
    expect(root.querySelector('[data-entry="vendor/vae.safetensors"]')).toBeNull()
    expect(root.querySelector('[data-entry="pixel_space"]')).toBeNull()
  })
  root.querySelector<HTMLElement>('[data-entry="taesd"]')!.click()
  expect(root.textContent).toContain('Both files are resolved together inside one granted root.')
  expect(commit).not.toHaveBeenCalled()
  const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === text)!
  button('Cancel').click()
  expect(close).toHaveBeenCalledOnce()
  expect(commit).not.toHaveBeenCalled()
  button('Use selection').click()
  expect(commit).toHaveBeenLastCalledWith('taesd')
  options = []
  button('Refresh').click()
  await vi.waitFor(() => expect(root.textContent).toContain('not currently available'))
  expect(button('Use selection').disabled).toBe(true)
  expect(root.querySelector('input[type="file"]')).toBeNull()
  unmount()
})

it('selects a directory row rather than navigating or inventing a file descriptor', async () => {
  const commit = vi.fn()
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <AssetSelectionEditor kind="directory/dataset" initial={undefined}
    connection={{ listAssetSelections: async () => [{ name: 'training/set-a', shape: 'directory' }] }}
    commit={commit} close={() => {}} />, root)
  await vi.waitFor(() => expect(root.querySelector('[data-entry="training/set-a"]')).not.toBeNull())
  root.querySelector<HTMLElement>('[data-entry="training/set-a"]')!.click()
  expect(root.textContent).toContain('Read-only directory selection inside a granted root.')
  const apply = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Use selection')!
  apply.click()
  expect(commit).toHaveBeenCalledWith('training/set-a')
  unmount()
})

it('disables stale picks during refresh, reports errors, and aborts superseded and closed requests', async () => {
  const requests: { signal: AbortSignal; resolve: (options: readonly AssetSelectionOption[]) => void; reject: (error: Error) => void }[] = []
  const connection = { listAssetSelections: vi.fn((_kind: string, signal?: AbortSignal) =>
    new Promise<readonly AssetSelectionOption[]>((resolve, reject) => { requests.push({ signal: signal!, resolve, reject }) })) }
  const commit = vi.fn()
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <AssetSelectionEditor connection={connection} kind="model/vae"
    initial="pixel_space" commit={commit} close={() => {}} />, root)
  const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === text)!
  requests[0]!.resolve([{ name: 'pixel_space', shape: 'literal' }])
  await vi.waitFor(() => expect(button('Use selection').disabled).toBe(false))
  button('Refresh').click()
  expect(requests[0]!.signal.aborted).toBe(true)
  expect(button('Use selection').disabled).toBe(true)
  button('Refresh').click()
  expect(requests[1]!.signal.aborted).toBe(true)
  requests[1]!.resolve([{ name: 'pixel_space', shape: 'literal' }])
  requests[2]!.reject(new Error('selection service unavailable'))
  await vi.waitFor(() => expect(root.textContent).toContain('selection service unavailable'))
  expect(button('Use selection').disabled).toBe(true)
  expect(root.querySelector('[data-entry="pixel_space"]')).toBeNull()
  expect(commit).not.toHaveBeenCalled()
  button('Refresh').click()
  unmount()
  expect(requests[3]!.signal.aborted).toBe(true)
})

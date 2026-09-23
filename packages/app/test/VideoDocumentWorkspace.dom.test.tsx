// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVideoDocument } from '@dinkster/core'
import type { AppState } from '../src/app-state.js'
import {
  VideoDocumentWorkspace,
  type VideoWorkspaceTab,
} from '../src/VideoDocumentWorkspace.js'

afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('VideoDocumentWorkspace', () => {
  it('persists validated edits and keeps undo and redo on the generic document session', async () => {
    const [activeId, setActiveId] = createSignal('')
    const [createRequest, setCreateRequest] = createSignal(0)
    let tabs: readonly VideoWorkspaceTab[] = []
    const app = {
      collabBackend: () => undefined,
      collabActorId: 'local',
    } as unknown as AppState
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(
      () => (
        <VideoDocumentWorkspace
          activeId={activeId()}
          createRequest={createRequest()}
          app={app}
          onTabsChange={(next) => {
            tabs = next
          }}
          onActivate={setActiveId}
        />
      ),
      root,
    )

    setCreateRequest(1)
    await vi.waitFor(() => expect(tabs).toHaveLength(1))
    expect(activeId()).toBe(tabs[0]!.id)
    const textarea = root.querySelector<HTMLTextAreaElement>(
      '[data-testid="video-document-json"]',
    )!
    const replacement = createVideoDocument('Edited timeline')
    textarea.value = JSON.stringify(replacement, null, 2)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    const button = (label: string) =>
      [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent === label,
      )!
    button('Apply').click()

    await vi.waitFor(() =>
      expect(JSON.parse(textarea.value)).toEqual(replacement),
    )
    expect(button('Undo').disabled).toBe(false)
    button('Undo').click()
    await vi.waitFor(() =>
      expect(JSON.parse(textarea.value).timeline.name).toBe('Untitled video'),
    )
    expect(button('Redo').disabled).toBe(false)
    button('Redo').click()
    await vi.waitFor(() =>
      expect(JSON.parse(textarea.value)).toEqual(replacement),
    )

    const stored = Object.keys(localStorage).find((key) =>
      key.startsWith('dinkster.video-documents.v1:'),
    )
    expect(stored).toBeDefined()
    expect(JSON.parse(localStorage.getItem(stored!)!)[0].document).toEqual(
      replacement,
    )
    dispose()
  })

  it('restores project-scoped documents without creating duplicate tabs', async () => {
    const documentValue = createVideoDocument('Recovered timeline')
    localStorage.setItem(
      'dinkster.video-documents.v1:default',
      JSON.stringify([
        {
          id: 'recovered',
          title: 'Recovered video',
          document: documentValue,
        },
      ]),
    )
    let tabs: readonly VideoWorkspaceTab[] = []
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(
      () => (
        <VideoDocumentWorkspace
          activeId="video:recovered"
          createRequest={0}
          app={
            {
              collabBackend: () => undefined,
              collabActorId: 'local',
            } as unknown as AppState
          }
          onTabsChange={(next) => {
            tabs = next
          }}
          onActivate={() => undefined}
        />
      ),
      root,
    )

    await vi.waitFor(() =>
      expect(tabs.map((tab) => tab.title)).toEqual(['Recovered video']),
    )
    expect(
      JSON.parse(
        root.querySelector<HTMLTextAreaElement>(
          '[data-testid="video-document-json"]',
        )!.value,
      ),
    ).toEqual(documentValue)
    dispose()
  })
})

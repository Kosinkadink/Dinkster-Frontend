/**
 * Desktop project-backend bootstrap: the window's default backend is the
 * configured project supervisor's loopback port. Any other project engine
 * report must fail closed (undefined) so a window never falls back to a
 * same-origin backend its project does not own.
 */
import { describe, expect, it } from 'vitest'
import { desktopProjectBackendBaseUrl } from '../src/desktop-project-backend.js'
import type { DesktopProjectEngineInfo } from '../src/desktop-bridge.js'

const project = (overrides: Partial<DesktopProjectEngineInfo> = {}): DesktopProjectEngineInfo => ({
  projectId: 'proj-main',
  configured: true,
  mirrorConfigured: true,
  dataRoot: 'C:\\Dinkster\\projects\\proj-main',
  generations: [],
  port: 8188,
  ...overrides,
})

describe('desktopProjectBackendBaseUrl', () => {
  it('targets the project supervisor loopback port', () => {
    expect(desktopProjectBackendBaseUrl(project({ port: 8188 }))).toBe('http://127.0.0.1:8188')
  })

  it('gives asymmetric project ports different connection targets', () => {
    const first = desktopProjectBackendBaseUrl(project({ port: 8188 }))
    const second = desktopProjectBackendBaseUrl(project({ port: 8189 }))
    expect(first).toBe('http://127.0.0.1:8188')
    expect(second).toBe('http://127.0.0.1:8189')
    expect(first).not.toEqual(second)
  })

  it('fails closed for missing, unconfigured, and invalid ports', () => {
    expect(desktopProjectBackendBaseUrl(project({ configured: false, port: 8188 }))).toBeUndefined()
    const { port: omittedPort, ...missingPort } = project()
    void omittedPort
    expect(desktopProjectBackendBaseUrl(missingPort)).toBeUndefined()
    expect(desktopProjectBackendBaseUrl(project({ port: 0 }))).toBeUndefined()
    expect(desktopProjectBackendBaseUrl(project({ port: -1 }))).toBeUndefined()
    expect(desktopProjectBackendBaseUrl(project({ port: 70000 }))).toBeUndefined()
    expect(desktopProjectBackendBaseUrl(project({ port: Number.NaN }))).toBeUndefined()
    expect(desktopProjectBackendBaseUrl(project({ port: 8188.5 }))).toBeUndefined()
  })
})

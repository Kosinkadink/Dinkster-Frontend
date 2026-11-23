import type { AssetRef } from '@dinkster/core'

export const DESKTOP_ENGINE_ACCELERATORS = ['cpu', 'cuda', 'mps', 'rocm', 'xpu'] as const
export type DesktopEngineAccelerator = typeof DESKTOP_ENGINE_ACCELERATORS[number]

export function desktopEngineAcceleratorLabel(accelerator: DesktopEngineAccelerator): string {
  return accelerator === 'rocm' ? 'ROCm' : accelerator.toUpperCase()
}

export interface DesktopLifecycleStatus {
  readonly phase: 'idle' | 'detecting' | 'downloading' | 'installing' | 'starting' | 'running' | 'failed' | 'stopped'
  readonly detail: string
  readonly variant?: DesktopEngineAccelerator
  readonly error?: string
}

export type DesktopPanelPlacement = 'dock' | 'rail' | 'bottom'

export type DesktopWindowContext =
  | { readonly id: string; readonly kind: 'primary' }
  | { readonly id: string; readonly kind: 'workflow'; readonly workflowId: string }
  | { readonly id: string; readonly kind: 'panel'; readonly panelId: string; readonly returnPlacement: DesktopPanelPlacement }

export interface DesktopWindowLayout {
  readonly windows: readonly DesktopWindowContext[]
}

/**
 * A validated dinkster:// request delivered by the desktop shell: identifiers
 * only, never credentials.
 */
export interface DesktopDeepLink {
  readonly projectId: string
  readonly workflowId: string
  readonly backendUrl?: string
}

export interface DesktopConnectionCredentials {
  /** Whether OS-keychain-backed encryption is available for storing secrets. */
  readonly custody: boolean
  /** Profile ids that have a stored credential. */
  readonly profiles: readonly string[]
}

export type DesktopSaveResult =
  | { readonly status: 'saved'; readonly name: string }
  | { readonly status: 'closed' }

export interface DinksterDesktopBridge {
  saveFile?(bytes: Uint8Array, suggestedName: string): Promise<DesktopSaveResult>
  locale(): Promise<string>
  status(): Promise<DesktopLifecycleStatus>
  retry(): Promise<void>
  fileCapabilities(backendUrl: string): Promise<{ readonly nativeFolderChoice: boolean; readonly reveal: boolean; readonly resolvePath?: boolean }>
  chooseDirectory(backendUrl: string): Promise<string | undefined>
  revealFile?(backendUrl: string, asset: { readonly digest: string; readonly scope: 'local'; readonly project: string }): Promise<{ readonly mode: 'selected' | 'folder' }>
  revealModelLocation?(backendUrl: string, location: string): Promise<void>
  resolveDroppedFile?(backendUrl: string, file: File): Promise<
    | { readonly status: 'resolved'; readonly asset: AssetRef }
    | { readonly status: 'refused'; readonly reason: 'not-resolvable' | 'not-native-file' | 'unsupported-backend' }
  >
  windowContext(): Promise<DesktopWindowContext>
  windowLayout(): Promise<DesktopWindowLayout>
  openWorkflowWindow(workflowId: string, x?: number, y?: number): Promise<void>
  openPanelWindow(panelId: string, returnPlacement: DesktopPanelPlacement): Promise<void>
  redockWindow(): Promise<void>
  /** Rebind this workspace window to a project: reloads it into the new scope. */
  switchProject(projectId: string): Promise<void>
  /** Open an additional workspace window bound to a project. */
  openProjectWindow(projectId: string): Promise<void>
  /**
   * Store (secret string), replace, or clear (null) the credential for a
   * connection profile. The secret is encrypted in the main process and is
   * never readable back from the renderer; the desktop shell injects it as
   * an Authorization header for the profile's exact origin.
   */
  setConnectionCredential(profileId: string, url: string | undefined, secret: string | null): Promise<void>
  /**
   * Clear a deleted profile's credential and permanently refuse later sets
   * for its id, so an in-flight save from another window cannot recreate an
   * unmanageable credential. Removal only; token clearing uses
   * setConnectionCredential with a null secret.
   */
  retireConnectionProfile(profileId: string): Promise<void>
  connectionCredentials(): Promise<DesktopConnectionCredentials>
  /** Drain deep links queued for this window. */
  takeDeepLinks(): Promise<readonly DesktopDeepLink[]>
  onStatus(listener: (status: DesktopLifecycleStatus) => void): () => void
  onLog(listener: (line: string) => void): () => void
  onWindowLayout(listener: (layout: DesktopWindowLayout) => void): () => void
  onDeepLinkPending(listener: () => void): () => void
}

declare global {
  interface Window {
    dinksterDesktop?: DinksterDesktopBridge | DesktopFileBridge
  }
}

export type DesktopFileBridge = Pick<DinksterDesktopBridge, 'saveFile' | 'fileCapabilities' | 'chooseDirectory' | 'revealFile' | 'revealModelLocation' | 'resolveDroppedFile'>

export function desktopSaveBridge(): { saveFile(bytes: Uint8Array, suggestedName: string): Promise<DesktopSaveResult> } | undefined {
  const saveFile = window.dinksterDesktop?.saveFile
  return typeof saveFile === 'function' ? { saveFile } : undefined
}

export function desktopBridge(): DinksterDesktopBridge | undefined {
  const bridge = window.dinksterDesktop
  return bridge && 'locale' in bridge && typeof bridge.locale === 'function' &&
    'status' in bridge && typeof bridge.status === 'function' ? bridge : undefined
}

export function desktopFileBridge(): DesktopFileBridge | undefined {
  const bridge = window.dinksterDesktop
  return typeof bridge?.fileCapabilities === 'function' ? bridge : undefined
}

export function isNativeProjectBackend(baseUrl: string, projectId: string): boolean {
  return desktopFileBridge() !== undefined &&
    new URL(window.location.href).searchParams.get('dinksterProject') === projectId &&
    new URL(baseUrl || '/', window.location.href).origin === window.location.origin
}

/** Only an explicit refusal permits the caller to offer byte upload. */
export async function resolveDroppedAsset(backendUrl: string, file: File, isCurrent: () => boolean): Promise<AssetRef | undefined> {
  const bridge = desktopFileBridge()
  if (!bridge?.resolveDroppedFile) return undefined
  const url = new URL(backendUrl || '/', window.location.href).href
  try {
    const capabilities = await bridge.fileCapabilities(url)
    if (typeof capabilities?.nativeFolderChoice !== 'boolean' || typeof capabilities.reveal !== 'boolean' ||
        (capabilities.resolvePath !== undefined && typeof capabilities.resolvePath !== 'boolean')) throw new Error('Invalid native capability response')
    if (!isCurrent() || capabilities.resolvePath !== true) return undefined
    const result = await bridge.resolveDroppedFile(url, file)
    if (!isCurrent()) return undefined
    if (result?.status === 'refused' && Object.keys(result).length === 2 &&
        ['not-resolvable', 'not-native-file', 'unsupported-backend'].includes(result.reason)) return undefined
    if (result?.status === 'resolved' && Object.keys(result).length === 2) {
      const asset = result.asset
      if (asset && Object.keys(asset).length === 5 && /^blake3:[a-f0-9]{64}$/.test(asset.digest) &&
          typeof asset.name === 'string' && asset.name !== '' && Number.isSafeInteger(asset.size) && asset.size >= 0 &&
          typeof asset.mediaType === 'string' && asset.mediaType !== '' && typeof asset.virtualPath === 'string') {
        const segments = asset.virtualPath.split('/')
        if (segments.length >= 3 && segments[0] === 'mounts' && segments.at(-1) === asset.name &&
            !/[\\\0]/.test(asset.virtualPath) && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')) return asset
      }
    }
  } catch {
    // Native errors may contain private server details; keep the renderer message fixed.
    throw new Error('Could not resolve the existing file. Nothing was uploaded.')
  }
  throw new Error('Invalid native file resolution response. Nothing was uploaded.')
}

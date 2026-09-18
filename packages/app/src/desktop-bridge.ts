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

export interface DesktopEngineRelease {
  readonly commit: string
  readonly variant: DesktopEngineAccelerator
  readonly bytes: number
  readonly active: boolean
}

export interface DesktopInfo {
  readonly appVersion: string
  readonly engineCommit: string
  readonly remoteWorkerProtocol?: number
  readonly variant: DesktopEngineAccelerator
  readonly storageBytes: number
  readonly releases: readonly DesktopEngineRelease[]
  readonly update: { readonly state: 'idle' | 'checking' | 'available' | 'ready' | 'current' | 'failed'; readonly detail: string }
}

export interface DesktopSystemCheck {
  readonly platform: string
  readonly architecture: string
  readonly freeBytes: number
  readonly totalBytes: number
  readonly engineReady: boolean
  readonly engineDetail: string
  readonly gpu: { readonly available: boolean; readonly name?: string; readonly driver?: string; readonly memoryMiB?: number }
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

export interface DesktopRemoteWorkerMemory {
  readonly device: string
  readonly size: string
}

export interface DesktopRemoteWorker {
  readonly name: string
  readonly endpoint: string
  readonly tokenFile: string
  readonly tlsCaFile?: string
  readonly nodes?: readonly string[]
  readonly memory: readonly DesktopRemoteWorkerMemory[]
}

export interface DesktopRemoteWorkerFileChoice {
  readonly path: string
  readonly grant: string
}

export interface DesktopRemoteWorkerSave extends DesktopRemoteWorker {
  readonly tokenFileGrant?: string
  readonly tlsCaFileGrant?: string
}

export interface DinksterDesktopBridge {
  locale(): Promise<string>
  status(): Promise<DesktopLifecycleStatus>
  retry(): Promise<void>
  info(): Promise<DesktopInfo>
  selectEngine(commit: string, variant: DesktopEngineAccelerator): Promise<void>
  checkForUpdates(): Promise<void>
  installUpdate(): Promise<void>
  chooseDirectory(): Promise<string | undefined>
  exportSnapshot(): Promise<string | undefined>
  importSnapshot(): Promise<unknown | undefined>
  systemCheck(): Promise<DesktopSystemCheck>
  clearCache(): Promise<void>
  exportSupportReport(): Promise<string | undefined>
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
  /** Read remote-worker file paths and routing policy; token contents stay in the main process. */
  remoteWorkers(): Promise<readonly DesktopRemoteWorker[]>
  /** Atomically save one profile and restart the managed local engine. */
  saveRemoteWorker(worker: DesktopRemoteWorkerSave): Promise<void>
  /** Remove one profile and restart the managed local engine. */
  removeRemoteWorker(name: string): Promise<void>
  chooseRemoteWorkerFile(kind: 'token' | 'tls-ca'): Promise<DesktopRemoteWorkerFileChoice | undefined>
  /** Drain deep links queued for this window. */
  takeDeepLinks(): Promise<readonly DesktopDeepLink[]>
  onStatus(listener: (status: DesktopLifecycleStatus) => void): () => void
  onLog(listener: (line: string) => void): () => void
  onInfo(listener: (info: DesktopInfo) => void): () => void
  onWindowLayout(listener: (layout: DesktopWindowLayout) => void): () => void
  onDeepLinkPending(listener: () => void): () => void
}

declare global {
  interface Window {
    dinksterDesktop?: DinksterDesktopBridge
  }
}

export function desktopBridge(): DinksterDesktopBridge | undefined {
  return window.dinksterDesktop
}

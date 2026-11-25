export interface DevelopmentSources {
  readonly engine: string
  readonly inference?: string
  readonly helper?: string
  readonly packs: readonly string[]
  readonly frontendRoot?: string
  readonly frontendSource?: string
  readonly frontendDev?: string
  readonly allowFrontendDevRemote?: boolean
}

export interface DesktopEnvironment {
  readonly id: string
  readonly name: string
  readonly channel: 'stable' | 'nightly'
  readonly root?: string
  readonly development?: DevelopmentSources
  readonly sandboxPacks?: boolean
  readonly sourceStatus?: 'published' | 'unpublished' | 'unavailable'
  readonly engines: readonly (
    | {
        readonly id: string
        readonly name: string
        readonly kind: 'local'
        readonly gpus: readonly string[]
        readonly port?: number
      }
    | {
        readonly id: string
        readonly name: string
        readonly kind: 'remote'
        readonly url: string
      }
  )[]
}

export interface EnvironmentRequest {
  readonly root: string
  readonly operation:
    | 'setup'
    | 'update'
    | 'develop'
    | 'rollback'
    | 'move'
    | 'stop'
    | 'doctor'
    | 'gc'
    | 'status'
    | 'cleanup'
    | 'space'
    | 'source'
    | 'catalog'
  readonly channel?: 'stable' | 'nightly'
  readonly variant?: string
  readonly mirrors?: readonly string[]
  readonly data?: string
  readonly port?: number
  readonly destination?: string
  readonly engine?: string
  readonly gpus?: readonly string[]
  readonly development?: DevelopmentSources
  readonly automaticCleanup?: boolean
  readonly keepPreviousGenerations?: number
  readonly frontendVersion?: string
  readonly packageIndex?: string
  readonly sourceAction?: 'add' | 'update' | 'refs' | 'release'
  readonly sourceTarget?:
    | 'engine'
    | 'pack'
    | 'inference'
    | 'helper'
    | 'frontend'
  readonly sourceUrl?: string
  readonly sourceName?: string
  readonly sourceRef?: string
  readonly gitMirror?: string
}

interface CleanupAttempt {
  readonly status: 'complete' | 'deferred' | 'disabled' | 'coalesced'
  readonly warnings?: readonly string[]
}
interface CleanupPolicy {
  readonly automatic: boolean
  readonly previousSuccessfulActivations: number
  readonly minimumAgeSeconds: number
}
interface CleanupSnapshot {
  readonly generation: number
  readonly status: 'retained' | 'candidate' | 'deferred'
  readonly reasons: readonly string[]
}
export interface EnvironmentResult {
  readonly operation: EnvironmentRequest['operation'] | 'restore'
  readonly status:
    | 'planned'
    | 'approval-required'
    | 'applied'
    | 'clean'
    | 'drift'
    | 'error'
    | CleanupAttempt['status']
  readonly plan: readonly string[]
  readonly changes?: readonly string[]
  readonly base?: {
    readonly variant: string
    readonly origin: 'published' | 'user-defined'
    readonly torchVersion: string | null
    readonly torchIndex: string | null
    readonly label?: string | null
  }
  readonly engine?: {
    readonly version: string
    readonly release: string
    readonly label: string | null
  }
  readonly development?: {
    readonly sources: readonly {
      readonly kind: string
      readonly git?: {
        readonly url: string
        readonly requestedRef: string | null
        readonly commit: string
        readonly subdirectory: string
      }
    }[]
  }
  readonly source?: string
  readonly published?: boolean
  readonly reproducible?: boolean
  readonly sources?: Readonly<Record<string, unknown>>
  readonly frontend?: Readonly<Record<string, unknown>>
  readonly restoredFrom?: number
  readonly variants?: readonly {
    readonly variant: string
    readonly downloadBytes: number
  }[]
  readonly cleanup?: {
    readonly policy?: CleanupPolicy
    readonly generations: readonly CleanupSnapshot[]
    readonly quarantine: readonly {
      readonly journal: string
      readonly stage: string
      readonly generations: readonly number[]
    }[]
    readonly warnings: readonly string[]
    readonly lastAttempt?: CleanupAttempt
  }
  readonly cleanupAttempt?: CleanupAttempt
  readonly space?: {
    readonly project: string
    readonly store: string | null
    readonly scope: string
    readonly sharing: string
    readonly complete: boolean
    readonly allocatedBytes: number | null
    readonly observedAllocatedBytes: number
    readonly sharedAllocatedBytes: number | null
    readonly automaticReclaimableBytes: number | null
    readonly eligibleGenerationReclaimableBytes: number | null
    readonly additionalExplicitReclaimableBytes: number | null
    readonly policy: CleanupPolicy
    readonly settingsCommand: string
    readonly settingsHelp: string
    readonly generations: readonly (CleanupSnapshot & {
      readonly allocationGroup: string
    })[]
    readonly stores: readonly {
      readonly allocationGroup: string
      readonly label: string
      readonly reasons: readonly string[]
    }[]
    readonly groups: Readonly<
      Record<
        string,
        {
          readonly exclusiveAllocatedBytes: number | null
          readonly sharedAllocatedBytes: number | null
        }
      >
    >
    readonly warnings: readonly string[]
    readonly cleanupWarnings: readonly string[]
    readonly eligibilityWarnings: readonly string[]
    readonly reclaimabilityWarnings: readonly string[]
  }
}

interface WslStatus {
  readonly detail: string
}

/** The local renderer describes intent; Desktop retains and applies the approved request. */
export interface EnvironmentBridge {
  list(): Promise<{ readonly projects: readonly DesktopEnvironment[] }>
  save(environment: DesktopEnvironment): Promise<void>
  remove(id: string): Promise<void>
  open(id: string, engine: string): Promise<void>
  sandbox(
    root: string,
  ): Promise<
    { readonly available: boolean; readonly detail: string } | undefined
  >
  inspect(request: EnvironmentRequest): Promise<{
    readonly result: EnvironmentResult
    readonly hardware: {
      readonly gpus: readonly {
        readonly id: string
        readonly name: string
        readonly driver?: string
        readonly computeCapability?: string
      }[]
      readonly diagnostic?: string
    }
    readonly plan: {
      readonly selected?: string
      readonly reason: string
      readonly choices: readonly {
        readonly variant: string
        readonly supported: boolean
        readonly reason: string
      }[]
    }
  }>
  plan(
    environment: DesktopEnvironment,
    request: EnvironmentRequest,
  ): Promise<{ readonly result: EnvironmentResult; readonly token?: string }>
  apply(token: string): Promise<EnvironmentResult>
  wslStatus(): Promise<WslStatus>
  prepareWsl(): Promise<WslStatus>
  wslProjectRoot(id: string): Promise<string>
  copyWslModels(): Promise<string | undefined>
}

import { For, Show, createSignal, onMount } from 'solid-js'
import { render } from 'solid-js/web'
import {
  ProductButton,
  ProductCheckbox,
  ProductCodeBlock,
  ProductDialog,
  ProductDisclosure,
  ProductErrorBanner,
  ProductField,
  ProductList,
  ProductListRow,
  ProductLoading,
  ProductNotice,
  ProductPage,
  ProductSection,
  ProductSelect,
  ProductShell,
  ProductTextArea,
  ProductTextInput,
  ProductToast,
} from '@dinkster/ui'
import '@dinkster/ui/styles.css'
import type {
  DesktopEnvironment,
  EnvironmentBridge,
  EnvironmentRequest,
  EnvironmentResult,
} from './desktop-environments-bridge.js'

declare global {
  interface Window {
    readonly dinksterProjects?: EnvironmentBridge
  }
}

const defaults = {
  selected: '',
  name: '',
  root: '',
  channel: 'stable',
  host: 'native',
  kind: 'release',
  operation: 'setup',
  engine: 'main',
  gpus: '',
  port: '3639',
  variant: '',
  mirrors: '',
  frontendVersion: '',
  packageIndex: '',
  data: '',
  destination: '',
  cleanup: 'keep',
  keepPrevious: '',
  developmentEngine: '',
  developmentInference: '',
  developmentHelper: '',
  developmentPacks: '',
  developmentFrontend: '',
  developmentFrontendGit: '',
  developmentFrontendDev: '',
  sourceAction: 'add',
  sourceTarget: 'engine',
  sourceUrl: '',
  sourceRef: '',
  sourceName: '',
  sourceMirror: '',
}
type Field = keyof typeof defaults
const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
const devices = (value: string) =>
  value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
const isWsl = (value: string) =>
  /^\/\/wsl(?:\.localhost|\$)\/dinkster-desktop-/i.test(
    value.replaceAll('\\', '/'),
  )

function Environments() {
  const bridge = window.dinksterProjects
  const [environments, setEnvironments] = createSignal<
    readonly DesktopEnvironment[]
  >([])
  const [values, setValues] = createSignal({ ...defaults })
  const [remote, setRemote] = createSignal({
    name: '',
    url: '',
    channel: 'stable',
  })
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [notification, setNotification] = createSignal<{ message: string }>()
  const [removing, setRemoving] = createSignal<DesktopEnvironment>()
  const [bindingBaseline, setBindingBaseline] = createSignal('')
  const [fieldErrors, setFieldErrors] = createSignal<
    Partial<Record<Field, string | undefined>>
  >({})
  const [sandbox, setSandbox] = createSignal(false)
  const [sandboxReady, setSandboxReady] = createSignal(false)
  const [sandboxDetail, setSandboxDetail] = createSignal(
    'Select an environment, then check sandbox availability.',
  )
  const [allowRemoteDev, setAllowRemoteDev] = createSignal(false)
  const [variants, setVariants] = createSignal<
    readonly {
      variant: string
      supported: boolean
      reason: string
      downloadBytes?: number | undefined
    }[]
  >([])
  const [hardware, setHardware] = createSignal(
    'Inspect the catalog and assigned GPUs before choosing a variant. CPU is never selected automatically.',
  )
  const [wslDetail, setWslDetail] = createSignal(
    'Check WSL2 to see installation guidance.',
  )
  const [review, setReview] = createSignal<{
    result: EnvironmentResult
    token?: string
    environment?: DesktopEnvironment
  }>()
  const [advanced, setAdvanced] = createSignal(false)
  let identity = `project-${crypto.randomUUID()}`
  let sandboxCheck = 0
  const field = (key: Field) => values()[key].trim()
  const bindingState = () =>
    JSON.stringify({
      name: field('name'),
      root: field('root'),
      channel: field('channel'),
      kind: field('kind'),
      engine: field('engine'),
      gpus: field('gpus'),
      port: field('port'),
      developmentEngine: field('developmentEngine'),
      developmentInference: field('developmentInference'),
      developmentHelper: field('developmentHelper'),
      developmentPacks: field('developmentPacks'),
      developmentFrontend: field('developmentFrontend'),
      developmentFrontendGit: field('developmentFrontendGit'),
      developmentFrontendDev: field('developmentFrontendDev'),
      sandbox: sandbox(),
      allowRemoteDev: allowRemoteDev(),
    })
  const invalidate = () => setReview(undefined)
  const resetSandbox = () => {
    sandboxCheck++
    setSandboxReady(false)
    setSandboxDetail('Select an environment, then check sandbox availability.')
  }
  const clearHardware = () => {
    setVariants([])
    setValues((current) => ({ ...current, variant: '' }))
    setHardware(
      'Inspect the catalog and assigned GPUs before choosing a variant. CPU is never selected automatically.',
    )
  }
  const change = (key: Field, value: string) => {
    invalidate()
    setFieldErrors((current) => ({ ...current, [key]: undefined }))
    setValues((current) => ({ ...current, [key]: value }))
    if (['root', 'channel', 'mirrors', 'gpus'].includes(key)) clearHardware()
    if (key === 'root') resetSandbox()
    if (key === 'host') {
      setValues((current) => ({ ...current, root: '' }))
      resetSandbox()
      clearHardware()
    }
    if (key === 'kind')
      setValues((current) => ({
        ...current,
        operation: value === 'development' ? 'develop' : 'setup',
      }))
  }
  const perform = async (
    action: (host: EnvironmentBridge) => Promise<unknown>,
  ) => {
    if (busy()) return
    setBusy(true)
    setNotification(undefined)
    try {
      if (!bridge)
        throw new Error('Environment management requires Dinkster Desktop.')
      await action(bridge)
      setError(undefined)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The environment operation failed. Review the environment before retrying.',
      )
    } finally {
      setBusy(false)
    }
  }
  const refresh = async (host: EnvironmentBridge) =>
    setEnvironments((await host.list()).projects)
  onMount(() => {
    void perform(refresh)
  })

  const checkSandbox = async (host: EnvironmentBridge) => {
    const check = ++sandboxCheck
    const root = field('root')
    setSandboxReady(false)
    setSandboxDetail('Checking the selected engine sandbox prerequisites...')
    try {
      const result = await host.sandbox(root)
      if (check !== sandboxCheck || root !== field('root')) return
      setSandboxReady(result?.available === true)
      setSandboxDetail(
        result?.detail ??
          'Update the engine and environment tools to check sandbox readiness.',
      )
    } catch {
      if (check === sandboxCheck && root === field('root'))
        setSandboxDetail(
          'Sandbox readiness could not be checked. A saved request remains selected; there is no unsandboxed fallback.',
        )
    }
  }
  const select = (
    project: DesktopEnvironment | undefined,
    engineId?: string,
  ) => {
    invalidate()
    const engine = project?.engines.find(
      (entry) => entry.kind === 'local' && (!engineId || entry.id === engineId),
    )
    setValues({
      ...defaults,
      selected: project?.id ?? '',
      name: project?.name ?? '',
      root: project?.root ?? '',
      channel: project?.channel ?? 'stable',
      host: isWsl(project?.root ?? '') ? 'wsl2' : 'native',
      kind: project?.development ? 'development' : 'release',
      operation: project?.development
        ? 'develop'
        : project
          ? 'update'
          : 'setup',
      engine: engine?.id ?? 'main',
      gpus: engine?.kind === 'local' ? engine.gpus.join(',') : '',
      port: String(engine?.kind === 'local' ? (engine.port ?? 3639) : 3639),
      developmentEngine: project?.development?.engine ?? '',
      developmentInference: project?.development?.inference ?? '',
      developmentHelper: project?.development?.helper ?? '',
      developmentPacks: project?.development?.packs.join('\n') ?? '',
      developmentFrontend: project?.development?.frontendRoot ?? '',
      developmentFrontendGit: project?.development?.frontendSource ?? '',
      developmentFrontendDev: project?.development?.frontendDev ?? '',
    })
    setSandbox(project?.sandboxPacks === true)
    setAllowRemoteDev(project?.development?.allowFrontendDevRemote === true)
    setFieldErrors({})
    setBindingBaseline(bindingState())
    resetSandbox()
    clearHardware()
    if (project?.root && bridge) void checkSandbox(bridge)
  }
  const projectValue = (): DesktopEnvironment | undefined => {
    const errors: Partial<Record<Field, string>> = {}
    if (!field('name')) errors.name = 'Enter an environment name.'
    if (!field('root')) errors.root = 'Choose an install location.'
    else if ((field('host') === 'wsl2') !== isWsl(field('root')))
      errors.root =
        'Choose a folder on the selected engine host. For WSL2, use the Linux environment folder button.'
    if (!field('engine')) errors.engine = 'Enter an engine name.'
    if (
      !/^\d+$/.test(field('port')) ||
      Number(field('port')) < 1 ||
      Number(field('port')) > 65535
    )
      errors.port = 'Enter a whole-number port from 1 to 65535.'
    if (
      field('operation') === 'cleanup' &&
      field('keepPrevious') &&
      (!/^\d+$/.test(field('keepPrevious')) ||
        Number(field('keepPrevious')) < 1 ||
        Number(field('keepPrevious')) > 100)
    )
      errors.keepPrevious =
        'Enter a whole-number count from 1 to 100, or leave it empty.'
    if (field('kind') === 'development' && !field('developmentEngine'))
      errors.developmentEngine = 'Enter an explicit engine source.'
    setFieldErrors(errors)
    if (Object.keys(errors).length) {
      setAdvanced(true)
      return undefined
    }
    const channel = field('channel')
    if (channel !== 'stable' && channel !== 'nightly')
      throw new Error('Choose Stable or Nightly.')
    const saved = environments().find((entry) => entry.id === field('selected'))
    const engine = field('engine')
    return {
      id: saved?.id ?? identity,
      name: field('name'),
      root: field('root'),
      channel,
      engines: [
        ...(saved?.engines.filter((entry) => entry.id !== engine) ?? []),
        {
          id: engine,
          name: engine,
          kind: 'local',
          gpus: devices(field('gpus')),
          port: Number(field('port')),
        },
      ],
      sandboxPacks: sandbox(),
      ...(field('kind') === 'development'
        ? {
            development: {
              engine: field('developmentEngine'),
              packs: lines(field('developmentPacks')),
              ...(field('developmentInference')
                ? { inference: field('developmentInference') }
                : {}),
              ...(field('developmentHelper')
                ? { helper: field('developmentHelper') }
                : {}),
              ...(field('developmentFrontend')
                ? { frontendRoot: field('developmentFrontend') }
                : {}),
              ...(field('developmentFrontendGit')
                ? { frontendSource: field('developmentFrontendGit') }
                : {}),
              ...(field('developmentFrontendDev')
                ? { frontendDev: field('developmentFrontendDev') }
                : {}),
              allowFrontendDevRemote: allowRemoteDev(),
            },
          }
        : {}),
    }
  }
  const requestReview = async (host: EnvironmentBridge) => {
    invalidate()
    const project = projectValue()
    if (!project) return
    const operation = field('operation') as EnvironmentRequest['operation']
    if (operation === 'develop' && !project.development)
      throw new Error('Choose development sources before building.')
    if (['setup', 'develop'].includes(operation) && !field('variant')) {
      setAdvanced(true)
      setFieldErrors({
        variant:
          'Choose an explicit hardware variant. CPU is not selected automatically.',
      })
      return
    }
    const request: EnvironmentRequest = {
      root: project.root!,
      operation,
      ...(['setup', 'update', 'develop'].includes(operation)
        ? {
            channel: project.channel,
            ...(field('variant') ? { variant: field('variant') } : {}),
          }
        : {}),
      ...(['setup', 'develop'].includes(operation)
        ? {
            mirrors: lines(field('mirrors')),
            port: Number(field('port')),
            engine: field('engine'),
          }
        : {}),
      ...(operation === 'stop' ? { engine: field('engine') } : {}),
      ...(operation === 'develop' ? { development: project.development! } : {}),
      ...(['setup', 'move', 'develop'].includes(operation) && field('data')
        ? { data: field('data') }
        : {}),
      ...(operation === 'move' ? { destination: field('destination') } : {}),
      ...(operation === 'cleanup' && field('cleanup') !== 'keep'
        ? { automaticCleanup: field('cleanup') === 'on' }
        : {}),
      ...(operation === 'cleanup' && field('keepPrevious') !== ''
        ? { keepPreviousGenerations: Number(field('keepPrevious')) }
        : {}),
      ...(['setup', 'update'].includes(operation) && field('frontendVersion')
        ? { frontendVersion: field('frontendVersion') }
        : {}),
      ...(['setup', 'update'].includes(operation) && field('packageIndex')
        ? { packageIndex: field('packageIndex') }
        : {}),
      ...(operation === 'source'
        ? {
            sourceAction: field('sourceAction') as NonNullable<
              EnvironmentRequest['sourceAction']
            >,
            ...(['add', 'refs'].includes(field('sourceAction'))
              ? { sourceUrl: field('sourceUrl') }
              : {}),
            ...(['add', 'update'].includes(field('sourceAction'))
              ? {
                  sourceTarget: field('sourceTarget') as NonNullable<
                    EnvironmentRequest['sourceTarget']
                  >,
                  ...(field('sourceTarget') === 'pack' && field('sourceName')
                    ? { sourceName: field('sourceName') }
                    : {}),
                  ...(field('sourceRef')
                    ? { sourceRef: field('sourceRef') }
                    : {}),
                  ...(field('packageIndex')
                    ? { packageIndex: field('packageIndex') }
                    : {}),
                }
              : {}),
            ...(field('sourceAction') !== 'release' && field('sourceMirror')
              ? { gitMirror: field('sourceMirror') }
              : {}),
          }
        : {}),
    }
    setReview({ ...(await host.plan(project, request)), environment: project })
  }
  const inspect = async (host: EnvironmentBridge) => {
    invalidate()
    clearHardware()
    const result = await host.inspect({
      root: field('root'),
      operation: 'catalog',
      channel: field('channel') as 'stable' | 'nightly',
      mirrors: lines(field('mirrors')),
      gpus: devices(field('gpus')),
    })
    setVariants(
      result.plan.choices.map((choice) => ({
        ...choice,
        downloadBytes: result.result.variants?.find(
          (entry) => entry.variant === choice.variant,
        )?.downloadBytes,
      })),
    )
    setValues((current) => ({
      ...current,
      variant: result.plan.selected ?? '',
    }))
    setHardware(
      [
        ...result.hardware.gpus.map(
          (gpu) =>
            `${gpu.id}: ${gpu.name}; driver ${gpu.driver ?? 'unknown'}; compute ${gpu.computeCapability ?? 'unknown'}`,
        ),
        result.hardware.diagnostic,
        result.plan.reason,
        ...result.plan.choices.map(
          (choice) => `${choice.variant}: ${choice.reason}`,
        ),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  function Text(props: {
    field: Field
    label: string
    description?: string
    multiline?: boolean
    placeholder?: string
  }) {
    return (
      <ProductField
        label={props.label}
        {...(props.description ? { description: props.description } : {})}
        {...(fieldErrors()[props.field]
          ? { error: fieldErrors()[props.field]! }
          : {})}
      >
        {(attrs) =>
          props.multiline ? (
            <ProductTextArea
              {...attrs}
              value={values()[props.field]}
              disabled={busy()}
              rows={3}
              placeholder={props.placeholder}
              onInput={(event) =>
                change(props.field, event.currentTarget.value)
              }
            />
          ) : (
            <ProductTextInput
              {...attrs}
              value={values()[props.field]}
              disabled={busy()}
              placeholder={props.placeholder}
              onInput={(event) =>
                change(props.field, event.currentTarget.value)
              }
            />
          )
        }
      </ProductField>
    )
  }
  function Select(props: {
    field: Field
    label: string
    options: readonly (readonly [string, string])[]
  }) {
    return (
      <ProductField
        label={props.label}
        {...(fieldErrors()[props.field]
          ? { error: fieldErrors()[props.field]! }
          : {})}
      >
        {(attrs) => (
          <ProductSelect
            {...attrs}
            value={values()[props.field]}
            disabled={busy()}
            onChange={(event) => change(props.field, event.currentTarget.value)}
          >
            <For each={props.options}>
              {([value, label]) => <option value={value}>{label}</option>}
            </For>
          </ProductSelect>
        )}
      </ProductField>
    )
  }
  const channels = [
    ['stable', 'Stable'],
    ['nightly', 'Nightly'],
  ] as const
  const selectedVariant = () =>
    variants().find((choice) => choice.variant === field('variant'))
  return (
    <ProductShell
      title="Dinkster Desktop"
      navigation={[]}
      currentHref=""
      onNavigate={() => {}}
    >
      <ProductPage
        title="Environments"
        description="Projects live in the library. Manage the environment they run on here, or connect to a remote engine."
      >
        <Show when={error()}>
          {(message) => (
            <ProductErrorBanner onDismiss={() => setError(undefined)}>
              {message()}
            </ProductErrorBanner>
          )}
        </Show>
        <Show when={busy()}>
          <ProductLoading label="Waiting for Desktop to finish the environment operation..." />
        </Show>
        <ProductSection title="Saved environments">
          <ProductList label="Saved environments">
            <For
              each={environments()}
              fallback={
                <ProductListRow
                  title={
                    busy() ? 'Loading environments...' : 'No environments yet'
                  }
                />
              }
            >
              {(environment) => (
                <ProductListRow
                  title={environment.name}
                  description={
                    environment.sourceStatus === 'unpublished'
                      ? 'Development - unpublished sources'
                      : environment.sourceStatus === 'unavailable'
                        ? 'Active sources unavailable - inspect the environment'
                        : `Channel: ${environment.channel}`
                  }
                  action={
                    <div class="dinkster-actions">
                      <For each={environment.engines}>
                        {(engine) => (
                          <>
                            <ProductButton
                              disabled={busy()}
                              onClick={() =>
                                void perform(async (host) => {
                                  await host.open(environment.id, engine.id)
                                })
                              }
                            >
                              Open {engine.name}
                            </ProductButton>
                            <Show when={engine.kind === 'local'}>
                              <ProductButton
                                disabled={busy()}
                                onClick={() => select(environment, engine.id)}
                              >
                                Manage {engine.name}
                              </ProductButton>
                            </Show>
                          </>
                        )}
                      </For>
                      <ProductButton
                        intent="remove"
                        disabled={busy()}
                        onClick={() => setRemoving(environment)}
                      >
                        Remove binding
                      </ProductButton>
                    </div>
                  }
                />
              )}
            </For>
          </ProductList>
        </ProductSection>
        <ProductSection
          title="Local environment"
          description="Review the plan before any install, update, restore, move or collection. A review makes no changes."
        >
          <ProductField label="Saved environment">
            {(attrs) => (
              <ProductSelect
                {...attrs}
                value={values().selected}
                disabled={busy()}
                onChange={(event) =>
                  select(
                    environments().find(
                      (entry) => entry.id === event.currentTarget.value,
                    ),
                  )
                }
              >
                <option value="">New local environment</option>
                <For each={environments().filter((entry) => entry.root)}>
                  {(entry) => <option value={entry.id}>{entry.name}</option>}
                </For>
              </ProductSelect>
            )}
          </ProductField>
          <Text field="name" label="Environment name" />
          <Select field="channel" label="Channel" options={channels} />
          <Select
            field="kind"
            label="Source kind"
            options={[
              ['release', 'Published release'],
              ['development', 'Development - unpublished sources'],
            ]}
          />
          <Select
            field="operation"
            label="Operation"
            options={[
              ['setup', 'Install'],
              ['update', 'Update / change variant'],
              ['develop', 'Build / refresh development sources'],
              ['rollback', 'Restore previous'],
              ['move', 'Move'],
              ['stop', 'Stop engine'],
              ['doctor', 'Check drift'],
              ['gc', 'Garbage collection'],
              ['status', 'Cleanup status (read-only)'],
              ['cleanup', 'Snapshot cleanup / retry'],
              ['space', 'Disk space (read-only)'],
              ['source', 'Managed Git sources'],
            ]}
          />
          <div
            ref={(element) =>
              element.addEventListener(
                'toggle',
                (event) => {
                  if (event.target instanceof HTMLDetailsElement)
                    setAdvanced(event.target.open)
                },
                true,
              )
            }
          >
            <ProductDisclosure title="Advanced settings" open={advanced()}>
              <Text
                field="root"
                label="Install location"
                description="Absolute environment directory. Editing this selects a location; it does not move an existing environment."
              />
              <Select
                field="host"
                label="Engine host"
                options={[
                  ['native', 'This operating system'],
                  ['wsl2', 'WSL2 - private Linux disk (Windows x64)'],
                ]}
              />
              <Show when={field('host') === 'wsl2'}>
                <ProductSection title="Private WSL2 engine">
                  <ProductNotice>{wslDetail()}</ProductNotice>
                  <ProductNotice>
                    Prepare downloads Ubuntu and installs Bubblewrap in a
                    Desktop-owned distribution. Existing distributions are
                    unchanged. Windows drives and Windows executable interop are
                    disabled. Copying models creates a separate copy on the
                    Linux disk; originals and existing copies are never
                    replaced.
                  </ProductNotice>
                  <div class="dinkster-actions">
                    <ProductButton
                      disabled={busy()}
                      onClick={() =>
                        void perform(async (host) =>
                          setWslDetail((await host.wslStatus()).detail),
                        )
                      }
                    >
                      Check WSL2
                    </ProductButton>
                    <ProductButton
                      intent="add"
                      disabled={busy()}
                      onClick={() =>
                        void perform(async (host) =>
                          setWslDetail((await host.prepareWsl()).detail),
                        )
                      }
                    >
                      Prepare private distribution
                    </ProductButton>
                    <ProductButton
                      disabled={busy()}
                      onClick={() =>
                        void perform(async (host) =>
                          change(
                            'root',
                            await host.wslProjectRoot(
                              field('selected') || identity,
                            ),
                          ),
                        )
                      }
                    >
                      Use Linux environment folder
                    </ProductButton>
                    <ProductButton
                      intent="add"
                      disabled={busy()}
                      onClick={() =>
                        void perform(async (host) => {
                          const path = await host.copyWslModels()
                          if (path)
                            setNotification({
                              message: `Models copied to ${path}. Add this Linux folder in the engine's model folder settings.`,
                            })
                        })
                      }
                    >
                      Copy Windows model folder
                    </ProductButton>
                  </div>
                </ProductSection>
              </Show>
              <Text field="engine" label="Engine name" />
              <Text
                field="gpus"
                label="Assigned NVIDIA devices"
                description="Comma-separated device identifiers. Empty means explicit CPU assignment, not automatic CPU selection."
              />
              <Text
                field="port"
                label="Supervisor port"
                description="A whole number from 1 to 65535. Additional engines need distinct ports."
              />
              <ProductButton
                disabled={busy()}
                onClick={() => void perform(inspect)}
              >
                Inspect hardware and variants
              </ProductButton>
              <ProductCodeBlock label="Hardware guidance" value={hardware()} />
              <Select
                field="variant"
                label="Hardware variant"
                options={[
                  ['', 'Keep current / inspect first'],
                  ...variants().map(
                    (choice) =>
                      [
                        choice.variant,
                        `${choice.variant}${choice.supported ? '' : ' (override)'}`,
                      ] as const,
                  ),
                ]}
              />
              <Show when={selectedVariant()}>
                {(choice) => (
                  <ProductNotice>
                    {choice().reason}
                    {choice().downloadBytes !== undefined
                      ? ` Download: ${choice().downloadBytes!.toLocaleString()} bytes (reported by dinkster-env).`
                      : ''}
                  </ProductNotice>
                )}
              </Show>
              <Select
                field="cleanup"
                label="Automatic cleanup"
                options={[
                  ['keep', 'Keep preference; retry cleanup'],
                  ['off', 'Off; do not collect'],
                  ['on', 'On; do not collect now'],
                ]}
              />
              <Text
                field="keepPrevious"
                label="Previous snapshots to keep"
                description="Cleanup operation only. Leave empty to keep the preference. Allowed count: 1-100; default 1."
              />
              <ProductNotice>
                Snapshot cleanup never prunes shared caches or stops engines.
                Review retained, collectible and deferred snapshots before
                confirming. Shared caches require the separate Garbage
                collection operation.
              </ProductNotice>
              <ProductSection title="Pack sandboxing">
                <ProductCheckbox
                  label="Sandbox local pack workers"
                  checked={sandbox()}
                  disabled={busy() || (!sandboxReady() && !sandbox())}
                  onChange={(event) => {
                    invalidate()
                    setSandbox(event.currentTarget.checked)
                  }}
                />
                <ProductNotice>{sandboxDetail()}</ProductNotice>
                <ProductNotice>
                  Off by default. Save the binding to keep this choice. Stop the
                  engine before changing it. A requested sandbox never falls
                  back to an unsandboxed run. In-process packs and remote
                  workers are not sandboxed by this setting.
                </ProductNotice>
                <ProductButton
                  disabled={busy()}
                  onClick={() => void perform(checkSandbox)}
                >
                  Check sandbox availability
                </ProductButton>
              </ProductSection>
              <Text
                field="mirrors"
                label="Mirrors, in order"
                multiline
                description="One local mirror directory or HTTPS URL per line."
              />
              <Text
                field="frontendVersion"
                label="Published frontend version"
                description="Install / Update only. Leave empty to keep the selected frontend, or enter an exact published version."
              />
              <Text
                field="packageIndex"
                label="Package index for missing wheels"
                description="Optional. Leave empty to use the environment's configured index."
              />
              <Text
                field="data"
                label="Wheel store"
                description="Optional. Leave empty to use the registered store for this volume."
              />
              <Show when={field('operation') === 'move'}>
                <Text
                  field="destination"
                  label="Move destination"
                  description="Absolute destination directory. Review and confirm the Move operation separately."
                />
              </Show>
            </ProductDisclosure>
          </div>
          <Show when={field('kind') === 'development'}>
            <ProductSection
              title="Explicit development sources"
              description="Each entered source opts into unpublished code. Use an absolute folder or public HTTPS Git URL. Git sources are captured, not live; review resolved commits before confirming. No system Git is required."
            >
              <ProductNotice>
                Add #ref=BRANCH&amp;subdirectory=PATH to select a Git ref and
                package folder. Local engine and pack edits reload; local
                libraries need an engine restart. Leave optional sources empty
                to retain defaults.
              </ProductNotice>
              <Text field="developmentEngine" label="Engine source" />
              <Text
                field="developmentInference"
                label="dinkster-inference source (optional)"
              />
              <Text
                field="developmentHelper"
                label="dinkster-pack-helpers source (optional)"
              />
              <Text
                field="developmentPacks"
                label="Pack sources (one per line, optional)"
                multiline
              />
              <Text
                field="developmentFrontend"
                label="Built frontend folder (optional)"
              />
              <Text
                field="developmentFrontendGit"
                label="Frontend Git source"
                description="Instead of a folder or server."
              />
              <Text
                field="developmentFrontendDev"
                label="Frontend dev server"
                description="Instead of a built bundle."
              />
              <ProductCheckbox
                label="Explicitly allow a non-loopback frontend dev server"
                checked={allowRemoteDev()}
                disabled={busy()}
                onChange={(event) => {
                  invalidate()
                  setAllowRemoteDev(event.currentTarget.checked)
                }}
              />
              <ProductNotice>
                A dev server runs its own frontend code with this environment's
                local-file capabilities. Use a trusted server. Non-loopback
                access is off unless explicitly selected and reviewed.
              </ProductNotice>
            </ProductSection>
          </Show>
          <Show when={field('operation') === 'source'}>
            <ProductSection
              title="Managed Git sources on the installed release base"
              description="Selected Git code is unpublished and non-reproducible. Other sources and the installed release base remain selected. This does not enable development mode."
            >
              <Select
                field="sourceAction"
                label="Source action"
                options={[
                  ['add', 'Select a repository / ref'],
                  ['update', 'Update selected source / change ref'],
                  ['refs', 'List repository refs and tags (read-only)'],
                  ['release', 'Return all sources to a recorded release'],
                ]}
              />
              <Select
                field="sourceTarget"
                label="Selected component"
                options={[
                  ['engine', 'Engine'],
                  ['pack', 'Node pack'],
                  ['inference', 'Inference library'],
                  ['helper', 'Pack helpers'],
                  ['frontend', 'Frontend'],
                ]}
              />
              <Text
                field="sourceUrl"
                label="Public HTTPS repository URL"
                description="Used for Select and List refs."
              />
              <Text
                field="sourceRef"
                label="Git ref (optional)"
                description="Branch, tag, PR ref or full commit."
              />
              <Text
                field="sourceName"
                label="Pack name (required for pack update)"
              />
              <Text field="sourceMirror" label="Git mirror base (optional)" />
              <ProductNotice>
                Frontend Git uses the selected official commit's verified CI
                bundle. Without one, local build requires Node and pnpm; missing
                tools cause refusal. Review the exact commit and source
                identities before confirming.
              </ProductNotice>
            </ProductSection>
          </Show>
          <div class="dinkster-actions">
            <ProductButton
              disabled={busy()}
              onClick={() => void perform(requestReview)}
            >
              Review environment plan
            </ProductButton>
            <ProductButton
              disabled={
                busy() ||
                !field('name') ||
                !field('root') ||
                bindingState() === bindingBaseline()
              }
              onClick={() =>
                void perform(async (host) => {
                  invalidate()
                  const project = projectValue()
                  if (!project) return
                  await host.save(project)
                  await refresh(host)
                  setValues((current) => ({ ...current, selected: project.id }))
                  setBindingBaseline(bindingState())
                  identity = `project-${crypto.randomUUID()}`
                  setNotification({
                    message:
                      'Binding saved. Opening it starts the existing snapshot without installing packages.',
                  })
                })
              }
            >
              Save existing binding
            </ProductButton>
          </div>
        </ProductSection>
        <Show when={review()}>
          {(planned) => (
            <ProductSection
              title={
                planned().result.operation === 'space'
                  ? 'Managed software disk space'
                  : 'Environment plan'
              }
            >
              <ProductCodeBlock
                label="Reviewed environment details"
                value={environmentDetails(planned().result)}
              />
              <div class="dinkster-actions">
                <Show when={planned().token}>
                  <ProductButton
                    fill="solid"
                    pending={busy()}
                    onClick={() =>
                      void perform(async (host) => {
                        const approved = review()
                        const token = approved?.token
                        setReview(
                          approved ? { result: approved.result } : undefined,
                        )
                        if (!token)
                          throw new Error(
                            'Review a new environment plan before applying.',
                          )
                        const result = await host
                          .apply(token)
                          .catch((cause: unknown) => {
                            invalidate()
                            throw cause
                          })
                        if (
                          result.operation === 'cleanup' &&
                          result.status === 'applied'
                        )
                          setValues((current) => ({
                            ...current,
                            cleanup: 'keep',
                            keepPrevious: '',
                          }))
                        await refresh(host)
                        const saved = environments().find(
                          (entry) => entry.id === approved?.environment?.id,
                        )
                        if (saved && result.operation !== 'cleanup')
                          select(saved, field('engine'))
                        setReview({ result })
                        identity = `project-${crypto.randomUUID()}`
                        setNotification({
                          message:
                            result.operation === 'cleanup'
                              ? `Cleanup request returned ${result.status}. Review retained snapshots and warnings.`
                              : 'Environment operation completed. Open the engine to start working.',
                        })
                      })
                    }
                  >
                    Confirm and apply
                  </ProductButton>
                </Show>
                <ProductButton disabled={busy()} onClick={invalidate}>
                  Dismiss
                </ProductButton>
              </div>
            </ProductSection>
          )}
        </Show>
        <ProductDisclosure title="Connect a remote environment">
          <ProductNotice>
            Uses the frontend served by the remote engine. No local snapshot,
            wheel store or update journal is created.
          </ProductNotice>
          <ProductField label="Remote environment name">
            {(attrs) => (
              <ProductTextInput
                {...attrs}
                value={remote().name}
                disabled={busy()}
                onInput={(event) =>
                  setRemote({ ...remote(), name: event.currentTarget.value })
                }
              />
            )}
          </ProductField>
          <ProductField label="Server URL">
            {(attrs) => (
              <ProductTextInput
                {...attrs}
                type="url"
                value={remote().url}
                disabled={busy()}
                onInput={(event) =>
                  setRemote({ ...remote(), url: event.currentTarget.value })
                }
              />
            )}
          </ProductField>
          <ProductField label="Remote channel">
            {(attrs) => (
              <ProductSelect
                {...attrs}
                value={remote().channel}
                disabled={busy()}
                onChange={(event) =>
                  setRemote({ ...remote(), channel: event.currentTarget.value })
                }
              >
                <For each={channels}>
                  {([value, label]) => <option value={value}>{label}</option>}
                </For>
              </ProductSelect>
            )}
          </ProductField>
          <ProductButton
            intent="add"
            disabled={busy() || !remote().name.trim() || !remote().url.trim()}
            onClick={() =>
              void perform(async (host) => {
                await host.save({
                  id: `project-${crypto.randomUUID()}`,
                  name: remote().name.trim(),
                  channel: remote().channel as 'stable' | 'nightly',
                  engines: [
                    {
                      id: 'remote',
                      name: 'Remote engine',
                      kind: 'remote',
                      url: remote().url.trim(),
                    },
                  ],
                })
                await refresh(host)
                setRemote({ name: '', url: '', channel: 'stable' })
                setNotification({
                  message:
                    'Remote binding saved. Open the engine to start working.',
                })
              })
            }
          >
            Save remote binding
          </ProductButton>
        </ProductDisclosure>
        <ProductToast
          notification={notification()}
          onDismiss={() => setNotification(undefined)}
        />
        <Show when={removing()}>
          {(environment) => (
            <ProductDialog
              title="Remove environment binding"
              pending={busy()}
              onDismiss={() => {
                if (!busy()) setRemoving(undefined)
              }}
            >
              <ProductNotice>
                Remove the saved binding for {environment().name}? Environment
                files, projects and snapshots are not deleted.
              </ProductNotice>
              <div class="dinkster-actions">
                <ProductButton
                  intent="remove"
                  fill="solid"
                  pending={busy()}
                  onClick={() =>
                    void perform(async (host) => {
                      invalidate()
                      await host.remove(environment().id)
                      await refresh(host)
                      if (field('selected') === environment().id)
                        select(undefined)
                      setRemoving(undefined)
                      setNotification({
                        message: 'Environment binding removed.',
                      })
                    })
                  }
                >
                  Remove binding
                </ProductButton>
                <ProductButton
                  disabled={busy()}
                  onClick={() => setRemoving(undefined)}
                >
                  Cancel
                </ProductButton>
              </div>
            </ProductDialog>
          )}
        </Show>
      </ProductPage>
    </ProductShell>
  )
}

function environmentDetails(result: EnvironmentResult): string {
  const label = [result.status, ...result.plan, ...(result.changes ?? [])]
  if (result.base)
    label.push(
      `Variant: ${result.base.variant} (${result.base.origin})`,
      `Torch: ${result.base.torchVersion ?? 'none'}`,
      `Torch index: ${result.base.torchIndex ?? 'none'}`,
      ...(result.base.label ? [`Base label: ${result.base.label}`] : []),
    )
  if (result.engine)
    label.push(
      `Engine: ${result.engine.version} (${result.engine.release})`,
      ...(result.engine.label ? [`Engine label: ${result.engine.label}`] : []),
    )
  for (const source of result.development?.sources ?? [])
    if (source.git)
      label.push(
        `Git ${source.kind}: ${source.git.url}`,
        `Requested ref: ${source.git.requestedRef ?? 'default branch'}`,
        `Resolved commit: ${source.git.commit}`,
        `Package folder: ${source.git.subdirectory}`,
      )
  if (result.source || result.published !== undefined)
    label.push(
      `Source kind: ${result.source ?? 'source'}`,
      `Published: ${result.published === true ? 'yes' : 'no'}`,
      `Reproducible: ${result.reproducible === true ? 'yes' : 'no'}`,
    )
  if (result.sources)
    label.push(
      'Selected source identities:',
      JSON.stringify(result.sources, null, 2),
    )
  if (result.frontend)
    label.push('Selected frontend:', JSON.stringify(result.frontend, null, 2))
  if (result.restoredFrom !== undefined)
    label.push(`Restore recorded release history entry: ${result.restoredFrom}`)
  if (result.cleanup) {
    const cleanup = result.cleanup
    label.push(
      `Automatic snapshot cleanup: ${cleanup.policy ? (cleanup.policy.automatic ? 'on' : 'off') : 'unavailable'}`,
    )
    if (cleanup.policy)
      label.push(
        `Keep current and ${cleanup.policy.previousSuccessfulActivations} previous successful activation(s); minimum age ${cleanup.policy.minimumAgeSeconds}s.`,
      )
    for (const row of cleanup.generations)
      label.push(
        `Snapshot ${row.generation}: ${row.status} - ${row.reasons.join('; ')}`,
      )
    for (const row of cleanup.quarantine)
      label.push(
        `Quarantine ${row.journal} (${row.stage}): snapshots ${row.generations.join(', ')} await retry.`,
      )
    label.push(
      ...cleanup.warnings.map((warning) => `Cleanup warning: ${warning}`),
    )
    if (cleanup.lastAttempt)
      label.push(
        `Last cleanup attempt: ${cleanup.lastAttempt.status}`,
        ...(cleanup.lastAttempt.warnings ?? []).map(
          (warning) => `Cleanup warning: ${warning}`,
        ),
      )
    label.push(
      'Snapshot-only cleanup never prunes shared caches or stops engines.',
    )
  } else if (result.operation === 'status')
    label.push('Cleanup details unavailable from these environment tools.')
  if (result.cleanupAttempt)
    label.push(
      `Cleanup attempt: ${result.cleanupAttempt.status}`,
      ...(result.cleanupAttempt.warnings ?? []).map(
        (warning) => `Cleanup warning: ${warning}`,
      ),
    )
  if (result.space) {
    const space = result.space
    const bytes = (value: number | null) =>
      value === null ? 'unavailable' : `${value.toLocaleString()} bytes`
    label.push(
      `Environment: ${space.project}`,
      `Shared store: ${space.store ?? 'unavailable'}`,
      space.scope,
      space.sharing,
      `Measurement: ${space.complete ? 'complete' : 'incomplete; unknown sizes are not zero'}`,
      `Total allocated (shared files counted once): ${bytes(space.allocatedBytes)}`,
      `Observed allocation lower bound: ${bytes(space.observedAllocatedBytes)}`,
      `Shared allocation: ${bytes(space.sharedAllocatedBytes)}`,
      `Automatic cleanup would free now: ${bytes(space.automaticReclaimableBytes)}`,
      `Eligible snapshot cleanup: ${bytes(space.eligibleGenerationReclaimableBytes)}`,
      `Additional explicit store cleanup: ${bytes(space.additionalExplicitReclaimableBytes)}`,
      `Automatic snapshot cleanup: ${space.policy.automatic ? 'on' : 'off'}`,
      `Keep current and ${space.policy.previousSuccessfulActivations} previous successful activation(s); minimum age ${space.policy.minimumAgeSeconds}s.`,
      'Change preferences in Advanced settings using Snapshot cleanup / retry, then review and confirm.',
      space.settingsCommand,
      space.settingsHelp,
      '',
      'Snapshots:',
    )
    const allocation = (group: string) =>
      `${bytes(space.groups[group]!.exclusiveAllocatedBytes)} exclusive; ${bytes(space.groups[group]!.sharedAllocatedBytes)} shared (do not add shared sizes)`
    for (const row of space.generations)
      label.push(
        `Snapshot ${row.generation}: ${row.status} - ${row.reasons.join('; ')}\n  ${allocation(row.allocationGroup)}`,
      )
    label.push('', 'Shared stores (never automatically cleaned):')
    for (const row of space.stores)
      label.push(
        `${row.label}: ${allocation(row.allocationGroup)}\n  ${row.reasons.join('; ')}`,
      )
    for (const group of Object.keys(space.groups))
      if (
        !space.generations.some((row) => row.allocationGroup === group) &&
        !space.stores.some((row) => row.allocationGroup === group)
      )
        label.push(`${group}: ${allocation(group)}`)
    for (const [title, warnings] of [
      ['Measurement warning', space.warnings],
      ['Cleanup warning', space.cleanupWarnings],
      ['Eligibility warning', space.eligibilityWarnings],
      ['Reclaimability warning', space.reclaimabilityWarnings],
    ] as const)
      label.push(...warnings.map((warning) => `${title}: ${warning}`))
  }
  return label.join('\n')
}

render(
  () => <Environments />,
  document.getElementById('desktop-environments-root')!,
)

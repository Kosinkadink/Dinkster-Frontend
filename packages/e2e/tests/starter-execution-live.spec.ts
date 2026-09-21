/**
 * Opt-in live execution harness: runs advertised starters through the real
 * native backend, end to end. Unlike tests/starter-templates-live.spec.ts
 * (which only proves each template OPENS), this spec requires real asset
 * resolution, real compilation, a real queued job, and a real terminal
 * artifact of the expected kind.
 *
 * Opt-in controls:
 * - DINKSTER_STARTER_EXECUTION_E2E=1 enables the suite; without it every
 *   test skips with that one reason.
 * - DINKSTER_STARTER_EXECUTION_FAMILY=<exact family key> runs one family.
 * - DINKSTER_STARTER_RECEIPT_DIR=<dir> writes one deterministic JSON
 *   receipt plus screenshot per executed family there; requesting a
 *   receipt directory also requires DINKSTER_REVISION,
 *   DINKSTER_FRONTEND_REVISION, DINKSTER_TEST_HOST, DINKSTER_TEST_GPU and
 *   DINKSTER_STARTER_EXACT_COMMAND.
 * - DINKSTER_STARTER_OVERRIDES=<file> optionally pins per-family model
 *   replacements and bounded workflow values (see
 *   starter-execution-support.ts). Overrides never skip a starter: it is
 *   still opened through the public gallery, queued, and executed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  expect,
  openRailPanel,
  selectProductOption,
  test,
  type Page,
} from './fixtures.js'
import {
  COMPOSITION_BLOCKER_FAMILIES,
  MEDIA_PREFIX_FOR_KIND,
  STARTER_FAMILIES,
  STARTER_ROWS,
  parseStarterOverrides,
  type StarterFamilyOverride,
  type StarterOverrides,
  type StarterRow,
} from './starter-execution-support.js'

const NATIVE_BACKEND =
  process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const EXECUTION_ENABLED =
  process.env['DINKSTER_STARTER_EXECUTION_E2E'] === '1'
const FAMILY_FILTER = process.env['DINKSTER_STARTER_EXECUTION_FAMILY']
const RECEIPT_DIR = process.env['DINKSTER_STARTER_RECEIPT_DIR']
if (RECEIPT_DIR !== undefined) mkdirSync(RECEIPT_DIR, { recursive: true })

interface TemplateCatalogEntry {
  readonly pack: string
  readonly id: string
  readonly name: string
  readonly family?: string
  readonly models?: readonly string[]
  readonly digest?: string
}

interface ResolvedCandidate {
  readonly digest: string
  readonly name: string
  readonly confidence: string
  readonly held: boolean
  readonly virtualPath?: string
  readonly size?: number
  readonly mediaType?: string
}

interface ModelResolution {
  readonly documented: string
  /** Whether the documented name itself resolved or a pinned override ran. */
  readonly applied: 'documented' | 'override'
  readonly replacement?: string
  readonly candidate: ResolvedCandidate
}

interface AppliedOverride {
  readonly node: string
  readonly input: string
  readonly kind: 'model' | 'value'
  readonly documentedValue?: string
  readonly replacement?: string
  readonly sizeBytes?: number
  readonly sha256?: string
  readonly value: unknown
  /** Resolver candidate for model rows; value rows replace no asset. */
  readonly resolved?: ResolvedCandidate
}

interface SubmittedJob {
  readonly clientId: string
  readonly jobId: string
  readonly graph: unknown
  readonly [key: string]: unknown
}

let catalogCache: Promise<readonly TemplateCatalogEntry[]> | undefined
function catalogEntries(): Promise<readonly TemplateCatalogEntry[]> {
  catalogCache ??= (async () => {
    const response = await fetch(`${NATIVE_BACKEND}/api/templates?limit=200`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`GET /api/templates failed with ${response.status} at ${NATIVE_BACKEND}`)
    }
    const payload = (await response.json()) as { templates?: TemplateCatalogEntry[] }
    if (!Array.isArray(payload.templates)) {
      throw new Error(`GET /api/templates at ${NATIVE_BACKEND} returned a malformed catalog`)
    }
    return payload.templates
  })()
  return catalogCache
}

/**
 * Require an exact one-to-one family matrix between the native catalog and
 * the reviewed starter rows before anything executes, regardless of any
 * family filter. Absent Qwen Image, TripoSplat, Wan 2.1 or Wan 2.2 templates
 * are reported as the issue 248 composition blocker without preventing the
 * available rows from executing. Every other gap, duplicate, id drift or
 * unlisted family is an ordinary failure. No pack reloads or retries.
 */
interface CatalogMatrix {
  readonly catalog: ReadonlyMap<string, TemplateCatalogEntry>
  readonly compositionBlockers: readonly string[]
}

function compositionBlockerMessage(families: readonly string[]): string {
  return (
    `composition blocker: the native catalog at ${NATIVE_BACKEND} is missing the ${families.join(', ')} ` +
    'starter template(s) because their packs do not compose in a normal launch; tracked by wrapper ' +
    'issue 248 (https://github.com/Kosinkadink/comfy-vibe-station/issues/248). Pack reloads and retries ' +
    'are disabled by design.'
  )
}

function requireCatalogMatrix(
  entries: readonly TemplateCatalogEntry[],
): CatalogMatrix {
  const byFamily = new Map<string, TemplateCatalogEntry>()
  for (const entry of entries) {
    if (typeof entry.family !== 'string' || !entry.family.startsWith('dinkster.')) continue
    expect(
      byFamily.has(entry.family),
      `duplicate starter family '${entry.family}' in the template catalog`,
    ).toBe(false)
    byFamily.set(entry.family, entry)
  }
  const missing = STARTER_ROWS.filter((row) => !byFamily.has(row.family))
  const blockers = missing
    .filter((row) => COMPOSITION_BLOCKER_FAMILIES.includes(row.family))
    .map((row) => row.family)
  expect(
    missing
      .filter((row) => !COMPOSITION_BLOCKER_FAMILIES.includes(row.family))
      .map((row) => row.family),
    `template catalog gaps at ${NATIVE_BACKEND}`,
  ).toEqual([])
  expect(
    STARTER_ROWS
      .filter((row) => byFamily.has(row.family) && byFamily.get(row.family)!.id !== row.templateId)
      .map((row) => `${row.family}: catalog serves '${String(byFamily.get(row.family)?.id)}'`),
    'template ids drifted from the execution matrix',
  ).toEqual([])
  expect(
    [...byFamily.keys()].filter((family) => !STARTER_FAMILIES.includes(family)),
    'unlisted starter families appeared in the catalog; extend the execution matrix',
  ).toEqual([])
  return { catalog: byFamily, compositionBlockers: blockers }
}

async function resolveHeldCandidate(page: Page, name: string): Promise<ResolvedCandidate> {
  const response = await page.request.post(`${NATIVE_BACKEND}/api/assets/guess`, {
    data: { names: [name] },
  })
  if (!response.ok()) {
    throw new Error(`POST /api/assets/guess failed with ${response.status()} for '${name}'`)
  }
  const payload = (await response.json()) as {
    matches?: readonly { query: string; candidates: readonly ResolvedCandidate[] }[]
  }
  const match = payload.matches?.find((candidate) => candidate.query === name)
  if (match === undefined) {
    throw new Error(`POST /api/assets/guess omitted '${name}' from its matches`)
  }
  const held = match.candidates.filter((candidate) => candidate.held)
  if (match.candidates.length !== 1 || held.length !== 1) {
    throw new Error(
      `documented model '${name}' must resolve to exactly one held candidate, ` +
        `got ${match.candidates.length} candidate(s), ${held.length} held`,
    )
  }
  return held[0]!
}

/**
 * Resolve every documented template model name through the REAL resolver
 * (never mocked here). Default: each documented name must resolve to
 * exactly one held candidate. A pinned override replaces exactly the
 * documented value it names: the replacement must resolve to one held
 * candidate whose size matches the pinned byte size.
 */
async function resolveDocumentedModels(
  page: Page,
  entry: TemplateCatalogEntry,
  familyOverride: StarterFamilyOverride | undefined,
): Promise<readonly ModelResolution[]> {
  const documented = entry.models ?? []
  expect(
    documented.length,
    `template '${entry.id}' advertises no documented models`,
  ).toBeGreaterThan(0)
  const resolutions: ModelResolution[] = []
  for (const name of documented) {
    const override = familyOverride?.models.find((row) => row.documentedValue === name)
    if (override === undefined) {
      resolutions.push({
        documented: name,
        applied: 'documented',
        candidate: await resolveHeldCandidate(page, name),
      })
      continue
    }
    const candidate = await resolveHeldCandidate(page, override.replacement)
    if (candidate.size !== undefined && candidate.size !== override.sizeBytes) {
      throw new Error(
        `pinned override for '${name}' resolves to '${override.replacement}' with ` +
          `${candidate.size} bytes, but the override pins ${override.sizeBytes} bytes`,
      )
    }
    resolutions.push({
      documented: name,
      applied: 'override',
      replacement: override.replacement,
      candidate,
    })
  }
  return resolutions
}

async function connect(page: Page): Promise<string> {
  await page.goto('/')
  await expect
    .poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined))
    .toBe(true)
  await page.getByTestId('backends-toggle').click()
  await page.getByTestId('backend-url-input').fill(NATIVE_BACKEND)
  await page.getByTestId('backend-add').click()
  await expect(page.getByTestId('tab-target')).toBeVisible()
  await selectProductOption(
    page,
    page.getByTestId('tab-target'),
    NATIVE_BACKEND,
  )
  const owner = await page.evaluate((baseUrl) => {
    const backend = window
      .__dinksterTest!.app.backends.get()
      .find((candidate) => candidate.baseUrl === baseUrl)
    if (backend === undefined)
      throw new Error(`backend ${baseUrl} was not registered`)
    return backend.id
  }, NATIVE_BACKEND)
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window
            .__dinksterTest!.app.backends.get()
            .find((backend) => backend.id === id)
            ?.registry.get() !== undefined,
        owner,
      ),
    )
    .toBe(true)
  await page.evaluate((ownerId) => {
    const app = window.__dinksterTest!.app
    for (const backend of app.backends.get()) {
      if (backend.id !== ownerId) app.removeBackend(backend.id)
    }
    const ownedProblems = app as unknown as {
      problems: { get(): readonly { owner: unknown; code: string }[] }
      clearProblems(owner: unknown): void
    }
    for (const problem of ownedProblems.problems.get()) {
      if (
        problem.code === 'schema.fetchFailed' ||
        problem.code === 'schema.refreshFailed'
      ) {
        ownedProblems.clearProblems(problem.owner)
      }
    }
  }, owner)
  return owner
}

async function errorProblems(page: Page): Promise<readonly string[]> {
  return page.evaluate(() =>
    window
      .__dinksterTest!.app.problems.get()
      .filter((problem) => problem.severity === 'error')
      .map((problem) => `${problem.code}: ${problem.message}`),
  )
}

async function openTemplateGallery(page: Page): Promise<void> {
  await page.getByTestId('topbar-search').click()
  await page
    .getByTestId('universal-search-input')
    .fill('> Open template gallery')
  await page
    .locator('[data-provider="core.commands"]')
    .getByRole('option', { name: 'Open template gallery' })
    .click()
}

/**
 * Open one starter through the VISIBLE public controls: activate its
 * gallery entry. The execution path never calls app.openTemplate.
 */
async function openStarterThroughGallery(page: Page, row: StarterRow): Promise<void> {
  await openTemplateGallery(page)
  const gallery = page.getByTestId('template-gallery')
  await expect(gallery).toBeVisible()
  const card = gallery
    .locator(`section[data-family="${row.family}"] [data-testid="template-card"]`)
    .first()
  await expect(card, `gallery has no entry for '${row.family}'`).toBeVisible({
    timeout: 30_000,
  })
  await card.click()
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__dinksterTest!.app.activeTab()?.store.doc.lineage,
      ),
    )
    .toBe(`starter-${row.templateId}`)
}

async function documentNode(
  page: Page,
  nodeId: string,
): Promise<{ graphId: string; values: Record<string, unknown> }> {
  const node = await page.evaluate((id) => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    for (const [graphId, graph] of Object.entries(doc.graphs)) {
      const found = graph.nodes[id]
      if (found !== undefined) return { graphId, values: found.values }
    }
    return undefined
  }, nodeId)
  expect(node, `document has no node '${nodeId}'`).toBeDefined()
  return node!
}

function assetValueFromCandidate(candidate: ResolvedCandidate): Record<string, unknown> {
  return {
    digest: candidate.digest,
    name: candidate.name,
    ...(candidate.size === undefined ? {} : { size: candidate.size }),
    ...(candidate.mediaType === undefined ? {} : { mediaType: candidate.mediaType }),
    ...(candidate.virtualPath === undefined ? {} : { virtualPath: candidate.virtualPath }),
  }
}

/**
 * Apply one family's overrides through the ordinary document command
 * (node.setValue) before compilation, refusing stale or misplaced rows.
 * Model replacements reuse the candidates already resolved by
 * resolveDocumentedModels; the real resolver is not consulted again.
 */
async function applyOverrides(
  page: Page,
  row: StarterRow,
  entry: TemplateCatalogEntry,
  familyOverride: StarterFamilyOverride,
  resolutions: readonly ModelResolution[],
): Promise<readonly AppliedOverride[]> {
  const documented = entry.models ?? []
  const replaced = new Map<string, ModelResolution>(
    resolutions
      .filter((resolution) => resolution.applied === 'override')
      .map((resolution) => [resolution.documented, resolution]),
  )
  const applied: AppliedOverride[] = []
  for (const model of familyOverride.models) {
    expect(
      documented.includes(model.documentedValue),
      `override for '${row.family}' names documented value '${model.documentedValue}', ` +
        `which template '${entry.id}' does not advertise (advertised: ${documented.join(', ')})`,
    ).toBe(true)
    const node = await documentNode(page, model.node)
    const current = node.values[model.input]
    const currentName =
      typeof current === 'string'
        ? current
        : typeof current === 'object' && current !== null && typeof (current as Record<string, unknown>)['name'] === 'string'
          ? ((current as Record<string, unknown>)['name'] as string)
          : undefined
    expect(
      currentName,
      `node '${model.node}' input '${model.input}' holds '${String(current)}', not the documented ` +
        `'${model.documentedValue}' the override replaces`,
    ).toBe(model.documentedValue)
    const resolution = replaced.get(model.documentedValue)
    expect(
      resolution,
      `override for '${model.documentedValue}' has no resolved replacement candidate`,
    ).toBeDefined()
    const resolved = resolution!.candidate
    const value = assetValueFromCandidate(resolved)
    await dispatchSetValue(page, node.graphId, model.node, model.input, value)
    applied.push({
      node: model.node,
      input: model.input,
      kind: 'model',
      documentedValue: model.documentedValue,
      replacement: model.replacement,
      sizeBytes: model.sizeBytes,
      sha256: model.sha256,
      value,
      resolved,
    })
  }
  for (const bounded of familyOverride.values) {
    const node = await documentNode(page, bounded.node)
    expect(
      bounded.input in node.values,
      `node '${bounded.node}' has no input '${bounded.input}' to override`,
    ).toBe(true)
    await dispatchSetValue(page, node.graphId, bounded.node, bounded.input, bounded.value)
    applied.push({
      node: bounded.node,
      input: bounded.input,
      kind: 'value',
      value: bounded.value,
    })
  }
  return applied
}

async function dispatchSetValue(
  page: Page,
  graphId: string,
  nodeId: string,
  inputId: string,
  value: unknown,
): Promise<void> {
  const outcome = await page.evaluate(
    ({ graphId, nodeId, inputId, value }) => {
      const app = window.__dinksterTest!.app
      return app.dispatchTo(app.activeTab()!, {
        command: 'node.setValue',
        params: { graphId, nodeId, inputId, value },
      })
    },
    { graphId, nodeId, inputId, value },
  )
  expect(
    outcome.ok,
    `node.setValue failed for '${nodeId}.${inputId}': ${JSON.stringify(outcome.diagnostics ?? [])}`,
  ).toBe(true)
}

function collectDescriptorMediaTypes(value: unknown, into: string[]): void {
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  const meta = record['meta']
  if (typeof meta === 'object' && meta !== null && typeof (meta as Record<string, unknown>)['mediaType'] === 'string') {
    into.push((meta as Record<string, unknown>)['mediaType'] as string)
  }
  if (Array.isArray(record['elements'])) {
    for (const element of record['elements']) collectDescriptorMediaTypes(element, into)
  }
}

let overridesCache: StarterOverrides | undefined
function starterOverrides(): StarterOverrides | undefined {
  const path = process.env['DINKSTER_STARTER_OVERRIDES']
  if (path === undefined) return undefined
  overridesCache ??= parseStarterOverrides(readFileSync(path, 'utf8'))
  return overridesCache
}

let receiptEnvironmentCache: Record<string, string> | undefined
function receiptEnvironment(): Record<string, string> {
  receiptEnvironmentCache ??= (() => {
    const values: Record<string, string> = {}
    const missing: string[] = []
    for (const key of [
      'DINKSTER_REVISION',
      'DINKSTER_FRONTEND_REVISION',
      'DINKSTER_TEST_HOST',
      'DINKSTER_TEST_GPU',
      'DINKSTER_STARTER_EXACT_COMMAND',
    ]) {
      const value = process.env[key]
      if (value === undefined || value === '') missing.push(key)
      else values[key] = value
    }
    if (missing.length > 0) {
      throw new Error(
        `DINKSTER_STARTER_RECEIPT_DIR was requested, so the owning environment must be identified: ` +
          `set ${missing.join(', ')}`,
      )
    }
    return values
  })()
  return receiptEnvironmentCache
}

function executionTimestamp(terminal: Record<string, unknown>): string {
  const submittedAt = terminal['submittedAt']
  if (typeof submittedAt === 'string') return submittedAt
  if (typeof submittedAt === 'number' && Number.isFinite(submittedAt)) {
    return new Date(submittedAt * 1000).toISOString()
  }
  return `unknown: ${JSON.stringify(submittedAt)}`
}

function invocationRecord(): Record<string, unknown> {
  return {
    command: process.env['DINKSTER_STARTER_EXACT_COMMAND'],
    worker: process.argv
      .map((argument) => (argument.includes(' ') ? JSON.stringify(argument) : argument))
      .join(' '),
    environment: {
      DINKSTER_NATIVE_BACKEND: NATIVE_BACKEND,
      DINKSTER_STARTER_EXECUTION_E2E: process.env['DINKSTER_STARTER_EXECUTION_E2E'],
      DINKSTER_STARTER_EXECUTION_FAMILY: FAMILY_FILTER,
      DINKSTER_STARTER_OVERRIDES: process.env['DINKSTER_STARTER_OVERRIDES'],
      DINKSTER_STARTER_RECEIPT_DIR: RECEIPT_DIR,
    },
  }
}

for (const row of STARTER_ROWS) {
  test(`executes the ${row.templateId} starter end to end through the real backend`, async ({
    page,
  }) => {
    test.setTimeout(90 * 60_000)
    test.skip(
      !EXECUTION_ENABLED,
      'live starter execution is opt-in: set DINKSTER_STARTER_EXECUTION_E2E=1 to run it against the real native backend',
    )
    test.skip(
      FAMILY_FILTER !== undefined && FAMILY_FILTER !== row.family,
      'DINKSTER_STARTER_EXECUTION_FAMILY selects a different starter family',
    )
    if (FAMILY_FILTER !== undefined && !STARTER_FAMILIES.includes(FAMILY_FILTER)) {
      throw new Error(
        `DINKSTER_STARTER_EXECUTION_FAMILY '${FAMILY_FILTER}' is not a starter family from the execution matrix`,
      )
    }
    const environment = RECEIPT_DIR === undefined ? undefined : receiptEnvironment()
    const startedAt = new Date().toISOString()

    const entries = await catalogEntries()
    const { catalog, compositionBlockers } = requireCatalogMatrix(entries)
    if (compositionBlockers.length > 0) {
      await test.info().attach('starter-composition-blockers', {
        body: compositionBlockerMessage(compositionBlockers),
        contentType: 'text/plain',
      })
    }
    const entry = catalog.get(row.family)
    if (entry === undefined) {
      throw new Error(compositionBlockerMessage([row.family]))
    }
    const familyOverride = starterOverrides()?.get(row.family)

    await connect(page)
    await openStarterThroughGallery(page, row)

    // Real resolver, real candidates: documented names (or their pinned
    // replacements) must each resolve to exactly one held candidate
    // BEFORE compilation.
    const resolutions = await resolveDocumentedModels(page, entry, familyOverride)
    const applied =
      familyOverride === undefined
        ? []
        : await applyOverrides(page, row, entry, familyOverride, resolutions)

    await openRailPanel(page, 'Problems')
    const panelErrors = page
      .getByTestId('problems-panel')
      .locator('.problem[data-severity="error"]')
    expect(await errorProblems(page), row.family).toEqual([])
    await expect(panelErrors, row.family).toHaveCount(0)

    // The opened starter must carry the matrix's save node with the
    // matrix's save-target prefix.
    const saveNodes = await page.evaluate((saveType) => {
      const doc = window.__dinksterTest!.app.activeTab()!.store.doc
      return Object.values(doc.graphs).flatMap((graph) =>
        Object.values(graph.nodes)
          .filter((node) => node.type === saveType)
          .map((node) => ({ id: node.id, target: node.values['target'] })),
      )
    }, row.saveNodeType)
    expect(
      saveNodes,
      `opened '${row.templateId}' has no ${row.saveNodeType} node`,
    ).not.toEqual([])
    expect(
      saveNodes.map((node) => (node.target as { prefix?: unknown } | undefined)?.prefix),
      `${row.saveNodeType} save-target prefixes in '${row.templateId}'`,
    ).toContain(row.saveTargetPrefix)

    const compiled = await page.evaluate(() => {
      const app = window.__dinksterTest!.app
      return app.compileTab(app.activeTab()!)
    })
    expect(
      compiled?.ok ?? false,
      `compileTab failed for '${row.templateId}': ${JSON.stringify(compiled?.ok === false ? compiled.diagnostics : [])}`,
    ).toBe(true)

    // Queue through the visible workflow queue control and capture the
    // actual POST /api/jobs body on its way through.
    let submitted: SubmittedJob | undefined
    await page.route('**/api/jobs', async (route) => {
      submitted = route.request().postDataJSON() as SubmittedJob
      const response = await route.fetch()
      await route.fulfill({ response })
    })
    await expect(page.getByTestId('queue-button')).toBeEnabled({
      timeout: 30_000,
    })
    await page.getByTestId('queue-button').click()
    await expect
      .poll(
        () => submitted !== undefined,
        { timeout: 30_000, message: 'queue click never reached POST /api/jobs' },
      )
      .toBe(true)
    await page.unroute('**/api/jobs')

    let terminal: Record<string, unknown> = {}
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `${NATIVE_BACKEND}/api/jobs/${encodeURIComponent(submitted!.clientId)}/${encodeURIComponent(submitted!.jobId)}`,
        )
        expect(
          response.ok(),
          `GET /api/jobs returned ${response.status()}`,
        ).toBe(true)
        terminal = (await response.json()) as Record<string, unknown>
        if (terminal['state'] === 'failed' || terminal['state'] === 'cancelled') {
          throw new Error(
            `starter '${row.templateId}' job ended '${String(terminal['state'])}': ${JSON.stringify(terminal)}`,
          )
        }
        return terminal['state']
      }, {
        timeout: 60 * 60_000,
        intervals: [2_000, 5_000, 10_000],
        message: `starter '${row.templateId}' job never reached a terminal state`,
      })
      .toBe('completed')

    // A real execution must produce the expected save-node output: both a
    // value descriptor and a saved artifact of the expected media kind.
    const prefix = MEDIA_PREFIX_FOR_KIND[row.outputKind]
    const outputs = (terminal['outputs'] ?? {}) as Record<string, Record<string, unknown>>
    const descriptorMediaTypes: string[] = []
    for (const byOutput of Object.values(outputs)) {
      for (const descriptor of Object.values(byOutput)) {
        collectDescriptorMediaTypes(descriptor, descriptorMediaTypes)
      }
    }
    expect(
      descriptorMediaTypes.some((mediaType) => mediaType.startsWith(prefix)),
      `terminal outputs carry no ${row.outputKind} descriptor (${prefix}); media kinds seen: ` +
        `${JSON.stringify(descriptorMediaTypes)}`,
    ).toBe(true)
    const artifacts = (terminal['artifacts'] ?? []) as readonly {
      digest?: string
      mediaType?: string
      name?: string
      virtualPath?: string
    }[]
    expect(
      artifacts.filter(
        (artifact) =>
          typeof artifact.mediaType === 'string' && artifact.mediaType.startsWith(prefix),
      ),
      `terminal job saved no ${row.outputKind} artifact (${prefix}); artifacts seen: ` +
        `${JSON.stringify(artifacts)}`,
    ).not.toEqual([])

    const screenshotName = `${row.templateId}.png`
    const screenshotPath =
      RECEIPT_DIR === undefined
        ? test.info().outputPath(screenshotName)
        : join(RECEIPT_DIR, screenshotName)
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
      animations: 'disabled',
    })
    await test
      .info()
      .attach(`starter-execution-${row.templateId}`, { path: screenshotPath })

    if (RECEIPT_DIR !== undefined) {
      const receipt = {
        family: row.family,
        executedAt: executionTimestamp(terminal),
        invocation: invocationRecord(),
        template: { id: entry.id, name: entry.name, pack: entry.pack, digest: entry.digest },
        compositionBlockers,
        outputKind: row.outputKind,
        saveNodeType: row.saveNodeType,
        saveTargetPrefix: row.saveTargetPrefix,
        backendUrl: NATIVE_BACKEND,
        documentedModels: resolutions,
        overrides: applied,
        submittedJob: submitted,
        terminalJob: terminal,
        outputArtifacts: artifacts,
        outputDescriptorMediaKinds: descriptorMediaTypes,
        screenshot: screenshotName,
        startedAt,
        completedAt: new Date().toISOString(),
        environment,
      }
      writeFileSync(
        join(RECEIPT_DIR, `${row.templateId}.receipt.json`),
        `${JSON.stringify(receipt, null, 2)}\n`,
      )
    }
  })
}

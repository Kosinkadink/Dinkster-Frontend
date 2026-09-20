import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const yaml = createRequire(import.meta.url)('js-yaml') as {
  load(source: string): unknown
}
interface Step {
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Job {
  if?: string
  needs?: string | string[]
  uses?: string
  secrets?: string
  outputs?: Record<string, string>
  'runs-on'?: string | string[]
  'timeout-minutes'?: number
  strategy?: {
    'fail-fast': boolean
    matrix: string
  }
  steps?: Step[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency?: Record<string, string>
  jobs: Record<string, Job>
}
const load = async (name: string): Promise<Workflow> =>
  yaml.load(
    await readFile(resolve(root, '.github/workflows', name), 'utf8'),
  ) as Workflow
const fast = await load('ci.yml')
const full = await load('full-validation.yml')
const release = await load('release-desktop.yml')
const script = await readFile(resolve(root, 'scripts/ci-fast.mjs'), 'utf8')
const testingDocs = (
  await readFile(resolve(root, 'docs/testing.md'), 'utf8')
).replace(/\r?\n/g, ' ')

describe('fast pull-request and full validation workflows', () => {
  it('runs exactly one bounded job without a PR label path', () => {
    expect(fast.on).toEqual({ pull_request: null, workflow_dispatch: null })
    expect(Object.keys(fast.jobs)).toEqual(['fast'])
    const job = fast.jobs['fast']!
    expect(job['timeout-minutes']).toBe(5)
    expect(job['runs-on']).toBe(
      '${{ fromJSON(vars.DINKSTER_PR_RUNNER || \'["self-hosted", "linux", "x64"]\') }}',
    )
    expect(job.steps!.flatMap((step) => step.run ?? [])).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm ci:fast',
    ])
    expect(job.steps!.flatMap((step) => step.uses ?? [])).toEqual([
      'actions/checkout@v4',
      './.github/actions/configure-dinkster-identity',
      'actions/checkout@v4',
      'actions/setup-python@v5',
      'pnpm/action-setup@v4',
      'actions/setup-node@v4',
    ])
    expect(script).toContain('gen_extension_contribution_kinds.py')
    expect(script).toContain("['check:ui-strings']")
    expect(script).toContain("['typecheck']")
    expect(script).toContain("'prettier'")
    expect(script).toContain("'--check'")
    expect(script.match(/(?<!\/)test\/[\w.-]+\.test\.ts/g)).toEqual([
      'test/format.schema.test.ts',
      'test/dinkster-graph.test.ts',
      'test/dinkster-inline-value.test.ts',
      'test/ci-workflow.test.ts',
      'test/published-verification.test.ts',
    ])
    expect(script).not.toMatch(
      /playwright|pnpm test|build|prepare:engine|verify:installed/,
    )
  })

  it('runs every heavy lane through one guarded reusable workflow', () => {
    expect(full.on).toEqual({
      push: { branches: ['main'] },
      schedule: [
        { cron: '0 6-22/2 * * *', timezone: 'America/Los_Angeles' },
        { cron: '43 10 * * *' },
      ],
      workflow_dispatch: null,
      workflow_call: null,
    })
    expect(full.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(full.concurrency).toEqual({
      group:
        "ci-${{ github.workflow }}-${{ github.ref }}-${{ github.event_name == 'push' && 'push' || 'durable' }}",
      'cancel-in-progress': "${{ github.event_name == 'push' }}",
    })
    expect(Object.keys(full.jobs)).toEqual([
      'validation-plan',
      'fast',
      'ci',
      'e2e-suite',
      'e2e',
    ])
    const plan = full.jobs['validation-plan']!
    expect(plan.outputs).toEqual({
      'run-heavy': '${{ steps.plan.outputs.run-heavy }}',
      'e2e-matrix': '${{ steps.plan.outputs.e2e-matrix }}',
    })
    const planScript = plan.steps![0]!.with!['script'] as string
    expect(
      planScript.match(/^\s+\{ name: .+ \},$/gm)?.map((entry) => entry.trim()),
    ).toEqual([
      "{ name: 'parallel 1/4', project: 'parallel-safe', shard: '--shard=1/4' },",
      "{ name: 'parallel 2/4', project: 'parallel-safe', shard: '--shard=2/4' },",
      "{ name: 'parallel 3/4', project: 'parallel-safe', shard: '--shard=3/4' },",
      "{ name: 'parallel 4/4', project: 'parallel-safe', shard: '--shard=4/4', push: true },",
      "{ name: 'backend serial 1/2', project: 'backend-serial', shard: '--shard=1/2', vulkan: true, push: true },",
      "{ name: 'backend serial 2/2', project: 'backend-serial', shard: '--shard=2/2' },",
      "{ name: 'performance', project: 'performance', shard: '' },",
    ])
    for (const required of [
      "context.eventName !== 'schedule'",
      "workflow_id: 'full-validation.yml'",
      "branch: 'main'",
      "status: 'success'",
      'per_page: 1',
      'workflow_runs[0]?.head_sha === context.sha',
      "context.eventName === 'push'",
      'fullMatrix.filter((entry) => entry.push)',
      "core.setOutput('e2e-matrix', JSON.stringify({ include: selected }))",
    ])
      expect(planScript).toContain(required)
    expect(full.jobs['fast']!.needs).toBe('validation-plan')
    expect(full.jobs['fast']!.if).toBe(
      "needs.validation-plan.outputs.run-heavy == 'true' && github.event_name == 'push'",
    )
    expect(full.jobs['fast']!.steps).toEqual(fast.jobs['fast']!.steps)
    expect(full.jobs['ci']!.needs).toBe('validation-plan')
    expect(full.jobs['ci']!.if).toBe(
      "needs.validation-plan.outputs.run-heavy == 'true' && github.event_name != 'push'",
    )
    expect(full.jobs['e2e-suite']!.needs).toBe('validation-plan')
    expect(full.jobs['e2e-suite']!.if).toBe(
      "needs.validation-plan.outputs.run-heavy == 'true'",
    )
    expect(testingDocs).toContain(
      '`on.schedule` cron list in that file is the single schedule definition',
    )
    expect(full.jobs['e2e-suite']!.strategy).toEqual({
      'fail-fast': false,
      matrix: '${{ fromJSON(needs.validation-plan.outputs.e2e-matrix) }}',
    })
    expect(full.jobs['e2e']!.if).toBe(
      "always() && needs.validation-plan.outputs.run-heavy == 'true'",
    )
    expect(full.jobs['e2e']!.needs).toEqual(['validation-plan', 'e2e-suite'])
    for (const job of Object.values(full.jobs))
      expect(job['runs-on']).toEqual(['self-hosted', 'linux', 'x64'])
    expect(full.jobs['e2e']!.steps).toEqual([
      {
        name: 'Verify every full-suite lane passed',
        run: "test '${{ needs.e2e-suite.result }}' = success",
      },
    ])
  })

  it('retains clean checkouts, ref selection, read-only credentials and isolated browser ports', () => {
    for (const workflow of [fast, full]) {
      expect(workflow.permissions['contents']).toBe('read')
      for (const job of Object.values(workflow.jobs)) {
        for (const step of (job.steps ?? []).filter(
          (step) => step.uses === 'actions/checkout@v4',
        )) {
          expect(step.with).toMatchObject({
            clean: true,
            'persist-credentials': false,
          })
          expect(step.with).not.toHaveProperty('ssh-key')
          if (!step.with?.['repository'])
            expect(step.with).not.toHaveProperty('ref')
        }
      }
    }
    for (const name of ['ci', 'e2e-suite']) {
      const steps = full.jobs[name]!.steps!
      expect(
        steps.filter(
          (step) =>
            step.uses === './.github/actions/configure-dinkster-identity',
        ),
      ).toHaveLength(2)
      const browser = steps.find((step) =>
        step.run?.includes('playwright test'),
      )!
      expect(browser.run).toContain('bash scripts/ci-browser.sh')
      expect(browser.env?.['DINKSTER_E2E_PORT']).toBe(
        name === 'ci' ? '15376' : '15410',
      )
      if (name === 'e2e-suite') {
        expect(browser.run).toContain('run_counted_suite.sh')
        expect(browser.env).toMatchObject({
          DINKSTER_E2E_COMFY_PORT: '15411',
          DINKSTER_E2E_NATIVE_PORT: '15412',
          DINKSTER_NATIVE_BACKEND: 'http://127.0.0.1:15412',
        })
      }
    }
  })

  it('validates the exact desktop release commit before publication', () => {
    expect(release.jobs['validation']).toEqual({
      if: "github.repository == 'Kosinkadink/Dinkster-Frontend' && github.event.repository.private == true && github.ref == 'refs/heads/main'",
      uses: './.github/workflows/full-validation.yml',
      secrets: 'inherit',
    })
    expect(release.jobs['release']!.needs).toBe('validation')
    expect(release.jobs['release']!.if).toBe(release.jobs['validation']!.if)
    expect(release.jobs['release']!.steps).toBeDefined()
  })
})

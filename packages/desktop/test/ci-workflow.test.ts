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
  needs?: string
  'runs-on': string | string[]
  'timeout-minutes'?: number
  strategy?: {
    matrix: { include: { name: string; project: string; shard: string }[] }
  }
  steps: Step[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<string, Job>
}
const load = async (name: string): Promise<Workflow> =>
  yaml.load(
    await readFile(resolve(root, '.github/workflows', name), 'utf8'),
  ) as Workflow
const fast = await load('ci.yml')
const full = await load('full-validation.yml')
const script = await readFile(resolve(root, 'scripts/ci-fast.mjs'), 'utf8')

describe('fast pull-request and full validation workflows', () => {
  it('runs exactly one bounded job without a PR label path', () => {
    expect(fast.on).toEqual({ pull_request: null, workflow_dispatch: null })
    expect(Object.keys(fast.jobs)).toEqual(['fast'])
    const job = fast.jobs['fast']!
    expect(job['timeout-minutes']).toBe(5)
    expect(job['runs-on']).toBe(
      '${{ fromJSON(vars.DINKSTER_PR_RUNNER || \'["self-hosted", "linux", "x64"]\') }}',
    )
    expect(job.steps.flatMap((step) => step.run ?? [])).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm ci:fast',
    ])
    expect(job.steps.flatMap((step) => step.uses ?? [])).toEqual([
      'actions/checkout@v4',
      'pnpm/action-setup@v4',
      'actions/setup-node@v4',
    ])
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

  it('runs every heavy lane on main, daily and dispatch, with the aggregate always evaluated', () => {
    expect(full.on).toEqual({
      push: { branches: ['main'] },
      schedule: [{ cron: '43 10 * * *' }],
      workflow_dispatch: null,
    })
    expect(Object.keys(full.jobs)).toEqual(['ci', 'e2e-suite', 'e2e'])
    expect(full.jobs['ci']!.if).toBeUndefined()
    expect(full.jobs['e2e-suite']!.if).toBeUndefined()
    expect(
      full.jobs['e2e-suite']!.strategy!.matrix.include.map(
        ({ name, project, shard }) => ({ name, project, shard }),
      ),
    ).toEqual([
      { name: 'parallel 1/4', project: 'parallel-safe', shard: '--shard=1/4' },
      { name: 'parallel 2/4', project: 'parallel-safe', shard: '--shard=2/4' },
      { name: 'parallel 3/4', project: 'parallel-safe', shard: '--shard=3/4' },
      { name: 'parallel 4/4', project: 'parallel-safe', shard: '--shard=4/4' },
      {
        name: 'backend serial 1/2',
        project: 'backend-serial',
        shard: '--shard=1/2',
      },
      {
        name: 'backend serial 2/2',
        project: 'backend-serial',
        shard: '--shard=2/2',
      },
      { name: 'performance', project: 'performance', shard: '' },
    ])
    expect(full.jobs['e2e']!.if).toBe('always()')
    expect(full.jobs['e2e']!.needs).toBe('e2e-suite')
    expect(full.jobs['e2e']!.steps).toEqual([
      {
        name: 'Verify every full-suite lane passed',
        run: "test '${{ needs.e2e-suite.result }}' = success",
      },
    ])
  })

  it('retains clean checkouts, ref selection, read-only credentials and isolated browser ports', () => {
    for (const workflow of [fast, full]) {
      expect(workflow.permissions).toEqual({ contents: 'read' })
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps.filter(
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
      const steps = full.jobs[name]!.steps
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
})

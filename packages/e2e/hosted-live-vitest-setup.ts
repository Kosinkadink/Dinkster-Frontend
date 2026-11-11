import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import waitForNativeComposition from './hosted-global-setup.js'

export default async function runLiveVitest(): Promise<void> {
  const native = process.env['DINKSTER_NATIVE_BACKEND']
  if (!native)
    throw new Error(
      'The hosted native backend must be configured for live Vitest',
    )
  await waitForNativeComposition()

  const root = resolve(import.meta.dirname, '../..')
  const reports = resolve(root, '.ci/live-vitest')
  await mkdir(reports, { recursive: true })
  const withdrawn = JSON.parse(
    await readFile(
      resolve(import.meta.dirname, 'tests/withdrawn-drafts.json'),
      'utf8',
    ),
  ) as { nodes: string[]; templates: Record<string, string[]> }
  const nodeResponse = await fetch(`${native}/api/nodes?wire=45`)
  assert(nodeResponse.ok, 'Live node catalog must be available')
  const { nodes } = (await nodeResponse.json()) as {
    nodes: Record<string, unknown>
  }
  const templateResponse = await fetch(`${native}/api/templates`)
  assert(templateResponse.ok, 'Live template catalog must be available')
  const { templates } = (await templateResponse.json()) as {
    templates: { pack: string; id: string }[]
  }
  const allowedWithdrawals = new Set<string>()
  for (const id of Object.keys(withdrawn.templates)) {
    if (
      !templates.some(
        (template) =>
          template.pack === 'dinkster-nodes-foundation' && template.id === id,
      )
    ) {
      allowedWithdrawals.add(
        `live production loop templates ${id} loads, round-trips, compiles, executes, and replays`,
      )
    }
  }
  const examples = resolve(root, 'docs/examples/loops-and-subgraphs')
  const expected = JSON.parse(
    await readFile(resolve(examples, 'expected-results.json'), 'utf8'),
  ) as Record<string, unknown>
  for (const file of Object.keys(expected)) {
    const document = JSON.parse(
      await readFile(resolve(examples, file), 'utf8'),
    ) as {
      graphs: Record<string, { nodes: Record<string, { type: string }> }>
    }
    const missing = Object.values(document.graphs)
      .flatMap((graph) => Object.values(graph.nodes).map((node) => node.type))
      .filter((type) => !type.startsWith('#') && !Object.hasOwn(nodes, type))
    assert(
      missing.every((type) => withdrawn.nodes.includes(type)),
      `Unexpected missing nodes in ${file}: ${missing.join(', ')}`,
    )
    if (missing.length > 0) {
      allowedWithdrawals.add(
        `live loop and subgraph executable examples ${file} reaches its expected terminal result`,
      )
    }
  }
  const suites = [
    {
      name: 'native-client',
      package: '@dinkster/client',
      files: [
        'test/collab-live.integration.test.ts',
        'test/loop-templates.live.test.ts',
        'test/executable-examples.test.ts',
      ],
      count: 16,
    },
    {
      name: 'native-app',
      package: '@dinkster/app',
      files: ['test/regions-live.integration.test.ts'],
      count: 6,
    },
  ]
  for (const suite of suites) {
    const reportPath = resolve(reports, `${suite.name}.json`)
    const args = [
      '--filter',
      suite.package,
      'exec',
      'vitest',
      'run',
      ...suite.files,
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--testNamePattern=^live ',
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ]
    const child = spawn('pnpm', args, {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        DINKSTER_LIVE_URL: native,
        DINKSTER_COLLAB_LIVE_URL: native,
      },
    })
    await new Promise<void>((accept, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (code === 0) accept()
        else
          reject(
            new Error(`Live Vitest ${suite.name} failed (${signal ?? code})`),
          )
      })
    })
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      testResults: {
        assertionResults: { fullName: string; status: string }[]
      }[]
    }
    const live = report.testResults.flatMap((file) =>
      file.assertionResults.filter((test) => test.fullName.startsWith('live ')),
    )
    assert.equal(
      live.length,
      suite.count,
      `${suite.name}: live case count changed`,
    )
    assert(
      live.every(
        (test) =>
          test.status === 'passed' ||
          (test.status === 'skipped' && allowedWithdrawals.has(test.fullName)),
      ),
      `${suite.name}: every current live case must pass; only listed withdrawn cases may skip`,
    )
  }
}

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
  const suites = [
    {
      name: 'native-client',
      package: '@dinkster/client',
      files: [
        'test/collab-live.integration.test.ts',
        'test/loop-templates.live.test.ts',
        'test/executable-examples.test.ts',
      ],
      count: 11,
    },
    {
      name: 'native-app',
      package: '@dinkster/app',
      files: ['test/regions-live.integration.test.ts'],
      count: 2,
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
      live.every((test) => test.status === 'passed'),
      `${suite.name}: every live case must pass`,
    )
  }
}

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter'

export default class CustomWidgetServerReporter implements Reporter {
  private output = ''

  private record(stream: string, chunk: string | Buffer, test: void | TestCase): void {
    if (test) return
    this.output = `${this.output}${new Date().toISOString()} ${stream} ${chunk.toString()}`.slice(-256 * 1024)
  }

  onStdOut(chunk: string | Buffer, test: void | TestCase): void {
    this.record('stdout', chunk, test)
  }

  onStdErr(chunk: string | Buffer, test: void | TestCase): void {
    this.record('stderr', chunk, test)
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!test.location.file.endsWith('/pack-custom-widget.spec.ts') || result.status === test.expectedStatus) return
    const directory = join(test.parent.project()!.outputDir, 'custom-widget-server')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, `${test.id.replace(/[^a-zA-Z0-9-]/g, '_')}-${result.retry}.log`)
    writeFileSync(path, `Test started: ${result.startTime.toISOString()}\n${this.output}`)
    result.attachments.push({ name: 'custom-widget-server-output', path, contentType: 'text/plain' })
  }
}

import { join } from 'node:path'
import { test } from '@playwright/test'

/**
 * Inspected browser captures taken during a run. Captures land under the
 * Playwright output directory, which is git-ignored, so a full run never
 * modifies the checkout. The group names mirror the per-issue folders in
 * https://github.com/Kosinkadink/dinkster-evidence/tree/main/frontend, where
 * the inspected copies of these captures are retained.
 */
export function evidenceGroupDir(group: string): string {
  return join(test.info().project.outputDir, 'evidence', group)
}

export function evidencePath(group: string, file: string): string {
  return join(evidenceGroupDir(group), file)
}

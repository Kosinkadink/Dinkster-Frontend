/**
 * When a run's problem on a node stops being drawn in color: the one place
 * that decides it (comfy-vibe-station#1261).
 *
 * A node's problems from a run keep their color while the node would run the
 * same way again: its upstream recipe in the run's prompt equals a compile of
 * the current document (recipeStandingFor, the test that keeps an older run's
 * previews). A field the next queue draws anew, such as a seed set to
 * randomize, is not a change. When the test cannot tell (no current compile,
 * a compile with an Error, other schemas) the node keeps its previous answer; a node starts as unchanged. Undo back to
 * the document that ran compiles to the same recipe and brings the color back.
 */

import type { CompileArtifact, CompileResult, ControllerInputProvenance } from '@dinkster/core'
import { recipeStandingFor, type RecipeStanding } from './companion-display.js'

/**
 * Prompt inputs the next queue draws anew, per runtime id: the controlled
 * fields of the queue's advancement plan, named as the prompt names them.
 */
export function drawnAnewInputs(
  live: CompileArtifact,
  steps: readonly { readonly controllers: readonly ControllerInputProvenance[] }[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const drawn = new Map<string, Set<string>>()
  for (const step of steps) {
    for (const controller of step.controllers) {
      const sources = live.provenance.inputSources?.[controller.runtimeId] ?? {}
      for (const [input, port] of Object.entries(sources)) {
        if (port.port !== controller.terminal.valueKey) continue
        let names = drawn.get(controller.runtimeId)
        if (names === undefined) drawn.set(controller.runtimeId, (names = new Set()))
        names.add(input)
      }
    }
  }
  return drawn
}

/**
 * How the failed runtime nodes behind one view node compare with the run.
 * A subgraph node follows the failed nodes inside it, at any depth: same
 * while any of them is the same, otherwise unknown while any cannot be
 * compared, and changed only when every one of them has changed.
 */
export function runStandingFor(args: {
  readonly live: CompileResult | undefined
  readonly ran: CompileArtifact | undefined
  readonly drawnAnew: ReadonlyMap<string, ReadonlySet<string>>
}): (runtimeIds: readonly string[]) => RecipeStanding {
  const standing = args.live?.ok === true
    ? recipeStandingFor(args.live.artifact, args.ran, (runtimeId, input) => args.drawnAnew.get(runtimeId)?.has(input) === true)
    : undefined
  return (runtimeIds) => {
    if (standing === undefined || runtimeIds.length === 0) return 'unknown'
    let result: RecipeStanding = 'changed'
    for (const id of runtimeIds) {
      const one = standing(id)
      if (one === 'same') return 'same'
      if (one === 'unknown') result = 'unknown'
    }
    return result
  }
}

/** Each node's last known answer for one run, so an unknown answer keeps it. */
export class RunStandingMemory {
  private run: string | undefined
  private readonly changed = new Map<string, boolean>()

  /** True when the node's problems from `run` have lost their color. */
  changedSince(run: string, node: string, standing: RecipeStanding): boolean {
    if (run !== this.run) {
      this.run = run
      this.changed.clear()
    }
    if (standing !== 'unknown') this.changed.set(node, standing === 'changed')
    return this.changed.get(node) === true
  }
}

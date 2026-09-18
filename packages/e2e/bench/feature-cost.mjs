/**
 * Feature-cost benchmark: what does each first-class construct add to Dinkster's
 * load + frame time on the same base topology?
 *
 * Runs Dinkster ONLY (the cross-renderer comparison lives in compare.mjs /
 * compare-features.mjs). Each scenario layers one feature flag onto the same
 * synthetic chains via syntheticWorkflow, so deltas against 'baseline'
 * isolate that feature's render cost:
 *
 *   baseline      plain chains (same workload compare.mjs uses)
 *   reroutes      every link split through a midpoint junction (2x segments)
 *   valueSources  1 source per chain fanning out to width+height (+2 links)
 *   nets          final segment per chain rides a named net
 *   groups        1 group rectangle per chain
 *   all           everything at once (except subgraphs, which replace topology)
 *   subgraphs     chains become instances of ONE shared definition, each
 *                 feeding a PreviewImage: 2*chains root-visible nodes, same
 *                 chains*chainLength expanded execution occurrences. Load
 *                 covers boundary derivation + instance rendering; the
 *                 compile/flatten cost lives in core's perf.test.ts. Not an
 *                 apples-to-apples frame comparison with baseline (fewer
 *                 root nodes by construction) - report it as its own row.
 *
 * Methodology comes from harness.mjs (same camera trajectory, vsync
 * uncapped, 30 warmup + 120 measured frames, medians of N reps with a fresh
 * page load each). Run manually (needs the Dinkster dev server):
 *
 *   node packages/e2e/bench/feature-cost.mjs
 *   BENCH_CHAINS=3 BENCH_CHAIN_LENGTH=5 node ...   # quick smoke
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OUT_DIR,
  benchConfig,
  benchDinkster,
  launchBenchBrowser,
  medianOfReps,
  scenarioFilter,
  stats,
} from './harness.mjs'

const CFG = benchConfig()
const NODES = CFG.chains * CFG.chainLength

const SCENARIOS = [
  { name: 'baseline', flags: {} },
  { name: 'reroutes', flags: { reroutes: true } },
  { name: 'valueSources', flags: { valueSources: true } },
  { name: 'nets', flags: { nets: true } },
  { name: 'groups', flags: { groups: true } },
  { name: 'selectors', flags: { selectors: true } },
  { name: 'all', flags: { reroutes: true, valueSources: true, nets: true, groups: true, selectors: true } },
  { name: 'subgraphs', flags: { subgraphs: true }, rootNodes: 2 * CFG.chains, rootLinks: CFG.chains },
].filter(scenarioFilter())

async function benchScenario(page, scenario, rep) {
  const r = await benchDinkster(page, {
    url: CFG.dinksterUrl,
    chains: CFG.chains,
    chainLength: CFG.chainLength,
    flags: scenario.flags,
    warmup: CFG.warmup,
    frames: CFG.frames,
    screenshotPath: rep === 0 ? join(OUT_DIR, `feature-${scenario.name}.png`) : undefined,
  })

  // Assert the scene actually contains the feature under test.
  const wantNodes = scenario.rootNodes ?? NODES
  if (r.counts.nodes !== wantNodes)
    throw new Error(`${scenario.name} node count mismatch (want ${wantNodes}): ${JSON.stringify(r.counts)}`)
  if (scenario.rootLinks !== undefined && r.counts.links !== scenario.rootLinks)
    throw new Error(`${scenario.name} link count mismatch (want ${scenario.rootLinks}): ${JSON.stringify(r.counts)}`)
  for (const [flag, key] of [
    ['reroutes', 'reroutes'],
    ['valueSources', 'valueSources'],
    ['selectors', 'selectors'],
    ['groups', 'groups'],
  ]) {
    if (scenario.flags[flag] && r.counts[key] === 0)
      throw new Error(`${scenario.name}: expected ${key} in scene, got 0`)
  }
  return r
}

const fmt = (x) => x.toFixed(2)

async function main() {
  const browser = await launchBenchBrowser()

  const results = {}
  for (const scenario of SCENARIOS) {
    const reps = []
    let counts
    for (let rep = 0; rep < CFG.reps; rep++) {
      const page = await browser.newPage({ viewport: CFG.viewport })
      try {
        const r = await benchScenario(page, scenario, rep)
        counts = r.counts
        const s = stats(r.frames)
        reps.push({ loadMs: r.loadMs, ...s })
        console.log(
          `${scenario.name} rep ${rep + 1}/${CFG.reps}: load ${r.loadMs.toFixed(0)}ms | ` +
            `avg ${fmt(s.avg)} p50 ${fmt(s.p50)} p95 ${fmt(s.p95)} p99 ${fmt(s.p99)} max ${s.max.toFixed(1)}ms | ` +
            `>33ms: ${s.over33ms}/${CFG.frames}`,
        )
      } finally {
        await page.close()
      }
    }
    results[scenario.name] = { counts, reps, median: medianOfReps(reps) }
  }
  await browser.close()

  const base = results.baseline?.median
  console.log(`\n=== Dinkster feature cost, ${NODES} nodes base, medians of ${CFG.reps} reps (vsync uncapped) ===`)
  console.log('| scenario | load (ms) | avg | p50 | p95 | max | >33ms | avg delta vs baseline |')
  console.log('|----------|-----------|-----|-----|-----|-----|-------|-----------------------|')
  for (const scenario of SCENARIOS) {
    const m = results[scenario.name].median
    const delta =
      scenario.name === 'baseline' || base === undefined
        ? '-'
        : scenario.rootNodes !== undefined
          ? `n/a (${scenario.rootNodes} root nodes)`
          : `${m.avg >= base.avg ? '+' : ''}${fmt(m.avg - base.avg)}ms`
    console.log(
      `| ${scenario.name} | ${m.loadMs.toFixed(0)} | ${fmt(m.avg)} | ${fmt(m.p50)} | ${fmt(m.p95)} | ` +
        `${m.max.toFixed(1)} | ${m.over33ms}/${CFG.frames} | ${delta} |`,
    )
  }

  const out = join(OUT_DIR, `feature-cost-${NODES}nodes-${Date.now()}.json`)
  writeFileSync(
    out,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        workload: { chains: CFG.chains, chainLength: CFG.chainLength, nodes: NODES },
        method: {
          warmupFrames: CFG.warmup,
          measuredFrames: CFG.frames,
          reps: CFG.reps,
          viewport: CFG.viewport,
          vsync: 'uncapped',
        },
        results,
      },
      null,
      2,
    ),
  )
  console.log(`\nwritten: ${out}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

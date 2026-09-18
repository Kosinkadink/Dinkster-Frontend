/**
 * Cross-renderer FEATURE comparison: constructs that Dinkster makes first-class
 * versus their ComfyUI-frontend equivalents, on the same chain topology and
 * world-space geometry as compare.mjs / feature-cost.mjs:
 *
 *   scenario    Dinkster                      ComfyUI (litegraph + Nodes 2.0)
 *   baseline    plain chains               plain chains
 *   reroutes    reroute junction per link  legacy `Reroute` NODE per link
 *   primitives  value source per chain     `PrimitiveNode` per chain
 *               (fan-out width+height)     (fan-out width+height)
 *   groups      group per chain            group per chain
 *   subgraphs   chains instances of one    chains instances of one shared
 *               shared #g1 definition,     native definition (workflow
 *               each -> PreviewImage       `definitions.subgraphs`, instance
 *                                          nodes typed by definition UUID),
 *                                          each -> PreviewImage
 *
 * The subgraphs scenario renders 2*chains root nodes (instances collapse
 * their body), so compare it against the other targets' subgraphs row, NOT
 * against baseline: the expanded execution graph is chains*chainLength but
 * the root view is intentionally small. Both sides share ONE definition,
 * with the chain body (chainLength-1 nodes) inside it.
 *
 * Named nets have no core ComfyUI equivalent (Get/Set are custom nodes), so
 * they are not compared here; their Dinkster-only cost is in feature-cost.mjs.
 *
 * The ComfyUI side loads full workflow-format JSON via app.loadGraphData
 * (API format cannot express reroutes/primitives/groups - they are
 * frontend-only constructs there, which is rather the point). Same
 * methodology as compare.mjs: identical camera trajectory, vsync uncapped,
 * 30 warmup + 120 measured frames, medians of N reps, fresh page per rep.
 * Not part of the CI gate; needs both servers:
 *
 *   node packages/e2e/bench/compare-features.mjs
 *   BENCH_CHAINS=3 BENCH_CHAIN_LENGTH=5 node ...   # quick smoke
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OUT_DIR,
  benchConfig,
  benchDinkster,
  comfyVersions,
  ensureVueNodesSetting,
  launchBenchBrowser,
  measureComfy,
  medianOfReps,
  restoreComfyDefaults,
  scenarioFilter,
  stats,
} from './harness.mjs'

const CFG = benchConfig()
const NODES = CFG.chains * CFG.chainLength
const BASE_LINKS = NODES - CFG.chains

/** Same world-space grid as packages/core/src/format/synthetic.ts. */
const GRID = { x0: 80, y0: 80, colX: 320, rowY: 260 }

/**
 * ComfyUI workflow-format (litegraph) generator mirroring the Dinkster
 * synthetic topology and geometry, with per-feature equivalents. Shapes
 * follow what the stock frontend serializes (and what our importer's
 * fixtures use): Reroute nodes carry a single wildcard input and typed
 * output; primitives connect to consumer inputs converted from widgets
 * (`widget: {name}` on both ends of the link - the exact array-unbound
 * machinery Dinkster's value sources replace).
 */
function comfyWorkflow({ reroutes = false, primitives = false, groups = false, subgraphs = false } = {}) {
  if (subgraphs) return comfySubgraphWorkflow()
  const nodes = []
  const links = [] // [id, origin_id, origin_slot, target_id, target_slot, type]
  const groupList = []
  let nextNode = 1
  let nextLink = 1

  for (let c = 0; c < CFG.chains; c++) {
    let prev // { id, node }
    let first
    for (let i = 0; i < CFG.chainLength; i++) {
      const id = nextNode++
      const pos = [GRID.x0 + i * GRID.colX, GRID.y0 + c * GRID.rowY]
      let node
      if (i === 0) {
        node = {
          id,
          type: 'EmptyImage',
          pos,
          size: [270, 130],
          flags: {},
          order: 0,
          mode: 0,
          inputs: [],
          outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [] }],
          properties: {},
          widgets_values: [64, 64, 1, (c * 7919) % 0xffffff],
        }
        first = node
      } else if (i === CFG.chainLength - 1) {
        node = {
          id,
          type: 'PreviewImage',
          pos,
          size: [210, 30],
          flags: {},
          order: 0,
          mode: 0,
          inputs: [{ name: 'images', type: 'IMAGE', link: null }],
          outputs: [],
          properties: {},
          widgets_values: [],
        }
      } else {
        node = {
          id,
          type: 'ImageScaleBy',
          pos,
          size: [270, 102],
          flags: {},
          order: 0,
          mode: 0,
          inputs: [{ name: 'image', type: 'IMAGE', link: null }],
          outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [] }],
          properties: {},
          widgets_values: ['nearest-exact', 1.0],
        }
      }
      nodes.push(node)

      if (prev) {
        if (reroutes) {
          const rerouteId = nextNode++
          const reroute = {
            id: rerouteId,
            type: 'Reroute',
            pos: [GRID.x0 + (i - 0.5) * GRID.colX, GRID.y0 + c * GRID.rowY + 40],
            size: [75, 26],
            flags: {},
            order: 0,
            mode: 0,
            inputs: [{ name: '', type: '*', link: null }],
            outputs: [{ name: '', type: 'IMAGE', links: [], slot_index: 0 }],
            properties: { showOutputText: false, horizontal: false },
          }
          nodes.push(reroute)
          const feedId = nextLink++
          links.push([feedId, prev.id, 0, rerouteId, 0, 'IMAGE'])
          prev.node.outputs[0].links.push(feedId)
          reroute.inputs[0].link = feedId
          const outId = nextLink++
          links.push([outId, rerouteId, 0, id, 0, 'IMAGE'])
          reroute.outputs[0].links.push(outId)
          node.inputs[0].link = outId
        } else {
          const linkId = nextLink++
          links.push([linkId, prev.id, 0, id, 0, 'IMAGE'])
          prev.node.outputs[0].links.push(linkId)
          node.inputs[0].link = linkId
        }
      }
      prev = { id, node }
    }

    if (primitives && first) {
      const primId = nextNode++
      const prim = {
        id: primId,
        type: 'PrimitiveNode',
        pos: [-180, GRID.y0 + c * GRID.rowY + 20],
        size: [210, 82],
        flags: {},
        order: 0,
        mode: 0,
        inputs: [],
        outputs: [{ name: 'INT', type: 'INT', links: [], widget: { name: 'value' }, slot_index: 0 }],
        properties: { 'Run widget replace on values': false },
        widgets_values: [64 + (c % 8) * 16, 'fixed'],
      }
      nodes.push(prim)
      for (const name of ['width', 'height']) {
        const linkId = nextLink++
        links.push([linkId, primId, 0, first.id, first.inputs.length, 'INT'])
        prim.outputs[0].links.push(linkId)
        first.inputs.push({ name, type: 'INT', link: linkId, widget: { name } })
      }
    }

    if (groups) {
      groupList.push({
        title: `Chain ${c}`,
        bounding: [40, GRID.y0 + c * GRID.rowY - 50, (CFG.chainLength - 1) * GRID.colX + 320, GRID.rowY - 40],
        color: '#3f789e',
        font_size: 24,
        flags: {},
      })
    }
  }

  return {
    workflow: {
      last_node_id: nextNode - 1,
      last_link_id: nextLink - 1,
      nodes,
      links,
      groups: groupList,
      config: {},
      extra: {},
      version: 0.4,
    },
    counts: { nodes: nodes.length, links: links.length },
  }
}

/**
 * Native ComfyUI subgraphs, mirroring the stock frontend's serialization
 * (browser_tests/assets/subgraphs/basic-subgraph.json in ComfyUI_frontend):
 * one shared definition under workflow `definitions.subgraphs` (a v1
 * sub-workflow with inputNode/outputNode at ids -10/-20, object-form links,
 * boundary output slot as UUID), instantiated by root nodes whose `type` is
 * the definition UUID. Same world-space geometry as the Dinkster side: the
 * definition holds the chain body (chainLength-1 nodes), the root holds
 * chains x (instance -> PreviewImage).
 */
function comfySubgraphWorkflow() {
  const DEF_ID = '5d9d34a7-8c3a-4dcb-9a08-2c9193b7fc11'
  const OUT_SLOT_ID = 'e2a3c1de-9f14-45f2-8b76-40b3a2d6e0aa'

  const bodyCount = CFG.chainLength - 1
  const defNodes = []
  const defLinks = [] // object form: { id, origin_id, origin_slot, target_id, target_slot, type }
  let prev
  for (let i = 0; i < bodyCount; i++) {
    const id = i + 1
    const pos = [GRID.x0 + i * GRID.colX, 100]
    const node =
      i === 0
        ? {
            id,
            type: 'EmptyImage',
            pos,
            size: [270, 130],
            flags: {},
            order: i,
            mode: 0,
            inputs: [],
            outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [] }],
            properties: {},
            widgets_values: [64, 64, 1, 0],
          }
        : {
            id,
            type: 'ImageScaleBy',
            pos,
            size: [270, 102],
            flags: {},
            order: i,
            mode: 0,
            inputs: [{ name: 'image', type: 'IMAGE', link: null }],
            outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [] }],
            properties: {},
            widgets_values: ['nearest-exact', 1.0],
          }
    defNodes.push(node)
    if (prev) {
      const linkId = defLinks.length + 1
      defLinks.push({ id: linkId, origin_id: prev.id, origin_slot: 0, target_id: id, target_slot: 0, type: 'IMAGE' })
      prev.outputs[0].links.push(linkId)
      node.inputs[0].link = linkId
    }
    prev = node
  }
  const boundaryLinkId = defLinks.length + 1
  defLinks.push({ id: boundaryLinkId, origin_id: prev.id, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' })
  prev.outputs[0].links.push(boundaryLinkId)

  const definition = {
    id: DEF_ID,
    version: 1,
    state: { lastGroupId: 0, lastNodeId: bodyCount, lastLinkId: boundaryLinkId, lastRerouteId: 0 },
    revision: 0,
    config: {},
    name: 'Chain body',
    inputNode: { id: -10, bounding: [GRID.x0 - 220, 80, 120, 60] },
    outputNode: { id: -20, bounding: [GRID.x0 + bodyCount * GRID.colX, 80, 120, 60] },
    inputs: [],
    outputs: [{ id: OUT_SLOT_ID, name: 'IMAGE', type: 'IMAGE', linkIds: [boundaryLinkId] }],
    widgets: [],
    nodes: defNodes,
    groups: [],
    links: defLinks,
    extra: {},
  }

  const nodes = []
  const links = [] // root stays array form: [id, origin_id, origin_slot, target_id, target_slot, type]
  let nextNode = 1
  let nextLink = 1
  for (let c = 0; c < CFG.chains; c++) {
    const instId = nextNode++
    const previewId = nextNode++
    const linkId = nextLink++
    nodes.push({
      id: instId,
      type: DEF_ID,
      pos: [GRID.x0, GRID.y0 + c * GRID.rowY],
      size: [210, 60],
      flags: {},
      order: 0,
      mode: 0,
      inputs: [],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [linkId] }],
      properties: {},
      widgets_values: [],
    })
    nodes.push({
      id: previewId,
      type: 'PreviewImage',
      pos: [GRID.x0 + GRID.colX, GRID.y0 + c * GRID.rowY],
      size: [210, 30],
      flags: {},
      order: 0,
      mode: 0,
      inputs: [{ name: 'images', type: 'IMAGE', link: linkId }],
      outputs: [],
      properties: {},
      widgets_values: [],
    })
    links.push([linkId, instId, 0, previewId, 0, 'IMAGE'])
  }

  return {
    workflow: {
      last_node_id: nextNode - 1,
      last_link_id: nextLink - 1,
      nodes,
      links,
      groups: [],
      config: {},
      extra: {},
      version: 0.4,
      definitions: { subgraphs: [definition] },
    },
    counts: { nodes: nodes.length, links: links.length },
  }
}

const SCENARIOS = [
  { name: 'baseline', dinksterFlags: {}, comfyFlags: {} },
  { name: 'reroutes', dinksterFlags: { reroutes: true }, comfyFlags: { reroutes: true } },
  { name: 'primitives', dinksterFlags: { valueSources: true }, comfyFlags: { primitives: true } },
  { name: 'groups', dinksterFlags: { groups: true }, comfyFlags: { groups: true } },
  {
    name: 'subgraphs',
    dinksterFlags: { subgraphs: true },
    comfyFlags: { subgraphs: true },
    rootNodes: 2 * CFG.chains,
    rootLinks: CFG.chains,
  },
].filter(scenarioFilter())

async function benchComfyFeature(page, scenario, vueNodes, rep) {
  await ensureVueNodesSetting(page, CFG.comfyUrl, vueNodes)
  await page.waitForTimeout(2_000) // extension init / first layout settle

  const { workflow, counts: expected } = comfyWorkflow(scenario.comfyFlags)
  const load = await page.evaluate(async (workflow) => {
    const app = window.app
    const t0 = performance.now()
    await app.loadGraphData(workflow)
    const loadMs = performance.now() - t0
    return { loadMs, nodes: app.rootGraph.nodes.length, links: app.rootGraph._links.size }
  }, workflow)
  if (load.nodes !== expected.nodes)
    throw new Error(`comfy node count mismatch: got ${load.nodes}, want ${expected.nodes}`)
  if (load.links !== expected.links)
    throw new Error(`comfy link count mismatch: got ${load.links}, want ${expected.links}`)

  const mode = vueNodes ? 'comfy-vuenodes' : 'comfy-litegraph'
  const frames = await measureComfy(page, {
    vueNodes,
    warmup: CFG.warmup,
    frames: CFG.frames,
    screenshotPath: rep === 0 ? join(OUT_DIR, `cfeat-${mode}-${scenario.name}.png`) : undefined,
  })
  return { loadMs: load.loadMs, frames }
}

async function benchDinksterFeature(page, scenario, rep) {
  const r = await benchDinkster(page, {
    url: CFG.dinksterUrl,
    chains: CFG.chains,
    chainLength: CFG.chainLength,
    flags: scenario.dinksterFlags,
    warmup: CFG.warmup,
    frames: CFG.frames,
    screenshotPath: rep === 0 ? join(OUT_DIR, `cfeat-dinkster-${scenario.name}.png`) : undefined,
  })
  const wantNodes = scenario.rootNodes ?? NODES
  if (r.counts.nodes !== wantNodes)
    throw new Error(`dinkster node count mismatch (want ${wantNodes}): ${JSON.stringify(r.counts)}`)
  if (scenario.rootLinks !== undefined && r.counts.links !== scenario.rootLinks)
    throw new Error(`dinkster link count mismatch (want ${scenario.rootLinks}): ${JSON.stringify(r.counts)}`)
  for (const [flag, key] of [
    ['reroutes', 'reroutes'],
    ['valueSources', 'valueSources'],
    ['groups', 'groups'],
  ]) {
    if (scenario.dinksterFlags[flag] && r.counts[key] === 0)
      throw new Error(`dinkster ${scenario.name}: expected ${key} in scene, got 0`)
  }
  return r
}

async function main() {
  const browser = await launchBenchBrowser()
  const versions = { browser: browser.version(), ...(await comfyVersions(CFG.comfyUrl)) }

  const targets = [
    { name: 'dinkster', run: (page, scenario, rep) => benchDinksterFeature(page, scenario, rep) },
    { name: 'comfy-litegraph', run: (page, scenario, rep) => benchComfyFeature(page, scenario, false, rep) },
    { name: 'comfy-vuenodes', run: (page, scenario, rep) => benchComfyFeature(page, scenario, true, rep) },
  ]

  const results = {}
  for (const target of targets) {
    results[target.name] = {}
    for (const scenario of SCENARIOS) {
      const reps = []
      for (let rep = 0; rep < CFG.reps; rep++) {
        const page = await browser.newPage({ viewport: CFG.viewport })
        page.on('pageerror', (e) =>
          console.error(`[${target.name}/${scenario.name}] pageerror: ${e.message.slice(0, 300)}`),
        )
        try {
          const { loadMs, frames } = await target.run(page, scenario, rep)
          const s = stats(frames)
          reps.push({ loadMs, ...s })
          console.log(
            `${target.name}/${scenario.name} rep ${rep + 1}/${CFG.reps}: load ${loadMs.toFixed(0)}ms | ` +
              `avg ${s.avg.toFixed(2)} p50 ${s.p50.toFixed(2)} p95 ${s.p95.toFixed(2)} ` +
              `max ${s.max.toFixed(1)}ms | >33ms: ${s.over33ms}/${CFG.frames}`,
          )
        } finally {
          await page.close()
        }
      }
      results[target.name][scenario.name] = { reps, median: medianOfReps(reps) }
    }
  }

  await restoreComfyDefaults(browser, CFG.comfyUrl, CFG.viewport)
  await browser.close()

  const report = {
    date: new Date().toISOString(),
    workload: { chains: CFG.chains, chainLength: CFG.chainLength, nodes: NODES, baseLinks: BASE_LINKS },
    method: {
      warmupFrames: CFG.warmup,
      measuredFrames: CFG.frames,
      reps: CFG.reps,
      viewport: CFG.viewport,
      vsync: 'uncapped',
    },
    versions,
    results,
  }
  const outFile = join(OUT_DIR, `compare-features-${NODES}nodes-${Date.now()}.json`)
  writeFileSync(outFile, JSON.stringify(report, null, 2))

  console.log(`\n=== Feature comparison, ${NODES} base nodes, medians of ${CFG.reps} reps (vsync uncapped) ===`)
  console.log('| scenario | target | load (ms) | avg | p50 | p95 | max | >33ms |')
  console.log('|----------|--------|-----------|-----|-----|-----|-----|-------|')
  for (const scenario of SCENARIOS) {
    for (const target of targets) {
      const m = results[target.name][scenario.name].median
      console.log(
        `| ${scenario.name} | ${target.name} | ${m.loadMs.toFixed(0)} | ${m.avg.toFixed(2)} | ` +
          `${m.p50.toFixed(2)} | ${m.p95.toFixed(2)} | ${m.max.toFixed(1)} | ${m.over33ms}/${CFG.frames} |`,
      )
    }
  }
  console.log(`\nwritten: ${outFile}`)
}

await main()

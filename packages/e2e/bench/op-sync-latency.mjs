/**
 * Manual multiplayer op-sync latency probe. This is not part of any test
 * script and never runs in CI. It creates and deletes its own collab session.
 *
 * Prerequisites: the frontend dev server is already running on :5199 and the
 * shared Dinkster backend is already running on :8765. This tool does not start,
 * stop, or restart either service.
 *
 *   pnpm --filter @dinkster/e2e exec node bench/op-sync-latency.mjs
 *
 * DINKSTER_FRONTEND_SOURCE_ROOT may point at the source tree served by Vite when
 * the tool itself is run from a separate worktree.
 */
import { chromium } from '@playwright/test'
import { resolve } from 'node:path'

const appUrl = process.env.DINKSTER_APP_URL ?? 'http://127.0.0.1:5199'
const backendUrl = process.env.DINKSTER_COLLAB_LIVE_URL ?? 'http://127.0.0.1:8765'
const sourceRoot = resolve(process.env.DINKSTER_FRONTEND_SOURCE_ROOT ?? '../..')
const moduleRoot = `/@fs${sourceRoot}`
const samples = Number(process.env.DINKSTER_OP_SYNC_SAMPLES ?? 40)

const snapshot = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: `op-sync-latency-${Date.now()}`,
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'latency probe',
      nodes: {
        n1: { id: 'n1', type: 'ProbeNode', values: { text: '' } },
      },
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 100,
    },
  },
  view: { graphs: { g0: { nodes: { n1: { position: { x: 40, y: 40 } } } } } },
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (sorted.length - 1) * p
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

const summarize = (rows, key) => {
  const values = rows.map((row) => row[key]).filter(Number.isFinite)
  return {
    p50: Number(percentile(values, 0.5).toFixed(2)),
    p95: Number(percentile(values, 0.95).toFixed(2)),
  }
}

const browser = await chromium.launch({ headless: true })
const senderContext = await browser.newContext()
const receiverContext = await browser.newContext()
const sender = await senderContext.newPage()
const receiver = await receiverContext.newPage()
let sessionId

try {
  await Promise.all([sender.goto(appUrl), receiver.goto(appUrl)])

  sessionId = await sender.evaluate(async ({ backendUrl, moduleRoot, snapshot }) => {
    const client = await import(`${moduleRoot}/packages/client/src/index.ts`)
    const created = await client.createCollabSession(backendUrl, {
      scope: 'shared',
      documentId: snapshot.lineage,
      snapshot,
    })
    return created.sessionId
  }, { backendUrl, moduleRoot, snapshot })

  const setup = async (page, actorId, receiverMode) => page.evaluate(async ({
    actorId, backendUrl, moduleRoot, receiverMode, sessionId,
  }) => {
    const core = await import(`${moduleRoot}/packages/core/src/index.ts`)
    const client = await import(`${moduleRoot}/packages/client/src/index.ts`)
    const canvasModule = receiverMode
      ? await import(`${moduleRoot}/packages/canvas/src/index.ts`)
      : undefined
    const raw = new client.CollabHttpConnection({ baseUrl: backendUrl, sessionId, actorId })
    const now = () => performance.timeOrigin + performance.now()
    const state = {
      raw,
      session: undefined,
      dispatchAt: new Map(),
      postStart: new Map(),
      postResolve: new Map(),
      wireBytes: new Map(),
      patchOps: new Map(),
      frame: new Map(),
      publication: new Map(),
      sceneReady: new Map(),
      renderFrame: new Map(),
      currentOpId: undefined,
      renderer: undefined,
    }
    const connection = {
      sessionId: raw.sessionId,
      postOp: async (op) => {
        state.postStart.set(op.opId, now())
        const outcome = await raw.postOp(op)
        state.postResolve.set(op.opId, now())
        state.wireBytes.set(op.opId, new TextEncoder().encode(JSON.stringify(op)).byteLength)
        state.patchOps.set(op.opId, op.patch.length)
        return outcome
      },
      fetchSnapshot: () => raw.fetchSnapshot(),
      fetchOps: (after) => raw.fetchOps(after),
      putSnapshot: (revision, document) => raw.putSnapshot(revision, document),
      sendPresence: (payload) => raw.sendPresence(payload),
      close: () => raw.close(),
      onEvent: (listener) => raw.onEvent((event) => {
        if (event.kind !== 'op') return listener(event)
        state.frame.set(event.op.opId, now())
        state.currentOpId = event.op.opId
        try {
          listener(event)
        } finally {
          state.currentOpId = undefined
        }
      }),
    }
    const session = await core.connectSharedSession(connection, core.coreCommandRegistry(), { actorId })
    state.session = session

    if (receiverMode) {
      const canvas = document.createElement('canvas')
      canvas.width = 1200
      canvas.height = 800
      canvas.style.width = '1200px'
      canvas.style.height = '800px'
      document.body.replaceChildren(canvas)
      const renderer = new canvasModule.CanvasRenderer(canvas, canvasModule.defaultTokens)
      state.renderer = renderer
      const rebuild = (document, opId) => {
        const scene = canvasModule.buildScene({
          document,
          graphId: 'g0',
          resolve: () => undefined,
          tokens: canvasModule.defaultTokens,
          measure: (text) => text.length * 6,
          widgetMeasure: () => ({ viewId: 'probe', rows: 1 }),
        })
        renderer.setScene(scene)
        if (opId !== undefined) {
          state.sceneReady.set(opId, now())
          requestAnimationFrame(() => state.renderFrame.set(opId, now()))
        }
      }
      rebuild(session.doc)
      session.document.subscribe((document) => {
        const opId = state.currentOpId
        if (opId !== undefined) state.publication.set(opId, now())
        rebuild(document, opId)
      })
    }

    window.__dinksterOpSyncBench = state
  }, { actorId, backendUrl, moduleRoot, receiverMode, sessionId })

  await Promise.all([setup(sender, 'latency-sender', false), setup(receiver, 'latency-receiver', true)])

  const waitLive = async (page) => {
    await page.waitForFunction(() => window.__dinksterOpSyncBench.session.status.get() === 'live')
  }
  await Promise.all([waitLive(sender), waitLive(receiver)])

  const runScenario = async (name, invocationAt, afterEach) => {
    const rows = []
    for (let i = 0; i < samples; i++) {
      // Avoid phase-locking every dispatch to the prior receiver frame.
      await sender.waitForTimeout(Math.random() * 20)
      const opId = await sender.evaluate(({ invocation, index }) => {
        const state = window.__dinksterOpSyncBench
        const before = new Set(state.postStart.keys())
        const dispatched = performance.timeOrigin + performance.now()
        const outcome = state.session.dispatch(invocation)
        if (!outcome.ok) throw new Error(JSON.stringify(outcome.diagnostics))
        return new Promise((resolve, reject) => {
          const deadline = performance.now() + 5000
          const poll = () => {
            const opId = [...state.postStart.keys()].find((id) => !before.has(id))
            if (opId !== undefined) {
              state.dispatchAt.set(opId, dispatched)
              resolve(opId)
            } else if (performance.now() > deadline) reject(new Error(`op ${index} was not posted`))
            else setTimeout(poll, 0)
          }
          poll()
        })
      }, { invocation: invocationAt(i), index: i })

      await receiver.waitForFunction((id) => window.__dinksterOpSyncBench.renderFrame.has(id), opId)
      await sender.waitForFunction((id) => window.__dinksterOpSyncBench.postResolve.has(id), opId)
      const [send, receive] = await Promise.all([
        sender.evaluate((id) => {
          const state = window.__dinksterOpSyncBench
          return {
            dispatch: state.dispatchAt.get(id),
            postStart: state.postStart.get(id),
            postResolve: state.postResolve.get(id),
            wireBytes: state.wireBytes.get(id),
            patchOps: state.patchOps.get(id),
          }
        }, opId),
        receiver.evaluate((id) => {
          const state = window.__dinksterOpSyncBench
          return {
            frame: state.frame.get(id),
            publication: state.publication.get(id),
            sceneReady: state.sceneReady.get(id),
            renderFrame: state.renderFrame.get(id),
          }
        }, opId),
      ])
      rows.push({
        wireBytes: send.wireBytes,
        patchOps: send.patchOps,
        dispatchToPost: send.postStart - send.dispatch,
        postToFrame: receive.frame - send.postStart,
        postRoundTrip: send.postResolve - send.postStart,
        frameToPublication: receive.publication - receive.frame,
        publicationToScene: receive.sceneReady - receive.publication,
        sceneToRenderFrame: receive.renderFrame - receive.sceneReady,
        dispatchToRenderFrame: receive.renderFrame - send.dispatch,
      })
      if (afterEach !== undefined) await afterEach()
    }
    return {
      name,
      samples: rows.length,
      wireBytes: summarize(rows, 'wireBytes'),
      patchOps: summarize(rows, 'patchOps'),
      dispatchToPost: summarize(rows, 'dispatchToPost'),
      postToFrame: summarize(rows, 'postToFrame'),
      postRoundTrip: summarize(rows, 'postRoundTrip'),
      frameToPublication: summarize(rows, 'frameToPublication'),
      publicationToScene: summarize(rows, 'publicationToScene'),
      sceneToRenderFrame: summarize(rows, 'sceneToRenderFrame'),
      dispatchToRenderFrame: summarize(rows, 'dispatchToRenderFrame'),
    }
  }

  const results = []
  results.push(await runScenario('single widget edit', (i) => ({
    command: 'node.setValue',
    params: { graphId: 'g0', nodeId: 'n1', inputId: 'text', value: `edit-${i}` },
  })))
  results.push(await runScenario('node move stream', (i) => ({
    command: 'node.move',
    params: { graphId: 'g0', positions: { n1: { x: 40 + i, y: 40 + (i % 7) } } },
  })))
  results.push(await runScenario('20-node atomic paste (fixed-size baseline)', (i) => ({
    command: 'batch',
    params: {
      invocations: Array.from({ length: 20 }, (_, j) => ({
        command: 'node.add',
        params: {
          graphId: 'g0',
          type: 'ProbeNode',
          position: { x: (j % 5) * 220, y: 180 + (i * 4 + Math.floor(j / 5)) * 100 },
          values: { text: `paste-${i}-${j}` },
        },
      })),
    },
  }), async () => {
    await sender.evaluate(async () => {
      const state = window.__dinksterOpSyncBench
      if (!state.session.undo()) throw new Error('paste cleanup undo failed')
      await state.session.settle()
    })
    await receiver.waitForFunction(() => Object.keys(
      window.__dinksterOpSyncBench.session.doc.graphs.g0.nodes,
    ).length === 1)
  }))
  console.log(JSON.stringify({ appUrl, backendUrl, sourceRoot, results }, null, 2))
} finally {
  if (sessionId !== undefined) {
    await fetch(`${backendUrl}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      .catch(() => undefined)
  }
  await browser.close()
}

#!/usr/bin/env node
/**
 * Record ComfyUI WS event streams as golden fixtures.
 *
 * Usage: node scripts/record-events.mjs [serverUrl]
 * Requires a running ComfyUI with the dinkster_test_nodes pack installed
 * (DinksterRaiseError, DinksterSleep).
 *
 * Writes packages/core/fixtures/events/<scenario>.json:
 *   { scenario, clientId, submit: {status, body}, messages: [{t, type, data} | {t, binaryEventType, size}] }
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = process.argv[2] ?? 'http://127.0.0.1:8199'
const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws?clientId=dinkster-recorder'
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../packages/core/fixtures/events')

const IMG = (id) => ({ class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: 1, color: 0 } })
const PREVIEW = (src) => ({ class_type: 'PreviewImage', inputs: { images: [src, 0] } })

const scenarios = {
  success: {
    prompt: { 1: IMG('1'), 2: PREVIEW('1') },
  },
  // Submitted twice; the second run should emit execution_cached.
  cached: {
    prompt: { 1: IMG('1'), 2: PREVIEW('1') },
    resubmit: true,
  },
  runtime_error: {
    prompt: {
      1: IMG('1'),
      2: { class_type: 'DinksterRaiseError', inputs: { image: ['1', 0], message: 'dinkster fixture error' } },
      3: PREVIEW('2'),
    },
  },
  interrupted: {
    prompt: {
      1: IMG('1'),
      2: { class_type: 'DinksterSleep', inputs: { image: ['1', 0], seconds: 8 } },
      3: PREVIEW('2'),
    },
    interruptAfterMs: 1500,
  },
  validation_error: {
    // steps type is wrong + missing required inputs -> HTTP 400 with node_errors
    prompt: { 1: { class_type: 'KSampler', inputs: { steps: 'not-a-number' } } },
    expectReject: true,
  },
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? e}`))
  })
}

async function submit(prompt) {
  const res = await fetch(`${SERVER}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: 'dinkster-recorder' }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function waitForIdle(messages, promptId, timeoutMs = 60000) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      const done = messages.some(
        (m) =>
          m.data?.prompt_id === promptId &&
          (m.type === 'execution_success' || m.type === 'execution_error' || m.type === 'execution_interrupted'),
      )
      if (done) return setTimeout(resolve, 500) // let trailing status msgs land
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting for terminal event'))
      setTimeout(check, 100)
    }
    check()
  })
}

async function record(name, spec) {
  const ws = await connect()
  const t0 = Date.now()
  const messages = []
  ws.onmessage = (ev) => {
    const t = Date.now() - t0
    if (typeof ev.data === 'string') {
      const parsed = JSON.parse(ev.data)
      messages.push({ t, type: parsed.type, data: parsed.data })
    } else {
      const view = new DataView(ev.data)
      messages.push({ t, binaryEventType: view.getUint32(0), size: ev.data.byteLength })
    }
  }

  const submits = []
  const first = await submit(spec.prompt)
  submits.push(first)
  if (spec.expectReject) {
    await new Promise((r) => setTimeout(r, 800))
  } else {
    const promptId = first.body.prompt_id
    if (spec.interruptAfterMs) {
      await new Promise((r) => setTimeout(r, spec.interruptAfterMs))
      await fetch(`${SERVER}/interrupt`, { method: 'POST' })
    }
    await waitForIdle(messages, promptId)
    if (spec.resubmit) {
      const second = await submit(spec.prompt)
      submits.push(second)
      await waitForIdle(messages, second.body.prompt_id)
    }
  }
  ws.close()

  const fixture = { scenario: name, clientId: 'dinkster-recorder', submits, messages }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(fixture, null, 2))
  console.log(`${name}: ${messages.length} messages, submits: ${submits.map((s) => s.status).join(',')}`)
}

for (const [name, spec] of Object.entries(scenarios)) {
  await record(name, spec)
}
console.log('done')

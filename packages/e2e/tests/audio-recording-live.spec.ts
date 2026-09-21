import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page, type Request } from '@playwright/test'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const PHYSICAL_MICROPHONE = process.env['DINKSTER_PHYSICAL_MICROPHONE']

interface UploadedAsset {
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
}

interface SubmittedJob {
  readonly clientId: string
  readonly jobId: string
  readonly graph: { readonly nodes: Readonly<Record<string, unknown>> }
}

async function inputPoint(page: Page): Promise<{ readonly x: number; readonly y: number }> {
  return page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((entry) => entry.id === 'load')!
    const row = node.layout.rows.find((entry) => entry.kind === 'widget' && entry.inputId === 'audio')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + row.y + row.height / 2 }
  })
}

async function queueEnvelope(page: Page): Promise<SubmittedJob> {
  let submitted: SubmittedJob | undefined
  const listener = (candidate: Request) => {
    if (candidate.method() === 'POST' && new URL(candidate.url()).pathname === '/api/jobs') {
      submitted = candidate.postDataJSON() as SubmittedJob
    }
  }
  page.on('request', listener)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, ['editor'])
  })
  await expect(page.getByTestId('execution-row').first().locator('.execution-status'))
    .toHaveText('Completed', { timeout: 30_000 })
  page.off('request', listener)
  if (!submitted) throw new Error('Load Audio execution was not submitted')
  return submitted
}

test.beforeEach(async ({ page, context }, testInfo) => {
  test.skip(process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_NATIVE_BACKEND to an isolated Dinkster backend')
  if (PHYSICAL_MICROPHONE) {
    const baseURL = testInfo.project.use.baseURL
    if (typeof baseURL !== 'string') throw new Error('physical microphone acceptance requires a string baseURL')
    await context.grantPermissions(['microphone'], { origin: new URL(baseURL).origin })
  }
  let nodes: Record<string, unknown> | undefined
  try {
    const response = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(3_000) })
    if (response.ok) nodes = (await response.json() as { nodes?: Record<string, unknown> }).nodes
  } catch { /* skip below */ }
  test.skip(nodes === undefined, `no native Dinkster backend reachable at ${NATIVE_BACKEND}`)
  test.skip(!('dinkster.load_audio' in nodes! && 'dinkster.audio.envelope' in nodes! && 'dinkster.curve.editor' in nodes!),
    'native backend lacks load audio, audio envelope, or curve editor')
  await page.addInitScript(({ synthetic }) => {
    const captures: Promise<readonly number[]>[] = []
    Object.defineProperty(window, '__dinksterRecordedAudioChunks', { value: captures })
    Object.defineProperty(window, '__dinksterNativeGetUserMediaSource', {
      value: Function.prototype.toString.call(navigator.mediaDevices.getUserMedia),
    })
    Object.defineProperty(window, '__dinksterRecordedAudioTrack', { value: undefined, writable: true })
    const NativeMediaRecorder = window.MediaRecorder
    class CapturingMediaRecorder extends NativeMediaRecorder {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options)
        ;(window as unknown as { __dinksterRecordedAudioTrack: MediaStreamTrack }).__dinksterRecordedAudioTrack = stream.getAudioTracks()[0]!
        this.addEventListener('dataavailable', (event) => {
          captures.push(event.data.arrayBuffer().then((bytes) => [...new Uint8Array(bytes)]))
        })
      }
    }
    Object.defineProperty(window, 'MediaRecorder', { value: CapturingMediaRecorder })
    if (!synthetic) return
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      const context = new AudioContext()
      const tone = context.createOscillator()
      const output = context.createMediaStreamDestination()
      tone.frequency.value = 523.25
      tone.connect(output)
      tone.start()
      await context.resume()
      const track = output.stream.getAudioTracks()[0]!
      const stop = track.stop.bind(track)
      track.stop = () => { tone.stop(); void context.close(); stop() }
      return output.stream
    } })
  }, { synthetic: PHYSICAL_MICROPHONE === undefined })
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 15_000 })
})

test(PHYSICAL_MICROPHONE
  ? 'physical microphone records, uploads, loads and renders as canonical audio'
  : 'browser Opus WebM records, uploads, loads and renders as canonical audio', async ({ page, request }, testInfo) => {
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audio-recording-live', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'Audio recording',
        nodes: {
          load: { id: 'load', type: 'dinkster.load_audio', values: {} },
          envelope: { id: 'envelope', type: 'dinkster.audio.envelope', values: { frames_per_second: 7 } },
          editor: { id: 'editor', type: 'dinkster.curve.editor', values: {} },
        },
        links: {
          audioEnvelope: { id: 'audioEnvelope', from: { node: 'load', port: 'audio' }, to: { node: 'envelope', port: 'audio' } },
          envelopeCurve: { id: 'envelopeCurve', from: { node: 'envelope', port: 'curve' }, to: { node: 'editor', port: 'curve' } },
        },
        nets: {}, reroutes: {}, nextOrdinal: 4,
      } },
      view: { graphs: { g0: { nodes: {
        load: { position: { x: 120, y: 100 }, size: { width: 620, height: 520 } },
        envelope: { position: { x: 820, y: 100 } },
        editor: { position: { x: 1160, y: 100 } },
      } } } },
      ext: { 'dinkster.exposedPreviews': [{ graphId: 'g0', nodeId: 'load' }] },
    } as never, 'Live Audio Recording')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => window.__dinksterTest!.app.activeTab()?.id === 'audio-recording-live')
  await page.waitForFunction(() => window.__dinksterTest!.renderer!.getScene().nodes.some((node) =>
    node.id === 'load' && node.layout.rows.some((row) => row.kind === 'widget' && row.inputId === 'audio')))

  const point = await inputPoint(page)
  await page.mouse.click(point.x, point.y)
  const recorder = page.getByRole('region', { name: 'Record audio', exact: true })
  await expect(recorder).toBeVisible()
  let selectedDevice: Buffer | undefined
  if (PHYSICAL_MICROPHONE) {
    await recorder.getByRole('button', { name: 'Find microphones' }).click()
    const microphone = recorder.getByRole('combobox', { name: 'Microphone' })
    const matchingDevices = () => microphone.locator('option').evaluateAll(
      (options, label) => options.filter((option) => option.textContent === label).length,
      PHYSICAL_MICROPHONE,
    )
    if (await matchingDevices() === 0) {
      await recorder.getByRole('button', { name: 'Record microphone' }).click()
      await expect(recorder).toContainText('Recording microphone')
      await recorder.getByRole('button', { name: 'Discard recording' }).click()
      await expect(recorder).toContainText('Recording cancelled')
      await page.evaluate(() => {
        (window as unknown as { __dinksterRecordedAudioChunks: Promise<readonly number[]>[] }).__dinksterRecordedAudioChunks.length = 0
      })
      await recorder.getByRole('button', { name: 'Find microphones' }).click()
    }
    await expect.poll(matchingDevices).toBe(1)
    await microphone.selectOption({ label: PHYSICAL_MICROPHONE })
    selectedDevice = await page.getByTestId('asset-editor').screenshot({ animations: 'disabled' })
    await testInfo.attach('physical-microphone-selected', { body: selectedDevice, contentType: 'image/png' })
  }
  await recorder.getByRole('button', { name: 'Record microphone' }).click()
  await expect(recorder).toContainText('Recording microphone')
  await expect(recorder.getByTestId('audio-recorded-bytes')).toHaveText(/Recorded [1-9][0-9]* bytes/)
  if (PHYSICAL_MICROPHONE) {
    const track = await page.evaluate(() => {
      const state = window as unknown as {
        __dinksterNativeGetUserMediaSource: string
        __dinksterRecordedAudioTrack: MediaStreamTrack
      }
      return {
        getUserMediaSource: state.__dinksterNativeGetUserMediaSource,
        label: state.__dinksterRecordedAudioTrack.label,
        settings: state.__dinksterRecordedAudioTrack.getSettings(),
        readyState: state.__dinksterRecordedAudioTrack.readyState,
      }
    })
    expect(track.getUserMediaSource).toContain('[native code]')
    expect(track.label).toBe(PHYSICAL_MICROPHONE)
    expect(track.settings.deviceId).toBeTruthy()
    expect(track.readyState).toBe('live')
  }
  await page.waitForTimeout(3_250)
  await recorder.getByRole('button', { name: 'Stop recording' }).click()
  await expect(recorder.getByRole('button', { name: 'Save recording' })).toBeVisible()
  if (PHYSICAL_MICROPHONE) {
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __dinksterRecordedAudioTrack: MediaStreamTrack }).__dinksterRecordedAudioTrack.readyState)).toBe('ended')
  }
  const staged = await page.getByTestId('asset-editor').screenshot({ animations: 'disabled' })
  await testInfo.attach('audio-recording-staged', { body: staged, contentType: 'image/png' })

  let postedBytes: Buffer = Buffer.alloc(0)
  let postedContentType: string | undefined
  await page.route('**/api/assets/media?*', async (route) => {
    postedBytes = route.request().postDataBuffer() ?? Buffer.alloc(0)
    postedContentType = await route.request().headerValue('content-type') ?? undefined
    await route.continue()
  })
  const uploadResponse = page.waitForResponse((candidate) => candidate.request().method() === 'POST' &&
    new URL(candidate.url()).pathname === '/api/assets/media')
  await recorder.getByRole('button', { name: 'Save recording' }).click()
  const accepted = await uploadResponse
  await page.unroute('**/api/assets/media?*')
  expect([200, 201]).toContain(accepted.status())
  const response = await accepted.json() as { readonly asset: UploadedAsset; readonly kind: string }
  const recordedBytes = Buffer.from(await page.evaluate(async () => {
    const chunks = await Promise.all((window as unknown as { __dinksterRecordedAudioChunks: Promise<readonly number[]>[] }).__dinksterRecordedAudioChunks)
    return chunks.flat()
  }))
  expect(postedContentType).toBe('audio/webm')
  expect(postedBytes.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  expect(postedBytes).toEqual(recordedBytes)
  expect(response).toMatchObject({ kind: 'media/audio', asset: { mediaType: 'audio/webm', size: postedBytes.length } })
  await expect(recorder).toContainText('Recording saved to the asset selection')
  await page.getByTestId('asset-apply').click()
  await expect(page.getByTestId('asset-editor')).toBeHidden()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.load!.values.audio))
    .toEqual(response.asset)

  const submitted = await queueEnvelope(page)
  const receiptResponse = await request.get(
    `${NATIVE_BACKEND}/api/jobs/${encodeURIComponent(submitted.clientId)}/${encodeURIComponent(submitted.jobId)}`,
  )
  expect(receiptResponse.ok()).toBe(true)
  const receipt = await receiptResponse.json() as { readonly state: string; readonly executed: readonly string[] }
  expect(receipt).toMatchObject({ state: 'completed', executed: expect.arrayContaining(['load', 'envelope', 'editor']) })

  const descriptorQuery = new URLSearchParams({
    clientId: submitted.clientId, jobId: submitted.jobId, nodeId: 'load', outputId: 'audio',
  })
  const windowQuery = new URLSearchParams({
    clientId: submitted.clientId, jobId: submitted.jobId, nodeId: 'load', outputId: 'audio',
    rendition: 'window', batch: '0', window: '0,3',
  })
  const descriptorResponse = await request.get(`${NATIVE_BACKEND}/api/values?${descriptorQuery}`)
  expect(descriptorResponse.ok()).toBe(true)
  const descriptor = await descriptorResponse.json() as {
    readonly descriptor: { readonly meta: Readonly<Record<string, unknown>> }
    readonly renditions: readonly unknown[]
  }
  expect(descriptor.renditions).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'waveform', version: 'rgba-v1', parameters: ['batch', 'waveform'], defaults: { batch: '0' }, limits: { width: 2048, height: 512, pixels: 262144 } }),
    expect.objectContaining({ kind: 'window', version: 'pcm16-v1', parameters: ['batch', 'window'], defaults: { batch: '0' }, limits: { durationSeconds: 30, sampleValues: 8388608 } }),
  ]))
  const windowResponse = await request.get(`${NATIVE_BACKEND}/api/values?${windowQuery}`)
  expect(windowResponse.ok()).toBe(true)
  const reportedDuration = descriptor.descriptor.meta['duration']
  expect(typeof reportedDuration).toBe('number')
  if (typeof reportedDuration !== 'number') throw new Error('Native audio duration was not reported')
  expect(reportedDuration).toBeGreaterThanOrEqual(3)
  expect(windowResponse.headers()['content-type']).toContain('audio/wav')
  const windowBytes = await windowResponse.body()
  expect(windowBytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
  expect(windowBytes.length).toBeLessThan(3_000_000)
  const channels = windowBytes.readUInt16LE(22)
  const sampleRate = windowBytes.readUInt32LE(24)
  const blockAlign = windowBytes.readUInt16LE(32)
  const duration = windowBytes.readUInt32LE(40) / (sampleRate * blockAlign)
  if (PHYSICAL_MICROPHONE) {
    expect(channels).toBeGreaterThan(0)
    expect(sampleRate).toBeGreaterThan(0)
  } else {
    expect({ channels, sampleRate }).toEqual({ channels: 2, sampleRate: 48_000 })
  }
  expect(duration).toBe(3)
  const pcmBytes = windowBytes.subarray(44)
  let nonzeroSampleValues = 0
  let peakAbsoluteSample = 0
  for (let offset = 0; offset + 1 < pcmBytes.length; offset += 2) {
    const sample = pcmBytes.readInt16LE(offset)
    if (sample !== 0) nonzeroSampleValues += 1
    peakAbsoluteSample = Math.max(peakAbsoluteSample, Math.abs(sample))
  }
  if (PHYSICAL_MICROPHONE) {
    expect(nonzeroSampleValues).toBeGreaterThan(0)
    expect(peakAbsoluteSample).toBeGreaterThan(0)
  }

  const curveQuery = new URLSearchParams({
    clientId: submitted.clientId, jobId: submitted.jobId, nodeId: 'envelope', outputId: 'curve',
  })
  const curveDescriptorResponse = await request.get(`${NATIVE_BACKEND}/api/values?${curveQuery}`)
  expect(curveDescriptorResponse.ok()).toBe(true)
  const curveDescriptor = await curveDescriptorResponse.json() as {
    readonly descriptor: { readonly typeId: string; readonly fingerprint: string }
    readonly renditions: readonly unknown[]
  }
  expect(curveDescriptor.descriptor.typeId).toBe('dinkster.curve')
  expect(curveDescriptor.renditions).toEqual([{
    kind: 'curve-points', mime: 'application/json', default: true,
    cacheKey: 'curve-points', limits: { points: 4096 },
  }])
  const curveResponse = await request.get(`${NATIVE_BACKEND}/api/values?${curveQuery}&rendition=curve-points`)
  expect(curveResponse.ok()).toBe(true)
  expect(curveResponse.headers()).toMatchObject({
    'content-type': 'application/json',
    'x-dinkster-type-id': curveDescriptor.descriptor.typeId,
    'x-dinkster-fingerprint': curveDescriptor.descriptor.fingerprint,
    'x-dinkster-rendition': 'curve-points',
  })
  const computedCurve = await curveResponse.json() as {
    readonly interpolation: 'linear' | 'monotone_cubic'
    readonly points: readonly { readonly position: number; readonly value: number }[]
  }
  expect(computedCurve.points.length).toBeGreaterThan(3)
  expect(computedCurve.points.length).toBeLessThanOrEqual(4096)
  expect(computedCurve.points.at(-1)!.position).toBeGreaterThan(3)

  const graphBeforeFollow = await page.evaluate(() => ({
    revision: window.__dinksterTest!.app.activeTab()!.store.revision,
    document: JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
  }))
  const followTarget = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const curves = app as unknown as {
      curveTargetForInput(tab: unknown, graphId: string, nodeId: string, inputId: string, instancePath: readonly string[]): unknown
    }
    return curves.curveTargetForInput(app.activeTab()!, 'g0', 'editor', 'curve', [])
  })
  expect(followTarget).toMatchObject({
    follow: { envelopeNodeId: 'envelope', audioNodeId: 'load', audioOutputId: 'audio' },
  })
  const curveRenditionRequest = page.waitForRequest((candidate) => {
    const url = new URL(candidate.url())
    return url.pathname === '/api/values' && url.searchParams.get('rendition') === 'curve-points'
  })
  await page.evaluate((target) => {
    const curves = window.__dinksterTest!.app as unknown as { openCurveEditor(target: unknown): void }
    curves.openCurveEditor(target)
  }, followTarget)
  const curveEditor = page.getByTestId('curve-editor')
  await expect(curveEditor).toBeVisible()
  await expect(curveEditor.getByRole('status')).toContainText('Following the executed envelope')
  const renditionRequest = new URL((await curveRenditionRequest).url())
  expect(renditionRequest.searchParams.get('jobId')).toBe(submitted.jobId)
  expect(renditionRequest.searchParams.get('nodeId')).toBe('envelope')
  expect(renditionRequest.searchParams.get('outputId')).toBe('curve')
  await expect(curveEditor.locator('[aria-label^="Curve point"]')).toHaveCount(computedCurve.points.length)
  await expect(curveEditor.getByRole('button', { name: 'Apply' })).toBeDisabled()
  await expect(curveEditor).toContainText('read-only curve')
  const inspectedIndex = Math.floor(computedCurve.points.length * 2 / 3)
  await curveEditor.getByLabel(`Curve point ${inspectedIndex + 1}`).click()
  const inspectedPoint = computedCurve.points[inspectedIndex]!
  await expect(curveEditor.getByTestId('curve-point-value')).toContainText(`Position (s)${inspectedPoint.position.toFixed(4)}`)
  await expect(curveEditor.getByTestId('curve-point-value')).toContainText(`Value${inspectedPoint.value.toFixed(4)}`)
  const curveFollow = await curveEditor.screenshot({ animations: 'disabled' })
  await testInfo.attach('audio-envelope-follow', { body: curveFollow, contentType: 'image/png' })
  expect(await page.evaluate(() => ({
    revision: window.__dinksterTest!.app.activeTab()!.store.revision,
    document: JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
  }))).toEqual(graphBeforeFollow)
  await curveEditor.getByRole('button', { name: 'Cancel' }).click()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))

  const transport = page.locator('.node-media-overlay[data-node-id="load"] .audio-transport')
  await expect(transport).toBeVisible({ timeout: 15_000 })
  await expect(transport).toContainText(/Sample rate \(Hz\): [1-9][0-9]*/)
  await expect(transport).toContainText(/Channels: [1-9][0-9]*/)
  await expect(transport).toContainText(/Layout: \S+/)
  await expect(transport).toContainText(`Duration (s): ${reportedDuration}`)
  await expect(transport).not.toContainText(/NaN|Infinity/)
  await expect(transport.getByRole('button', { name: 'Play audio' })).toBeEnabled()
  const executed = await transport.screenshot({ animations: 'disabled' })
  await testInfo.attach('audio-recording-executed', { body: executed, contentType: 'image/png' })
  if (process.env['DINKSTER_CAPTURE_EVIDENCE'] === '1') {
    mkdirSync(evidenceGroupDir('issue-404'), { recursive: true })
    const evidencePrefix = PHYSICAL_MICROPHONE ? 'physical-microphone' : 'audio-recording'
    if (selectedDevice) writeFileSync(`evidencePath('issue-404', '${evidencePrefix}-selected.png')`, selectedDevice)
    writeFileSync(`evidencePath('issue-404', '${evidencePrefix}-staged.png')`, staged)
    writeFileSync(`evidencePath('issue-404', '${evidencePrefix}-executed.png')`, executed)
    writeFileSync(`evidencePath('issue-404', '${evidencePrefix}-envelope-follow.png')`, curveFollow)
    writeFileSync(`evidencePath('issue-404', '${evidencePrefix}-receipt.json')`, `${JSON.stringify({
      backend: process.env['DINKSTER_BACKEND_SHA'] ?? 'unrecorded',
      ...(PHYSICAL_MICROPHONE ? { device: { label: PHYSICAL_MICROPHONE } } : {}),
      upload: { size: postedBytes.length, sha256: createHash('sha256').update(postedBytes).digest('hex'), asset: response.asset },
      job: { clientId: submitted.clientId, jobId: submitted.jobId, receipt },
      output: descriptor.descriptor.meta,
      window: {
        contentType: windowResponse.headers()['content-type'], size: windowBytes.length, duration, sampleRate, channels,
        layout: channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels} channels`,
        nonzeroSampleValues, peakAbsoluteSample,
      },
    }, null, 2)}\n`)
  }
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const exported = app.exportDocument(app.activeTab()!.id)
    if (!exported) throw new Error('Audio envelope workflow export failed')
    app.openDocument(JSON.parse(JSON.stringify(exported)), 'Reopened Audio Recording')
    const tab = app.activeTab()!
    const curves = app as unknown as {
      curveTargetForInput(tab: unknown, graphId: string, nodeId: string, inputId: string, instancePath: readonly string[]): { readonly follow?: unknown } | undefined
    }
    return {
      asset: tab.store.doc.graphs.g0!.nodes.load!.values.audio,
      follow: curves.curveTargetForInput(tab, 'g0', 'editor', 'curve', [])?.follow,
    }
  })).toEqual({
    asset: response.asset,
    follow: { envelopeNodeId: 'envelope', audioNodeId: 'load', audioOutputId: 'audio' },
  })
})

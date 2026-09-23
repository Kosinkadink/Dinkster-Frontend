import { createSignal, onCleanup, Show } from 'solid-js'
import './audio-controls.css'
import { useAppMessage } from './locale.js'
import { ProductButton } from './ProductControls.js'
import { ProductNumberInput } from './ProductNumberInput.js'
import { ProductSelect } from './ProductSelect.js'

export interface AudioRecordingProvider {
  devices(): Promise<readonly { readonly deviceId: string; readonly label: string }[]>
  open(deviceId: string): Promise<MediaStream>
  recorder(stream: MediaStream): MediaRecorder
}

const browserProvider = (): AudioRecordingProvider | undefined =>
  typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia ? undefined : {
    devices: async () => (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput'),
    open: (deviceId) => navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true }),
    recorder: (stream) => new MediaRecorder(stream),
  }

export function AudioRecorder(props: {
  readonly provider?: AudioRecordingProvider
  readonly disabled?: boolean
  readonly onSave: (file: File) => Promise<boolean>
}) {
  const appMessage = useAppMessage()
  const provider = props.provider ?? browserProvider()
  const [devices, setDevices] = createSignal<readonly { deviceId: string; label: string }[]>([])
  const [device, setDevice] = createSignal('')
  const [limit, setLimit] = createSignal(60)
  const [recordedBytes, setRecordedBytes] = createSignal(0)
  const [state, setState] = createSignal<'idle' | 'permission' | 'recording' | 'ready' | 'saving'>('idle')
  const [message, setMessage] = createSignal(provider ? 'Microphone is off. Recording requires browser permission.' : 'Recording unavailable: this browser needs MediaRecorder and a secure microphone context.')
  let generation = 0
  let stream: MediaStream | undefined
  let recorder: MediaRecorder | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let clip: File | undefined
  let showReadyMessage = false
  let live = true
  const release = () => {
    clearTimeout(timer)
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = undefined
  }
  const cancel = () => {
    generation++
    if (recorder?.state === 'recording') recorder.stop()
    recorder = undefined; release(); clip = undefined; showReadyMessage = false
    setState('idle'); setMessage('Recording cancelled. No clip saved.')
  }
  const discover = async () => {
    const request = generation
    try {
      const available = await provider?.devices() ?? []
      if (!live || generation !== request) return
      setDevices(available)
      setMessage(available.length ? 'Choose a microphone, then Record. Device names may require permission.' : 'No microphone devices found. Connect a microphone or check browser permission.')
    } catch (error) { if (live && generation === request) setMessage(`Device discovery failed: ${error instanceof Error ? error.message : String(error)}`) }
  }
  const stop = () => { if (recorder?.state === 'recording') recorder.stop(); release() }
  const record = async () => {
    if (!provider) return
    const request = ++generation
    clip = undefined; showReadyMessage = false; setRecordedBytes(0); setState('permission'); setMessage('Waiting for explicit browser microphone permission...')
    timer = setTimeout(() => { cancel(); setMessage('Microphone permission request timed out. No clip saved.') }, 30_000)
    try {
      const opened = await provider.open(device())
      if (!live || generation !== request) { for (const track of opened.getTracks()) track.stop(); return }
      clearTimeout(timer)
      stream = opened
      recorder = provider.recorder(opened)
      const chunks: Blob[] = []
      let bytes = 0
      const mime = recorder.mimeType
      recorder.ondataavailable = (event) => {
        if (generation !== request) return
        bytes += event.data.size
        if (bytes > 32 * 1024 * 1024) { cancel(); setMessage('Recording exceeds the 32 MiB limit. No clip saved.'); return }
        if (event.data.size) chunks.push(event.data)
        setRecordedBytes(bytes)
      }
      recorder.onerror = () => { if (generation !== request) return; cancel(); setMessage('Microphone recording failed. No clip saved.') }
      recorder.onstop = () => {
        if (!live || generation !== request) return
        release()
        if (!bytes) { setState('idle'); setMessage('Microphone returned an empty recording.'); return }
        const reportedMime = (mime || chunks[0]?.type || 'audio/webm').split(';', 1)[0]!.trim().toLowerCase()
        const blob = new Blob(chunks, { type: reportedMime })
        const extension = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'
        clip = new File([blob], `recording.${extension}`, { type: blob.type })
        showReadyMessage = true; setState('ready')
      }
      recorder.start(250)
      setState('recording'); setMessage(`Recording microphone. Stops after ${limit()} seconds or 32 MiB.`)
      timer = setTimeout(() => { stop() }, limit() * 1000)
    } catch (error) {
      if (!live || generation !== request) return
      release(); setState('idle')
      const name = error instanceof Error ? error.name : ''
      setMessage(name === 'NotAllowedError' ? 'Microphone permission denied. No audio captured.' : name === 'NotFoundError' ? 'No microphone device is available.' : `Recording unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const save = async () => {
    if (!clip) return
    showReadyMessage = false; setState('saving')
    try {
      const saved = await props.onSave(clip)
      if (!live) return
      setState(saved ? 'idle' : 'ready')
      if (saved) { clip = undefined; setMessage('Recording saved to the asset selection. Apply to use this AUDIO input.') }
      else setMessage('Recording upload failed. Clip retained for retry; see the upload diagnostic.')
    } catch (error) { if (live) { setState('ready'); setMessage(`Recording upload failed: ${error instanceof Error ? error.message : String(error)}`) } }
  }
  onCleanup(() => { live = false; cancel() })
  const idle = () => state() === 'idle' || state() === 'ready'
  return <section class="audio-recorder" aria-label="Record audio">
    <p role="status">{state() === 'ready' && showReadyMessage
      ? appMessage('audioRecorder.ready', { bytes: recordedBytes() })
      : message()}</p>
    <Show when={state() === 'recording'}><p data-testid="audio-recorded-bytes">Recorded {recordedBytes()} bytes</p></Show>
    <Show when={state() !== 'ready' && state() !== 'saving'}>
      <ProductButton type="button" disabled={!provider || !idle() || props.disabled} onClick={() => void discover()}>Find microphones</ProductButton>
      <label>Microphone <ProductSelect
        ariaLabel="Microphone"
        disabled={!idle() || props.disabled === true}
        selectedId={device()}
        options={[{ id: '', label: 'Browser default', value: '' }, ...devices().map((entry, index) => ({ id: entry.deviceId, label: entry.label || `Microphone ${index + 1}`, value: entry.deviceId }))]}
        onSelect={(option) => setDevice(option.value)}
      /></label>
      <label>Limit (s) <ProductNumberInput value={limit()} min={1} max={300} integer disabled={!idle() || props.disabled === true} onCommit={(value) => setLimit(Math.max(1, Math.min(300, Number(value) || 60)))} /></label>
      <ProductButton type="button" variant="primary" disabled={!provider || !idle() || props.disabled} onClick={() => void record()}>Record microphone</ProductButton>
    </Show>
    <Show when={state() === 'recording'}><ProductButton type="button" variant="danger" onClick={stop}>Stop recording</ProductButton></Show>
    <Show when={state() !== 'idle'}><ProductButton type="button" variant="ghost" disabled={state() === 'saving'} onClick={cancel}>Discard recording</ProductButton></Show>
    <Show when={state() === 'ready'}><ProductButton type="button" variant="primary" disabled={props.disabled} onClick={() => void save()}>Save recording</ProductButton></Show>
  </section>
}

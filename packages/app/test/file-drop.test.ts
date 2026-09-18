import { describe, expect, it, vi } from 'vitest'
import type { AssetRef, CommandInvocation, NodeSchema, WorkflowDocument } from '@dinkster/core'
import { classifyDroppedFile, insertDroppedImage, insertDroppedLatent, singleUseFileDropChoice, startCanvasFileDrop, watchFileDropGraphOwner } from '../src/file-drop.js'
import { readLatentMetadata } from '../src/latent-metadata.js'

const file = (bytes: Uint8Array, name = 'drop.bin') => new File([new Uint8Array(bytes).buffer], name)
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length)
  new DataView(out.buffer).setUint32(0, data.length)
  out.set([...type].map((c) => c.charCodeAt(0)), 4)
  out.set(data, 8)
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}
const png = (...chunks: Uint8Array[]) => {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const header = new Uint8Array(13); new DataView(header.buffer).setUint32(0, 1); new DataView(header.buffer).setUint32(4, 1); header[8] = 8; header[9] = 6
  const framed = [chunk('IHDR', header), ...chunks, chunk('IDAT', Uint8Array.from([0])), chunk('IEND', new Uint8Array())]
  const length = signature.length + framed.reduce((sum, value) => sum + value.length, 0)
  const out = new Uint8Array(length); out.set(signature)
  let offset = signature.length
  for (const value of framed) { out.set(value, offset); offset += value.length }
  return out
}
const rawSafetensors = (text: string, body = Uint8Array.from([1, 2, 3, 4])) => {
  const raw = new TextEncoder().encode(text)
  const header = new Uint8Array(raw.length + (-raw.length & 7)); header.set(raw); header.fill(0x20, raw.length)
  const out = new Uint8Array(8 + header.length + body.length)
  new DataView(out.buffer).setBigUint64(0, BigInt(header.length), true)
  out.set(header, 8); out.set(body, 8 + header.length)
  return out
}
const safetensors = (table: Record<string, unknown>, metadata: Record<string, string> = {}, body = Uint8Array.from([1, 2, 3, 4])) =>
  rawSafetensors(JSON.stringify({ __metadata__: metadata, ...table }), body)
const tensor = (dtype: 'F16' | 'BF16' | 'F32' | 'F64', shape: number[], start: number, end: number) =>
  ({ dtype, shape, data_offsets: [start, end] })
const latent = (metadata: Record<string, string> = {}, body = Uint8Array.from([1, 2, 3, 4])) =>
  safetensors({ latent_tensor: tensor('F32', [1], 0, body.length) }, metadata, body)
const hint = (entries: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))))

describe('safe file-drop classification', () => {
  it('recognizes workflow JSON by UTF-8 bytes, not its filename or MIME metadata', async () => {
    await expect(classifyDroppedFile(file(new TextEncoder().encode(' {"version":1}')))).resolves.toEqual({ kind: 'workflow', document: { version: 1 } })
  })

  it('recognizes JPEG and WebP signatures and rejects script-shaped bytes', async () => {
    await expect(classifyDroppedFile(file(Uint8Array.from([0xff, 0xd8, 0xff, 0x00])))).resolves.toMatchObject({ kind: 'image', mediaType: 'image/jpeg' })
    await expect(classifyDroppedFile(file(new TextEncoder().encode('<script>alert(1)</script>')))).resolves.toMatchObject({ kind: 'rejected', code: 'fileDrop.unsupported' })
  })

  it('extracts bounded uncompressed Comfy workflow text from PNG', async () => {
    const text = new TextEncoder().encode('workflow\0{"nodes":[]}')
    await expect(classifyDroppedFile(file(png(chunk('tEXt', text))))).resolves.toEqual({
      kind: 'image', mediaType: 'image/png', embeddedWorkflow: { nodes: [] },
    })
  })

  it('fails closed for malformed embedded workflow JSON and malformed PNG chunks', async () => {
    await expect(classifyDroppedFile(file(png(chunk('tEXt', new TextEncoder().encode('workflow\0{')))))).resolves.toMatchObject({ kind: 'rejected', code: 'fileDrop.invalidPngMetadata' })
    await expect(classifyDroppedFile(file(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0])))).resolves.toMatchObject({ kind: 'rejected', code: 'fileDrop.invalidPngMetadata' })
  })

  it('validates the complete PNG before publishing workflow metadata', async () => {
    const text = chunk('tEXt', new TextEncoder().encode('workflow\0{"nodes":[]}'))
    const badCrc = png(text); badCrc[badCrc.length - 1] = badCrc[badCrc.length - 1]! ^ 1
    await expect(classifyDroppedFile(file(badCrc))).resolves.toMatchObject({ kind: 'rejected', code: 'fileDrop.invalidPngMetadata' })
    await expect(classifyDroppedFile(file(png(text, text)))).resolves.toMatchObject({ kind: 'rejected', code: 'fileDrop.invalidPngMetadata' })
    const trailing = new Uint8Array([...png(text), 0])
    await expect(classifyDroppedFile(file(trailing))).resolves.toMatchObject({ kind: 'rejected', code: 'fileDrop.invalidPngMetadata' })
  })

  it('reads only a bounded latent header and retains workflow and display hints', async () => {
    const workflow = { format: 'dinkster-workflow', formatVersion: 1 }
    const bytes = latent({
      workflow: JSON.stringify(workflow),
      prompt: '{"ignored":true}',
      dinkster_vae_hint: hint({ version: 1, sourceDigest: `blake3:${'a'.repeat(64)}`, sourceName: '<vae & name>', latentSpace: 'dinkster.test' }),
      unrelated: 'not retained',
    })
    const source = file(bytes, 'sample.latent')
    const slice = vi.spyOn(source, 'slice')
    await expect(classifyDroppedFile(source)).resolves.toEqual({
      kind: 'latent', metadata: { workflow, vaeHint: '<vae & name>', latentSpace: 'dinkster.test' },
    })
    expect(slice).toHaveBeenCalledTimes(2)
    expect(slice.mock.calls).toEqual([[0, 8], [8, 8 + Number(new DataView(bytes.buffer).getBigUint64(0, true))]])
  })

  it('rejects latent uint64, header extent, UTF-8, duplicate-key, tensor, and retained metadata violations', async () => {
    const tooLarge = new Uint8Array(9); new DataView(tooLarge.buffer).setBigUint64(0, BigInt(4 * 1024 * 1024 + 8), true)
    await expect(readLatentMetadata(file(tooLarge, 'bad.latent'))).resolves.toMatchObject({ ok: false, message: expect.stringContaining('size limit') })
    const beyond = new Uint8Array(9); new DataView(beyond.buffer).setBigUint64(0, 16n, true)
    await expect(readLatentMetadata(file(beyond, 'bad.latent'))).resolves.toMatchObject({ ok: false, message: expect.stringContaining('beyond') })
    const invalidUtf8 = new Uint8Array(16); new DataView(invalidUtf8.buffer).setBigUint64(0, 8n, true); invalidUtf8.fill(0x20, 8); invalidUtf8[8] = 0xff
    await expect(readLatentMetadata(file(invalidUtf8, 'bad.latent'))).resolves.toMatchObject({ ok: false, message: expect.stringContaining('UTF-8') })
    const duplicateText = '{"latent_tensor":{"dtype":"F32","shape":[1],"data_offsets":[0,4]},"latent_tensor":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}   '
    const duplicateHeader = new TextEncoder().encode(duplicateText)
    const duplicate = new Uint8Array(9 + duplicateHeader.length); new DataView(duplicate.buffer).setBigUint64(0, BigInt(duplicateHeader.length), true); duplicate.set(duplicateHeader, 8)
    await expect(readLatentMetadata(file(duplicate, 'bad.latent'))).resolves.toMatchObject({ ok: false })
    const badOffsets = latent({}, Uint8Array.from([1, 2, 3]))
    await expect(readLatentMetadata(file(badOffsets, 'bad.latent'))).resolves.toMatchObject({ ok: false, message: expect.stringContaining('tensor table') })
    await expect(readLatentMetadata(file(latent({ dinkster_vae_hint: 'x'.repeat(8 * 1024 + 1) }), 'bad.latent'))).resolves.toMatchObject({ ok: false, message: expect.stringContaining('size limit') })

    const gapRaw = new TextEncoder().encode(JSON.stringify({ latent_tensor: tensor('F32', [1], 1, 5) }))
    const gapHeader = new Uint8Array(gapRaw.length + (-gapRaw.length & 7)); gapHeader.set(gapRaw); gapHeader.fill(0x20, gapRaw.length)
    const gap = new Uint8Array(13 + gapHeader.length); new DataView(gap.buffer).setBigUint64(0, BigInt(gapHeader.length), true); gap.set(gapHeader, 8)
    await expect(readLatentMetadata(file(gap, 'bad.latent'))).resolves.toMatchObject({ ok: false, message: expect.stringContaining('tensor table') })
    const padded = latent(); const originalLength = Number(new DataView(padded.buffer).getBigUint64(0, true)); padded[8 + originalLength - 1] = 0x09
    await expect(readLatentMetadata(file(padded, 'bad.latent'))).resolves.toMatchObject({ ok: false })
  })

  it('accepts exact native single/multi and ComfyUI flat profiles', async () => {
    const singleSchema = JSON.stringify({
      format: 'dinkster.latent', version: 1, structure: 'single',
      streams: [{ tensor: 'dinkster_samples', dtype: 'F16', shape: [1, 2] }],
    })
    await expect(readLatentMetadata(file(safetensors({ dinkster_samples: tensor('F16', [1, 2], 0, 4) }, {
      dinkster_latent_schema: singleSchema,
    }), 'single.latent'))).resolves.toMatchObject({ ok: true })

    const multiSchema = JSON.stringify({
      format: 'dinkster.latent', version: 1, structure: 'multi', streams: [
        { order: 0, role: 'video', tensor: 'dinkster_stream_0000', dtype: 'F16', shape: [1] },
        { order: 1, role: 'audio', tensor: 'dinkster_stream_0001', dtype: 'F16', shape: [1] },
      ],
    })
    await expect(readLatentMetadata(file(safetensors({
      dinkster_stream_0000: tensor('F16', [1], 0, 2),
      dinkster_stream_0001: tensor('F16', [1], 2, 4),
    }, { dinkster_latent_schema: multiSchema }), 'multi.latent'))).resolves.toMatchObject({ ok: true })

    await expect(readLatentMetadata(file(latent({ format: 'anything', prompt: '{}' }), 'legacy.latent'))).resolves.toMatchObject({ ok: true })
    await expect(readLatentMetadata(file(safetensors({
      latent_tensor: tensor('F32', [1], 0, 4),
      latent_format_version_0: tensor('F32', [0], 4, 4),
    }, { format: 'irrelevant' }), 'current.latent'))).resolves.toMatchObject({ ok: true })
  })

  it('rejects indexed-only, model, malformed markers, extra tensors, malformed native, and unaligned profiles', async () => {
    await expect(readLatentMetadata(file(safetensors({
      latent_tensor_0: tensor('F16', [1], 0, 2), latent_tensor_1: tensor('F16', [1], 2, 4),
    }), 'indexed.latent'))).resolves.toMatchObject({ ok: false, message: expect.stringContaining('profile') })
    await expect(readLatentMetadata(file(safetensors({ model_weight: tensor('F32', [1], 0, 4) }), 'model.safetensors')))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining('profile') })
    await expect(readLatentMetadata(file(safetensors({
      latent_tensor: tensor('F16', [1], 0, 2), extra: tensor('F16', [1], 2, 4),
    }), 'extra-flat.latent'))).resolves.toMatchObject({ ok: false, message: expect.stringContaining('profile') })
    for (const marker of [
      tensor('F16', [0], 4, 4),
      tensor('F32', [1], 4, 8),
      tensor('F32', [0], 0, 0),
    ]) {
      const body = marker.shape[0] === 1 ? new Uint8Array(8) : new Uint8Array(4)
      await expect(readLatentMetadata(file(safetensors({
        latent_tensor: tensor('F32', [1], 0, 4), latent_format_version_0: marker,
      }, {}, body), 'bad-marker.latent'))).resolves.toMatchObject({ ok: false })
    }
    await expect(readLatentMetadata(file(safetensors({
      latent_tensor: tensor('F32', [1], 0, 4),
      extra: tensor('F16', [1], 4, 6),
      latent_format_version_0: tensor('F32', [0], 6, 6),
    }, {}, new Uint8Array(6)), 'marker-extra.latent'))).resolves.toMatchObject({ ok: false, message: expect.stringContaining('profile') })

    const schema = (version: number, extra = false) => JSON.stringify({
      format: 'dinkster.latent', version, structure: 'single',
      streams: [{ tensor: 'dinkster_samples', dtype: 'F32', shape: [1] }], ...(extra ? { extra: true } : {}),
    })
    for (const dinkster_latent_schema of [schema(2), schema(1, true), '{']) {
      await expect(readLatentMetadata(file(safetensors({ dinkster_samples: tensor('F32', [1], 0, 4) }, {
        dinkster_latent_schema,
      }), 'native.latent'))).resolves.toMatchObject({ ok: false, message: expect.stringContaining('profile') })
    }
    await expect(readLatentMetadata(file(safetensors({
      dinkster_samples: tensor('F32', [1], 0, 4), extra: tensor('F32', [1], 4, 8),
    }, { dinkster_latent_schema: schema(1) }, new Uint8Array(8)), 'extra.latent')))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining('profile') })
    const controlledRole = JSON.stringify({
      format: 'dinkster.latent', version: 1, structure: 'multi',
      streams: [{ order: 0, role: 'video\nunsafe', tensor: 'dinkster_stream_0000', dtype: 'F32', shape: [1] }],
    })
    await expect(readLatentMetadata(file(safetensors({ dinkster_stream_0000: tensor('F32', [1], 0, 4) }, {
      dinkster_latent_schema: controlledRole,
    }), 'controlled-role.latent'))).resolves.toMatchObject({ ok: false, message: expect.stringContaining('profile') })

    const aligned = latent(); const length = Number(new DataView(aligned.buffer).getBigUint64(0, true))
    const unaligned = new Uint8Array(aligned.length - 1); unaligned.set(aligned.subarray(0, 8 + length - 1)); unaligned.set(aligned.subarray(8 + length), 8 + length - 1)
    new DataView(unaligned.buffer).setBigUint64(0, BigInt(length - 1), true)
    await expect(readLatentMetadata(file(unaligned, 'unaligned.latent'))).resolves.toMatchObject({ ok: false, message: expect.stringContaining('alignment') })
  })

  it('requires integer JSON tokens for tensor dimensions and offsets without restricting metadata JSON numbers', async () => {
    for (const descriptor of [
      '"shape":[1e0],"data_offsets":[0,4]',
      '"shape":[1.0],"data_offsets":[0,4]',
      '"shape":[1],"data_offsets":[0e0,4]',
      '"shape":[1],"data_offsets":[0.0,4]',
      '"shape":[true],"data_offsets":[0,4]',
    ]) {
      const bytes = rawSafetensors(`{"__metadata__":{"workflow":"{\\"value\\":1e0}"},"latent_tensor":{"dtype":"F32",${descriptor}}}`)
      await expect(classifyDroppedFile(file(bytes, 'numeric.latent'))).resolves.toMatchObject({
        kind: 'rejected', code: 'fileDrop.invalidLatent',
      })
    }
    await expect(readLatentMetadata(file(latent({ workflow: '{"value":1e0}' }), 'workflow-number.latent')))
      .resolves.toEqual({ ok: true, metadata: { workflow: { value: 1 } } })
  })

  it('omits malformed or path-bearing VAE hints without rejecting the latent', async () => {
    const digest = `blake3:${'b'.repeat(64)}`
    await expect(readLatentMetadata(file(latent({
      dinkster_vae_hint: hint({ version: 1, sourceDigest: digest, sourceName: '../private/model.safetensors', latentSpace: 'dinkster.test' }),
    }), 'safe.latent'))).resolves.toEqual({ ok: true, metadata: {} })
    await expect(readLatentMetadata(file(latent({
      dinkster_vae_hint: hint({ version: 2, sourceDigest: digest, sourceName: 'model.safetensors' }),
    }), 'safe.latent'))).resolves.toEqual({ ok: true, metadata: {} })
    for (const unsafe of [
      { sourceName: 'line\nbreak' }, { sourceLogicalId: 'data:text/plain,bad' },
      { sourceName: 'ssh:host' }, { latentSpace: '../private' },
      { latentSpace: 'https://example.test/model' }, { latentSpace: 'not a registered id' },
    ]) {
      await expect(readLatentMetadata(file(latent({
        dinkster_vae_hint: hint({ version: 1, sourceDigest: digest, ...unsafe }),
      }), 'safe.latent'))).resolves.toEqual({ ok: true, metadata: {} })
    }
    await expect(readLatentMetadata(file(latent({
      dinkster_vae_hint: JSON.stringify({ version: 1, sourceDigest: digest, sourceName: 'ordered-wrongly' }),
    }), 'safe.latent'))).resolves.toEqual({ ok: true, metadata: {} })
  })
})

describe('file-drop lifecycle gates', () => {
  const source = <T>() => {
    const listeners = new Set<(value: T) => void>()
    return {
      signal: { subscribe: (listener: (value: T) => void) => { listeners.add(listener); return () => listeners.delete(listener) } },
      emit: (value: T) => { for (const listener of [...listeners]) listener(value) },
    }
  }

  it.each(['deletion', 'navigation'] as const)('aborts immediately and idempotently on graph %s', (loss) => {
    const documents = source<WorkflowDocument>()
    const stacks = source<readonly string[]>()
    const abort = new AbortController()
    const retired = vi.fn()
    const stop = watchFileDropGraphOwner({
      graphId: 'g0', document: documents.signal, graphStack: stacks.signal,
      cancel: () => abort.abort(), onRetired: retired,
    })
    expect(abort.signal.aborted).toBe(false)
    if (loss === 'deletion') documents.emit({ graphs: {} } as unknown as WorkflowDocument)
    else stacks.emit(['g0', 'g1'])
    expect(abort.signal.aborted).toBe(true)
    expect(retired).toHaveBeenCalledTimes(loss === 'deletion' ? 1 : 0)
    documents.emit({ graphs: {} } as unknown as WorkflowDocument)
    stacks.emit(['g0', 'g2'])
    expect(retired).toHaveBeenCalledTimes(loss === 'deletion' ? 1 : 0)
    stop(); stop()
  })

  it('consumes an embedded choice synchronously across double-click and cross-choice races', async () => {
    const clear = vi.fn()
    const imported = vi.fn()
    const uploaded = vi.fn()
    let resolveImport!: () => void
    const importPending = new Promise<void>((resolve) => { resolveImport = resolve })
    const choice = singleUseFileDropChoice(clear)
    expect(choice.run(() => { void importPending.then(imported) })).toBe(true)
    expect(clear).toHaveBeenCalledOnce()
    expect(choice.run(() => { void importPending.then(imported) })).toBe(false)
    expect(choice.run(uploaded)).toBe(false)
    expect(choice.run(vi.fn())).toBe(false)
    resolveImport()
    await importPending
    await Promise.resolve()
    expect(imported).toHaveBeenCalledOnce()
    expect(uploaded).not.toHaveBeenCalled()
  })

  it('runs image upload and dispatch exactly once when Load image wins the cross-choice race', () => {
    const clear = vi.fn(); const upload = vi.fn(); const dispatch = vi.fn(); const importWorkflow = vi.fn()
    const choice = singleUseFileDropChoice(clear)
    expect(choice.run(() => { upload(); dispatch() })).toBe(true)
    expect(choice.run(() => { upload(); dispatch() })).toBe(false)
    expect(choice.run(importWorkflow)).toBe(false)
    expect(clear).toHaveBeenCalledOnce()
    expect(upload).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(importWorkflow).not.toHaveBeenCalled()
  })

  it.each(['dismiss-blocked editor', 'app modal'])('refuses ingress under %s before any side effect', () => {
    const upload = vi.fn(); const importWorkflow = vi.fn(); const dispatch = vi.fn()
    const document = { nodes: 0 }
    expect(startCanvasFileDrop(true, () => {
      upload(); importWorkflow(); dispatch(); document.nodes += 1
    })).toBe(false)
    expect(upload).not.toHaveBeenCalled()
    expect(importWorkflow).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(document.nodes).toBe(0)
  })
})

describe('dropped image insertion', () => {
  const digest = `blake3:${'a'.repeat(64)}`
  const schema = {
    type: 'dinkster.load_image', displayName: 'Load Image', category: 'image', source: { kind: 'dinkster' }, isOutputNode: false,
    items: [{ kind: 'input', id: 'image', type: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } }, required: true, widget: { widgetType: 'ASSET' } }],
  } as unknown as NodeSchema
  const document = { graphs: { g0: { nodes: {} } } } as unknown as WorkflowDocument
  const base = () => ({
    file: new File([new Uint8Array([0, 255, 17, 33, 4])], 'private-local-name.png', { type: 'image/png' }),
    mediaType: 'image/png' as const, graphId: 'g0', position: { x: 12, y: 34 },
    tabStillOpen: () => true, graphStillOwned: () => true, currentGraphId: () => 'g0', frozen: () => false,
    document: () => document, resolve: () => (type: string) => type === schema.type ? schema : undefined,
    predictedNodeId: () => 'n1', upload: vi.fn(async () => digest), dispatch: vi.fn((_invocation: CommandInvocation) => true), onInserted: vi.fn(),
  })

  it('uploads first, then dispatches one atomic batch with a complete anonymous AssetRef', async () => {
    let resolveUpload!: (value: string) => void
    const upload = new Promise<string>((resolve) => { resolveUpload = resolve })
    const p = { ...base(), upload: vi.fn((_body: Blob) => upload) }
    const pending = insertDroppedImage(p)
    await Promise.resolve()
    expect(p.upload).toHaveBeenCalledOnce()
    const uploaded = p.upload.mock.calls[0]![0]
    expect(uploaded).toBe(p.file)
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(new Uint8Array([0, 255, 17, 33, 4]))
    expect(p.dispatch).not.toHaveBeenCalled()

    resolveUpload(digest)
    await expect(pending).resolves.toBe('inserted')
    expect(p.dispatch).toHaveBeenCalledOnce()
    expect(p.dispatch.mock.calls[0]![0]).toMatchObject({ command: 'batch', params: { invocations: [{
      command: 'node.add', params: { graphId: 'g0', type: 'dinkster.load_image', position: { x: 12, y: 34 }, values: { image: {
        digest, name: 'dropped-image.png', size: 5, mediaType: 'image/png', virtualPath: '',
      } } },
    }] } })
    expect(p.onInserted).toHaveBeenCalledWith('n1')
  })

  it('names the asset from the assetName override instead of the dropped default', async () => {
    const p = { ...base(), assetName: 'pasted-image.png' }
    await expect(insertDroppedImage(p)).resolves.toBe('inserted')
    expect(p.dispatch.mock.calls[0]![0]).toMatchObject({ command: 'batch', params: { invocations: [{
      command: 'node.add', params: { values: { image: { digest, name: 'pasted-image.png' } } },
    }] } })
  })

  it('refuses stale owners and upload failures without graph mutation', async () => {
    const stale = { ...base(), tabStillOpen: () => false }
    await expect(insertDroppedImage(stale)).resolves.toBe('stale-tab')
    expect(stale.dispatch).not.toHaveBeenCalled()
    const failed = { ...base(), upload: vi.fn(async () => { throw new Error('no') }) }
    await expect(insertDroppedImage(failed)).resolves.toBe('upload-failed')
    expect(failed.dispatch).not.toHaveBeenCalled()
  })

  it('rechecks ownership after a deferred upload before dispatch', async () => {
    let live = true
    let resolveUpload!: (digest: string) => void
    const upload = new Promise<string>((resolve) => { resolveUpload = resolve })
    const p = { ...base(), tabStillOpen: () => live, upload: vi.fn(() => upload) }
    const pending = insertDroppedImage(p)
    live = false
    resolveUpload(digest)
    await expect(pending).resolves.toBe('stale-tab')
    expect(p.dispatch).not.toHaveBeenCalled()
  })

  it('does not bypass the catalog when canonical Load Image is absent', async () => {
    const p = { ...base(), resolve: () => () => undefined }
    await expect(insertDroppedImage(p)).resolves.toBe('schema-missing')
    expect(p.dispatch).not.toHaveBeenCalled()
  })

  it('does not author through a hidden compatibility asset input', async () => {
    const hidden = { ...schema, items: [{ ...schema.items[0]!, hidden: true }] } as NodeSchema
    const p = { ...base(), resolve: () => () => hidden }
    await expect(insertDroppedImage(p)).resolves.toBe('schema-missing')
    expect(p.dispatch).not.toHaveBeenCalled()
  })
})

describe('dropped latent insertion', () => {
  const digest = `blake3:${'d'.repeat(64)}`
  const asset: AssetRef = {
    digest, name: 'canonical.latent', size: 123, mediaType: 'application/x-comfy-latent', virtualPath: '',
  }
  const schema = {
    type: 'dinkster.load_latent', displayName: 'Load Latent', category: 'latent', source: { kind: 'dinkster' }, isOutputNode: false,
    items: [{ kind: 'input', id: 'latent', type: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.LATENT' } }, required: true, widget: { widgetType: 'ASSET', kind: 'data/latent' } }],
  } as unknown as NodeSchema
  const document = { graphs: { g0: { nodes: {} } } } as unknown as WorkflowDocument
  const base = () => ({
    file: file(latent(), 'private-name.safetensors'), graphId: 'g0', position: { x: 40, y: 60 },
    tabStillOpen: () => true, graphStillOwned: () => true, currentGraphId: () => 'g0', frozen: () => false,
    document: () => document, resolve: () => (type: string) => type === schema.type ? schema : undefined,
    predictedNodeId: () => 'n2', upload: vi.fn(async () => asset), dispatch: vi.fn((_invocation: CommandInvocation) => true), onInserted: vi.fn(),
  })

  it('adopts the exact canonical AssetRef and inserts one native Load Latent node without execution', async () => {
    const p = base()
    await expect(insertDroppedLatent(p)).resolves.toBe('inserted')
    expect(p.upload).toHaveBeenCalledWith(p.file)
    expect(p.dispatch).toHaveBeenCalledOnce()
    expect(p.dispatch.mock.calls[0]![0]).toMatchObject({ command: 'batch', params: { invocations: [{
      command: 'node.add', params: { graphId: 'g0', type: 'dinkster.load_latent', position: { x: 40, y: 60 }, values: { latent: asset } },
    }] } })
  })

  it('does not insert after cancellation, failed upload, or a malformed canonical response', async () => {
    let live = true
    let resolveUpload!: (value: AssetRef) => void
    const pendingUpload = new Promise<AssetRef>((resolve) => { resolveUpload = resolve })
    const cancelled = { ...base(), tabStillOpen: () => live, upload: vi.fn(() => pendingUpload) }
    const pending = insertDroppedLatent(cancelled)
    live = false; resolveUpload(asset)
    await expect(pending).resolves.toBe('stale-tab')
    expect(cancelled.dispatch).not.toHaveBeenCalled()
    const failed = { ...base(), upload: vi.fn(async () => { throw new Error('cancelled') }) }
    await expect(insertDroppedLatent(failed)).resolves.toBe('upload-failed')
    expect(failed.dispatch).not.toHaveBeenCalled()
    const malformed = { ...base(), upload: vi.fn(async () => ({ ...asset, mediaType: 'application/octet-stream' })) }
    await expect(insertDroppedLatent(malformed)).resolves.toBe('invalid-asset')
    expect(malformed.dispatch).not.toHaveBeenCalled()
  })

  it.each([undefined, 'data/checkpoint'])('refuses a Load Latent schema with widget kind %s', async (kind) => {
    const item = schema.items[0]! as Extract<NodeSchema['items'][number], { kind: 'input' }>
    const wrongSchema = { ...schema, items: [{
      ...item, widget: { widgetType: 'ASSET', options: {}, ...(kind === undefined ? {} : { kind }) },
    }] } as unknown as NodeSchema
    const p = { ...base(), resolve: () => () => wrongSchema }
    await expect(insertDroppedLatent(p)).resolves.toBe('schema-missing')
    expect(p.dispatch).not.toHaveBeenCalled()
  })

  it('does not author through a hidden compatibility asset input', async () => {
    const hidden = { ...schema, items: [{ ...schema.items[0]!, hidden: true }] } as NodeSchema
    const p = { ...base(), resolve: () => () => hidden }
    await expect(insertDroppedLatent(p)).resolves.toBe('schema-missing')
    expect(p.dispatch).not.toHaveBeenCalled()
  })
})

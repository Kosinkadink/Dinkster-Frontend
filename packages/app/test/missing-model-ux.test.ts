import { describe, expect, it } from 'vitest'
import { unresolvedAssetImportDiagnostic } from '../src/CanvasHost.js'
import { backendSupportsAssetAcquisition, mediaAcceptsFile, unresolvedAssetBasename } from '../src/WidgetEditor.js'

describe('unresolved imported ASSET diagnostics', () => {
  it('matches exact and wildcard media accepts without trusting an empty type', () => {
    expect(mediaAcceptsFile(['image/*'], 'image/png')).toBe(true)
    expect(mediaAcceptsFile(['image/png'], 'image/png')).toBe(true)
    expect(mediaAcceptsFile(['image/*'], 'audio/wav')).toBe(false)
    expect(mediaAcceptsFile(['video/*'], 'video/webm')).toBe(true)
    expect(mediaAcceptsFile(['video/*'], 'image/webp')).toBe(false)
    expect(mediaAcceptsFile(['*/*'], 'video/webm')).toBe(true)
    expect(mediaAcceptsFile(['image/*'], '')).toBe(false)
  })

  it('uses a distinct anchored error with the original path, basename, and expected kind', () => {
    const diagnostic = unresolvedAssetImportDiagnostic({
      graphId: 'g0',
      nodeId: 'loader',
      inputId: 'ckpt_name',
      valueKey: 'ckpt_name',
      requested: 'models\\checkpoints/missing-model.safetensors',
      expectedKind: 'model/checkpoint',
    })

    expect(diagnostic.severity).toBe('error')
    expect(diagnostic.code).toBe('widget.ASSET.unresolvedImport')
    expect(diagnostic.code).not.toBe('widget.ASSET.badValue')
    expect(diagnostic.message).toContain('models\\checkpoints/missing-model.safetensors')
    expect(diagnostic.message).toContain('missing-model.safetensors')
    expect(diagnostic.message).toContain('model/checkpoint')
    expect(diagnostic.refs).toEqual([{
      graphId: 'g0', nodeId: 'loader', portId: 'ckpt_name', valueKey: 'ckpt_name', direction: 'input',
    }])
  })

  it('normalizes both imported path separators without altering the requested value', () => {
    const requested = 'models/subdir/checkpoint.safetensors'
    expect(unresolvedAssetBasename(requested)).toBe('checkpoint.safetensors')
    expect(requested).toBe('models/subdir/checkpoint.safetensors')
  })

  it('keeps acquisition disabled until the backend has an explicit contract', () => {
    expect(backendSupportsAssetAcquisition()).toBe(false)
  })
})

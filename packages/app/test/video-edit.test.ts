import { describe, expect, it } from 'vitest'
import type { WidgetSpec } from '@dinkster/core'
import { normalizedVideoCrop, trimFrameWindow, updateVideoEditSection, videoEditFeatures, videoSourceFacts } from '../src/video-edit.js'

describe('VIDEO_EDIT contract', () => {
  it('preserves unknown imported fields while changing one known section', () => {
    const imported = {
      vendor: { future: true },
      trim: { start_time: 1.25, duration: 3.5, future_trim: 'keep' },
      crop: { x: 100, y: 40, width: 1280, height: 720 },
    }
    expect(updateVideoEditSection(imported, 'trim', { start_time: 2, duration: 0 })).toEqual({
      vendor: { future: true },
      trim: { start_time: 2, duration: 0, future_trim: 'keep' },
      crop: { x: 100, y: 40, width: 1280, height: 720 },
    })
    expect(imported.trim).toEqual({ start_time: 1.25, duration: 3.5, future_trim: 'keep' })
  })

  it('keeps empty and partial edits legal and duration zero means the source end', () => {
    expect(updateVideoEditSection({}, 'crop', { width: 0 })).toEqual({ crop: { width: 0 } })
    expect(trimFrameWindow(1.25, 0, { duration: 10, fps: 24 })).toEqual({ start: 30, end: 240, playheadMax: 239 })
    expect(trimFrameWindow(-2, 0, { duration: 10, fps: 24 })).toEqual({ start: 192, end: 240, playheadMax: 239 })
    expect(trimFrameWindow(-20, 3, { duration: 10, fps: 24 })).toEqual({ start: 0, end: 72, playheadMax: 71 })
  })

  it('keeps time-derived controls independent of actual or estimated VFR frame counts', () => {
    expect(trimFrameWindow(1.25, 0, { duration: 10, fps: 24, frameCount: 17 }))
      .toEqual({ start: 30, end: 240, playheadMax: 239 })
    expect(trimFrameWindow(1.25, 0, { duration: 10, fps: 24, frameCount: 300 }))
      .toEqual({ start: 30, end: 240, playheadMax: 239 })
  })

  it('clamps and even-aligns crop pixels with full-frame sentinels', () => {
    expect(normalizedVideoCrop(1920, 1080, { x: 101, y: 41, width: 2000, height: 2000 }))
      .toEqual({ x: 100, y: 40, width: 1820, height: 1040 })
    expect(normalizedVideoCrop(1920, 1080, { x: 50, y: 50, width: 0, height: 720 }))
      .toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(normalizedVideoCrop(1920, 1080, { x: 50, y: 50, width: 720, height: -1 }))
      .toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(normalizedVideoCrop(1920, 1080, { x: 50, y: 50, width: 1, height: 720 }))
      .toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(normalizedVideoCrop(1919, 1079, { x: 0, y: 0, width: 1919, height: 1079 }))
      .toEqual({ x: 0, y: 0, width: 1919, height: 1079 })
    expect(normalizedVideoCrop(1919, 1079, { x: -1, y: -1, width: 2000, height: 2000 }))
      .toEqual({ x: 0, y: 0, width: 1919, height: 1079 })
    expect(normalizedVideoCrop(1920, 1080, { x: 1919, y: 1079, width: 50, height: 50 }))
      .toEqual({ x: 1918, y: 1078, width: 2, height: 2 })
  })

  it('reads rational effective facts, never coded probe dimensions or fabricated unknown timing', () => {
    const effective = { width: 1080, height: 1920, duration: [1001, 300], fps: [30000, 1001], frame_count: 100 }
    expect(videoSourceFacts({ probe: { width: 1920, height: 1080 }, effective })).toEqual({
      width: 1080, height: 1920, duration: 1001 / 300, fps: 30000 / 1001, frameCount: 100,
    })
    expect(videoSourceFacts({ effective: { ...effective, fps: null } })).toBeUndefined()
    expect(videoSourceFacts({ effective: { ...effective, duration: [10, 0] } })).toBeUndefined()
    expect(videoSourceFacts({ probe: effective })).toBeUndefined()
  })

  it('uses the feature list only for section visibility', () => {
    const spec = (features?: unknown): WidgetSpec => ({ widgetType: 'VIDEO_EDIT', options: features === undefined ? {} : { features } })
    expect([...videoEditFeatures(spec())]).toEqual(['trim', 'crop'])
    expect([...videoEditFeatures(spec(['crop']))]).toEqual(['crop'])
    expect([...videoEditFeatures(spec([]))]).toEqual([])
  })
})

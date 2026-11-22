import { vi } from 'vitest'

// Node tests measure layout without a browser canvas; browser tests use real fonts.
vi.mock('../src/canvas-measures.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/canvas-measures.js')>()
  return { canvasMeasures: (...args: Parameters<typeof actual.canvasMeasures>) => ({
    ...actual.canvasMeasures(...args),
    measure: (text: string) => text.length * 6,
  }) }
})

import { vi } from 'vitest'

// Unit tests have no real canvas; browser E2E measures the bundled fonts.
vi.mock('../src/canvas-measures.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/canvas-measures.js')>()
  return { canvasMeasures: (...args: Parameters<typeof actual.canvasMeasures>) => ({
    ...actual.canvasMeasures(...args),
    measure: (text: string) => text.length * 6,
  }) }
})

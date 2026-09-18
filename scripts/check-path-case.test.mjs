import assert from 'node:assert/strict'
import test from 'node:test'
import { findCaseCollisions } from './check-path-case.mjs'

test('tracked path guard finds case-insensitive collisions', () => {
  assert.deepEqual(
    findCaseCollisions(['src/help/Markdown.tsx', 'src/help/markdown.ts', 'src/help/other.ts']),
    [['src/help/Markdown.tsx', 'src/help/markdown.ts']],
  )
  assert.deepEqual(findCaseCollisions(['src/help/Markdown.tsx', 'src/help/markdownParser.ts']), [])
})

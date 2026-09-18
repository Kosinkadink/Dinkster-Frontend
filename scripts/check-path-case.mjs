import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function findCaseCollisions(paths) {
  const firstByFoldedPath = new Map()
  const collisions = []
  for (const path of paths) {
    const foldedPath = path.toLowerCase()
      .replace(/\.tsx?$/, '.js')
      .replace(/\.mts$/, '.mjs')
      .replace(/\.cts$/, '.cjs')
    const first = firstByFoldedPath.get(foldedPath)
    if (first !== undefined && first !== path) collisions.push([first, path])
    else firstByFoldedPath.set(foldedPath, path)
  }
  return collisions
}

export function trackedPaths() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
}

function main() {
  const collisions = findCaseCollisions(trackedPaths())
  if (collisions.length === 0) return
  console.error('Tracked paths collide on case-insensitive builds or filesystems:')
  for (const [first, second] of collisions) console.error(`- ${first}\n  ${second}`)
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()

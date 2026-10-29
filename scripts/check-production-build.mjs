import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  semanticCssRoot,
  semanticCssVariables,
} from '../packages/core/src/ui/tokens.ts'

const output = new URL('../packages/app/dist/', import.meta.url)
const html = readFileSync(new URL('index.html', output), 'utf8')
const styleStart = html.indexOf('<style data-dinkster-semantic-tokens')
const moduleScriptStart = html.indexOf('<script type="module"')
assert.ok(styleStart >= 0, 'semantic tokens must be emitted inline')
assert.ok(
  moduleScriptStart > styleStart,
  'semantic tokens must precede the app entry',
)
assert.ok(
  html.includes(semanticCssRoot),
  'the complete semantic token projection must be emitted',
)
for (const [name, value] of Object.entries(semanticCssVariables)) {
  assert.ok(
    html.includes(`${name}: ${value};`),
    `missing semantic token ${name}`,
  )
}
const entry = html.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/)
assert.ok(entry, 'production HTML must reference the app module')
assert.ok(
  readFileSync(new URL(entry[1].replace(/^\//, ''), output)).length > 0,
  'app entry must not be empty',
)
const branding = new URL('../branding/', import.meta.url)
for (const directory of ['svg', 'raster/color', 'platform']) {
  for (const name of readdirSync(new URL(`${directory}/`, branding))) {
    assert.deepEqual(
      readFileSync(new URL(`branding/${directory}/${name}`, output)),
      readFileSync(new URL(`${directory}/${name}`, branding)),
      `published brand asset must equal its canonical source: ${directory}/${name}`,
    )
  }
}
const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', output), 'utf8'))
assert.equal(manifest.name, 'Dinkster')
for (const icon of manifest.icons) {
  assert.ok(readFileSync(new URL(icon.src, output)).length > 0)
}
for (const icon of html.matchAll(/<link\b[^>]*rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="([^"]+)"/g)) {
  assert.ok(readFileSync(new URL(icon[1].replace(/^\//, ''), output)).length > 0)
}
console.log('Production entry, semantic tokens and canonical brand assets verified')

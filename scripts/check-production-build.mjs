import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
console.log('Production entry and inline semantic tokens verified')

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { build } from 'vite'
import { semanticCssRoot, semanticCssVariables } from '@dinkster/core'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url))

describe('production build', () => {
  it('bundles the app entry for the configured browser target', async () => {
    const result = await build({
      root: appRoot,
      configFile,
      logLevel: 'silent',
      build: { write: false },
    })
    const outputs = Array.isArray(result) ? result : 'output' in result ? [result] : []
    expect(outputs.some((output) => output.output.some(
      (item) => item.type === 'chunk' && item.isEntry,
    ))).toBe(true)

    const htmlAsset = outputs.flatMap((output) => output.output).find(
      (item) => item.type === 'asset' && item.fileName === 'index.html',
    )
    if (!htmlAsset || htmlAsset.type !== 'asset' || typeof htmlAsset.source !== 'string') {
      throw new Error('production build did not emit index.html as text')
    }
    const html = htmlAsset.source
    const styleStart = html.indexOf('<style data-dinkster-semantic-tokens')
    const moduleScriptStart = html.indexOf('<script type="module"')
    expect(styleStart).toBeGreaterThanOrEqual(0)
    expect(moduleScriptStart).toBeGreaterThan(styleStart)
    expect(html).toContain(semanticCssRoot)
    for (const [name, value] of Object.entries(semanticCssVariables)) {
      expect(html).toContain(`${name}: ${value};`)
    }
  }, 30_000)
})

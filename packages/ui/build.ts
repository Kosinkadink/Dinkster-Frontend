import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import components from '@dinkster/branding/components' with { type: 'json' }
import { semanticCssRoot } from '@dinkster/core/tokens'

const root = new URL('./', import.meta.url)
const dist = new URL('dist/', root)
await mkdir(dist, { recursive: true })
const declarations = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => `  --dinkster-${key}: ${value};`)
    .join('\n')
const geometry = Object.fromEntries(
  Object.entries(components.layout).map(([key, value]) => [
    key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
    `${value}px`,
  ]),
)
const siteGeometry = Object.fromEntries(
  Object.entries(components.siteLayout).map(([key, value]) => [
    `site-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
    `${value}px`,
  ]),
)
const siteInteraction = Object.fromEntries(
  Object.entries(components.siteInteraction).map(([key, value]) => [
    `site-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
    String(value),
  ]),
)
const siteType = Object.fromEntries(
  Object.entries(components.siteType).flatMap(([name, value]) => [
    [`type-${name}-size`, `${value.fontSize}px`],
    [`type-${name}-line`, `${value.lineHeight}px`],
    [`type-${name}-weight`, String(value.fontWeight)],
  ]),
)
const fonts = await readFile(new URL('../app/src/fonts.css', root), 'utf8')
const classes = (await readFile(new URL('styles.css', root), 'utf8'))
  .replaceAll(
    'DINKSTER_SIDEBAR_BREAKPOINT',
    `${components.layout.sidebarBreakpoint}px`,
  )
  .replaceAll(
    'DINKSTER_TOOLBAR_FULL_ROW_WIDTH',
    `${components.layout.toolbarFullRowWidth}px`,
  )
  .replaceAll(
    'DINKSTER_TOOLBAR_EXPANDED_WIDTH',
    `${components.layout.toolbarExpandedRowWidth}px`,
  )
const css = `${fonts.replaceAll("url('/fonts/", "url('./fonts/")}\n${semanticCssRoot}\n:root {\n${declarations(geometry)}\n}\n[data-density="site"] {\n${declarations(siteType)}\n${declarations(siteGeometry)}\n${declarations(siteInteraction)}\n}\n${classes}`
await writeFile(new URL('dinkster.css', dist), css)
await cp(new URL('../app/public/fonts/', root), new URL('fonts/', dist), {
  recursive: true,
})
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
await cp(
  new URL('../../branding/tokens/design-rules.json', root),
  new URL('design-rules.json', dist),
)
const files = [
  'design-rules.json',
  'dinkster.css',
  'fonts/LICENSE',
  'fonts/NotoSans-Regular.woff2',
  'fonts/NotoSans-Bold.woff2',
  'fonts/NotoSans-Italic.woff2',
  'fonts/NotoSansMono-Regular.woff2',
]
const hashes = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(new URL(file, dist)))
        .digest('hex'),
    ]),
  ),
)
await writeFile(
  new URL('manifest.json', dist),
  `${JSON.stringify({ version: pkg.version, files: hashes }, null, 2)}\n`,
)
console.log(
  `Built @dinkster/ui ${pkg.version}: stylesheet, bundled fonts and SHA-256 manifest`,
)

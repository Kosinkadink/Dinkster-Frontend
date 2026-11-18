import { createHash } from 'node:crypto'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { Manifest } from 'vite'

const dist = new URL('./dist/', import.meta.url)
const styles = (await readdir(new URL('assets/', dist))).filter((file) =>
  file.endsWith('.css'),
)
if (styles.length !== 1)
  throw new Error('Site requires exactly one shared stylesheet')
const manifest: Manifest = JSON.parse(
  await readFile(new URL('.vite/manifest.json', dist), 'utf8'),
)
function modulePreloads(entry: string, prefix = '/site/') {
  const files = new Set<string>()
  function collect(key: string) {
    const chunk = manifest[key]!
    if (files.has(chunk.file)) return
    files.add(chunk.file)
    for (const dependency of chunk.imports ?? []) collect(dependency)
  }
  collect(entry)
  return [...files]
    .map((file) => `<link rel="modulepreload" href="${prefix}${file}">`)
    .join('')
}
await rm(new URL('.vite/', dist), { recursive: true })
const head = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/site/assets/${styles[0]}">`
await writeFile(
  new URL('account.html', dist),
  `${head}${modulePreloads('src/account.tsx')}<title>Account | Dinkster</title><meta name="account-config" content="__ACCOUNT_CONFIG__"></head><body class="dinkster-root" data-density="site" data-theme="dark"><div id="account-root"></div><script type="module" src="/account.js"></script></body></html>\n`,
)
await writeFile(
  new URL('authorization.html', dist),
  `${head}${modulePreloads('src/authorization.tsx')}<title>Authorize application | Dinkster</title><meta name="authorization-config" content="__AUTHORIZATION_CONFIG__"></head><body class="dinkster-root" data-density="site" data-theme="dark"><div id="authorization-root"></div><script type="module" src="/site/authorization.js"></script></body></html>\n`,
)
await writeFile(
  new URL('about.html', dist),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="./assets/${styles[0]}">${modulePreloads('src/about.tsx', './')}<title>Dinkster Desktop</title></head><body class="dinkster-root"><div id="about-root"></div><script type="module" src="./about.js"></script></body></html>\n`,
)
const files: Record<string, string> = {}
async function collect(directory: URL, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`
    const path = new URL(entry.name, directory)
    if (entry.isDirectory())
      await collect(new URL(`${entry.name}/`, directory), `${name}/`)
    else
      files[name] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
  }
}
await collect(dist)
await writeFile(
  new URL('manifest.json', dist),
  `${JSON.stringify({ format: 'dinkster.site/1', files }, null, 2)}\n`,
)

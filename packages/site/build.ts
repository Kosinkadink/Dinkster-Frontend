import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'

const dist = new URL('./dist/', import.meta.url)
const styles = (await readdir(new URL('assets/', dist))).filter((file) =>
  file.endsWith('.css'),
)
if (styles.length !== 1)
  throw new Error('Site requires exactly one shared stylesheet')
const head = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/site/assets/${styles[0]}">`
await writeFile(
  new URL('account.html', dist),
  `${head}<title>Account | Dinkster</title><meta name="account-config" content="__ACCOUNT_CONFIG__"></head><body class="dinkster-root" data-density="site" data-theme="dark"><div id="account-root"></div><script type="module" src="/account.js"></script></body></html>\n`,
)
await writeFile(
  new URL('authorization.html', dist),
  `${head}<title>Authorize application | Dinkster</title><meta name="authorization-config" content="__AUTHORIZATION_CONFIG__"></head><body class="dinkster-root" data-density="site" data-theme="dark"><div id="authorization-root"></div><script type="module" src="/site/authorization.js"></script></body></html>\n`,
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

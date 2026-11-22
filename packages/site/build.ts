import { createHash } from 'node:crypto'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { build, type Manifest } from 'vite'
import solid from 'vite-plugin-solid'
import postcss from 'postcss'
import components from '@dinkster/branding/components' with { type: 'json' }
import { semanticTokensForTheme } from '@dinkster/core/tokens'

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
await writeFile(
  new URL('desktop-library.html', dist),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="./assets/${styles[0]}">${modulePreloads('src/desktop-library.tsx', './')}<title>Projects | Dinkster Desktop</title></head><body class="dinkster-root" data-theme="dark"><div id="desktop-library-root"></div><script type="module" src="./desktop-library.js"></script></body></html>\n`,
)
const { callbackTemplate } = await import(
  new URL('.callback/callback.js', dist).href
)
let embeddedCss = await readFile(
  new URL('../ui/dist/dinkster.css', import.meta.url),
  'utf8',
)
for (const match of embeddedCss.matchAll(/url\('\.\/fonts\/([^']+)'\)/g)) {
  const font = await readFile(
    new URL(`../ui/dist/fonts/${match[1]}`, import.meta.url),
  )
  embeddedCss = embeddedCss.replaceAll(
    match[0],
    `url('data:font/woff2;base64,${font.toString('base64')}')`,
  )
}
const wordmark = await readFile(
  new URL(
    '../../branding/svg/dinkster-wordmark-color-dark.svg',
    import.meta.url,
  ),
)
const callbackMarkup = (callbackTemplate() as string).replace(
  /src="[^"]+"/,
  `src="data:image/svg+xml;base64,${wordmark.toString('base64')}"`,
)
const callbackCsp = `default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'sha256-${createHash('sha256').update(embeddedCss).digest('base64')}'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`
await writeFile(
  new URL('callback.html', dist),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${callbackCsp}"><title>__CALLBACK_HEADING__ | Dinkster</title><style>${embeddedCss}</style></head><body class="dinkster-root" data-density="site" data-theme="dark">${callbackMarkup}</body></html>\n`,
)
await rm(new URL('.callback/', dist), { recursive: true })
await build({
  configFile: false,
  plugins: [solid()],
  build: {
    outDir: dist.pathname,
    emptyOutDir: false,
    lib: {
      entry: new URL('src/desktop-chrome.tsx', import.meta.url).pathname,
      name: 'DinksterDesktopChrome',
      formats: ['iife'],
      fileName: () => 'desktop-chrome.js',
    },
  },
})
const chromeCss = postcss.root()
for (const node of postcss.parse(embeddedCss).nodes) {
  if (node.type === 'atrule' && node.name === 'font-face')
    chromeCss.append(node.clone())
  if (
    node.type === 'atrule' &&
    node.name === 'container' &&
    node.nodes?.some(
      (child) =>
        child.type === 'rule' &&
        child.selector.includes('.dinkster-window-toolbar'),
    )
  )
    chromeCss.append(node.clone())
  if (node.type !== 'rule') continue
  if (node.selector === ':root')
    chromeCss.append(
      node.clone({
        selector: ':is(.dinkster-desktop-bar, [data-desktop-chrome])',
      }),
    )
  else if (node.selector === '[data-theme="light"]')
    chromeCss.append(
      node.clone({
        selector:
          ':is(.dinkster-desktop-bar, [data-desktop-chrome])[data-theme="light"]',
      }),
    )
  else if (
    /\.dinkster-(?:desktop-bar|window-(?:chrome|identity|fallback|toolbar|action))\b/.test(
      node.selector,
    )
  )
    chromeCss.append(node.clone())
  else if (node.selector === '.dinkster-brand-title')
    chromeCss.append(
      node.clone({ selector: '.dinkster-desktop-bar .dinkster-brand-title' }),
    )
}
await writeFile(
  new URL('desktop-chrome.json', dist),
  `${JSON.stringify(
    {
      format: 'dinkster.desktop-chrome/1',
      installer: 'desktop-chrome.js',
      css: chromeCss.toString(),
      native: {
        minimumWidth: {
          linux: components.layout.toolbarMinimumWidthLinux,
          darwin: components.layout.toolbarMinimumWidthMac,
          win32: components.layout.toolbarMinimumWidthWindows,
        },
        overlay: Object.fromEntries(
          (['dark', 'light'] as const).map((theme) => {
            const tokens = semanticTokensForTheme(theme)
            return [
              theme,
              {
                color: tokens.surface.frame,
                symbolColor: tokens.text.primary,
                height: components.layout.topBarHeight,
              },
            ]
          }),
        ),
        trafficLightPosition: {
          x: components.layout.macWindowControlsX,
          y: components.layout.macWindowControlsY,
        },
      },
    },
    null,
    2,
  )}\n`,
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
  `${JSON.stringify(
    {
      format: 'dinkster.site/1',
      files,
      callback: {
        template: 'callback.html',
        csp: callbackCsp,
        textSlots: [
          '__CALLBACK_HEADING__',
          '__CALLBACK_MESSAGE__',
          '__CALLBACK_RETURN_LABEL__',
        ],
        destinationSlot: '__CALLBACK_RETURN_URL__',
      },
    },
    null,
    2,
  )}\n`,
)

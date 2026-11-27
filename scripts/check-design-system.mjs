import { readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import postcss from 'postcss'
import ts from 'typescript'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stylesheet = resolve(repository, 'packages/ui/styles.css')
const primitiveTags = new Map(
  [
    ['controls.tsx', new Set(['button', 'input', 'textarea'])],
    ['select.tsx', new Set(['button', 'input'])],
    ['canvas-field.tsx', new Set(['button', 'input'])],
    ['canvas-list.tsx', new Set(['button', 'input'])],
    ['fixes-notice.tsx', new Set(['button'])],
    ['canvas-save-target.tsx', new Set(['button', 'input'])],
    ['problem-box.tsx', new Set(['button'])],
    ['layout.tsx', new Set(['button'])],
    ['menu.tsx', new Set(['button'])],
    ['messages.tsx', new Set(['dialog'])],
    ['search.tsx', new Set(['button', 'input'])],
  ].map(([file, tags]) => [resolve(repository, 'packages/ui/src', file), tags]),
)
const controls = new Set(['button', 'input', 'textarea', 'select', 'dialog'])
const colorLiteral =
  /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/iu
const colorProperty =
  /^(?:color|background(?:-color)?|(?:border|outline)(?:-(?:top|right|bottom|left|block|inline|start|end|color|width|style))*|fill|stroke|(?:box|text)-shadow|accent-color|caret-color|text-decoration-color)$/u
const memberName = (node) =>
  ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined
const geometry = new Set([
  'left',
  'top',
  'right',
  'bottom',
  'width',
  'height',
  'maxWidth',
  'maxHeight',
  'minWidth',
  'minHeight',
  'scale',
])

export async function checkDesignSystem(args = []) {
  const sources = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--source' || !args[index + 1])
      throw new Error(
        'Usage: check-design-system.mjs [--source <directory>]...',
      )
    sources.push(resolve(args[++index]))
  }
  if (!sources.length)
    sources.push(
      resolve(repository, 'packages/ui/src'),
      resolve(repository, 'packages/ui/gallery'),
      resolve(repository, 'packages/site/src'),
    )

  const problems = []
  const report = (path, line, message) =>
    problems.push(`${relative(repository, path)}:${line}: ${message}`)
  const css = postcss.parse(await readFile(stylesheet, 'utf8'), {
    from: stylesheet,
  })
  const classes = new Set()
  css.walkRules((rule) => {
    for (const match of rule.selector.matchAll(/\.([a-zA-Z_][\w-]*)/gu))
      classes.add(match[1])
  })
  const checkDeclarations = (tree, path) => {
    tree.walkAtRules('import', (rule) =>
      report(
        path,
        rule.source.start.line,
        'Stylesheet imports are outside the shared stylesheet',
      ),
    )
    tree.walkDecls((declaration) => {
      const property = declaration.prop.toLowerCase()
      const value = declaration.value
      const line = declaration.source.start.line
      if (property.startsWith('--'))
        report(
          path,
          line,
          'Define tokens in branding/tokens, not the component stylesheet',
        )
      if (colorLiteral.test(value))
        report(path, line, 'Literal color; use a shared token')
      if (property === 'font-size' || property === 'font') {
        if (
          !/^(?:var\(--dinkster-[\w-]+\)|inherit|initial|unset|revert)$/u.test(
            value,
          )
        )
          report(path, line, 'Literal font size; use a shared type token')
      }
      if (colorProperty.test(property)) {
        // After token references, only color-independent CSS grammar remains.
        const rest = value
          .replace(/var\(--dinkster-[\w-]+\)/gu, '')
          .replace(/[+-]?(?:\d*\.)?\d+(?:px|em|rem|vh|vw|%)?/gu, '')
          .replace(
            /\b(?:transparent|currentcolor|inherit|initial|unset|revert|none|solid|dashed|dotted|double|inset|outset|hidden)\b/giu,
            '',
          )
        if (/[a-z#]/iu.test(rest))
          report(path, line, 'Literal color or fallback; use a shared token')
      }
    })
  }
  checkDeclarations(css, stylesheet)

  async function visitDirectory(directory, shortcutsOnly = false) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visitDirectory(path, shortcutsOnly)
      else if (/\.(?:[cm]?[jt]sx?|css|html|json)$/u.test(entry.name))
        await checkFile(path, shortcutsOnly)
    }
  }

  async function checkFile(path, shortcutsOnly) {
    const text = await readFile(path, 'utf8')
    if (path.endsWith('.json')) {
      // #1383 excludes the old consent dialog; #1345 owns the storage redraw.
      const deferred = new Set([
        'modelConsent.bytes',
        'storageSettings.bytes',
        'storageSettings.cleared',
      ])
      const appCatalog = /^packages\/app\/src\/locales\/(?:en|zh)\.json$/u.test(
        relative(repository, path),
      )
      for (const [key, value] of Object.entries(JSON.parse(text)))
        if (
          typeof value === 'string' &&
          /\{[^{}]+\}\s*(?:bytes\b|\u5b57\u8282)/iu.test(value) &&
          !(appCatalog && deferred.has(key))
        )
          report(
            path,
            1,
            'Byte sizes must use formatByteSize from @dinkster/core',
          )
      return
    }
    if (shortcutsOnly && !/\.[cm]?[jt]sx?$/u.test(path)) return
    if (path.endsWith('.css')) {
      if (path !== stylesheet)
        report(path, 1, 'Styles belong in packages/ui/styles.css')
      checkDeclarations(postcss.parse(text, { from: path }), path)
      return
    }
    if (path.endsWith('.html')) {
      if (/<style\b|\bstyle\s*=/iu.test(text))
        report(path, 1, 'Inline styles are outside the shared stylesheet')
      for (const match of text.matchAll(/\bclass\s*=\s*["']([^"']*)["']/gu))
        checkClasses(match[1], path, 1)
      if (/<(?:button|input|textarea|select|dialog)\b/iu.test(text))
        report(path, 1, 'Raw control; use a shared Product component')
      return
    }
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') || path.endsWith('.jsx')
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS,
    )
    const line = (node) =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const shortcutSource = resolve(repository, 'packages/ui/src/shortcut.tsx')
    const checkRenderedShortcut = (node) => {
      if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) {
        if (/\b(?:Ctrl|Cmd|Alt|Shift|Meta)\+/iu.test(node.text))
          report(path, line(node), 'Shortcut text must use ProductShortcut')
      } else if (ts.isConditionalExpression(node)) {
        checkRenderedShortcut(node.whenTrue)
        checkRenderedShortcut(node.whenFalse)
      } else if (ts.isParenthesizedExpression(node)) {
        checkRenderedShortcut(node.expression)
      } else if (
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.PlusToken,
        ].includes(node.operatorToken.kind)
      ) {
        if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
          checkRenderedShortcut(node.left)
        checkRenderedShortcut(node.right)
      }
    }
    const visitShortcut = (node) => {
      if (path !== resolve(repository, 'packages/core/src/byte-size.ts')) {
        const unit = /^(?:[KMGT]i?B|B)$/u
        const unitTable =
          ts.isArrayLiteralExpression(node) &&
          node.elements.filter(
            (element) =>
              ts.isStringLiteralLike(element) && unit.test(element.text),
          ).length > 1
        const calculatedSize =
          ts.isTemplateExpression(node) &&
          node.templateSpans.some(
            (span) =>
              /^\s*(?:[KMGT]i?B|B)\b/u.test(span.literal.text) ||
              (path.endsWith('.tsx') && /^\s*bytes\b/u.test(span.literal.text)),
          )
        const concatenatedSize =
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
          ts.isStringLiteralLike(node.right) &&
          /^(?:[KMGT]i?B|B|bytes)$/u.test(node.right.text.trim())
        const renderedBytes =
          ts.isJsxText(node) &&
          /^\s*bytes\b/u.test(node.text) &&
          node.parent.children.some(
            (child, index, children) =>
              child === node &&
              index > 0 &&
              ts.isJsxExpression(children[index - 1]),
          )
        const localizedBytes =
          ts.isStringLiteralLike(node) &&
          /\{[^{}]+\}\s*bytes\b/iu.test(node.text)
        const localFormatter =
          (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
          node.name &&
          /^(?:formatByteSize|formatBytes|formatScanBytes|formatSize)$/u.test(
            node.name.getText(source),
          ) &&
          (ts.isFunctionDeclaration(node) ||
            (node.initializer &&
              (ts.isArrowFunction(node.initializer) ||
                ts.isFunctionExpression(node.initializer))))
        if (
          unitTable ||
          calculatedSize ||
          concatenatedSize ||
          localFormatter ||
          renderedBytes ||
          localizedBytes
        )
          report(
            path,
            line(node),
            'Byte sizes must use formatByteSize from @dinkster/core',
          )
      }
      if (path !== shortcutSource) {
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          node.tagName.getText(source) === 'kbd'
        )
          report(path, line(node), 'Shortcut keys must use ProductShortcut')
        if (
          ts.isStringLiteralLike(node) &&
          /\bdinkster-(?:key|window-action-shortcut)\b/u.test(node.text)
        )
          report(path, line(node), 'Shortcut chips belong to ProductShortcut')
        if (ts.isJsxText(node)) checkRenderedShortcut(node)
        else if (
          ts.isJsxExpression(node) &&
          (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
          node.expression
        )
          checkRenderedShortcut(node.expression)
      }
      ts.forEachChild(node, visitShortcut)
    }
    visitShortcut(source)
    if (shortcutsOnly) return
    const classExpression = (node) => {
      if (ts.isStringLiteralLike(node))
        checkClasses(node.text, path, line(node))
      else if (ts.isJsxExpression(node) && node.expression)
        classExpression(node.expression)
      else if (ts.isConditionalExpression(node)) {
        classExpression(node.whenTrue)
        classExpression(node.whenFalse)
      } else if (
        node.kind !== ts.SyntaxKind.FalseKeyword &&
        node.kind !== ts.SyntaxKind.NullKeyword
      )
        report(
          path,
          line(node),
          'Class names must be statically declared in the shared stylesheet',
        )
    }
    const checkStylesheetImport = (specifier, node) => {
      if (
        /\.(?:css|scss|sass|less)(?:[?#]|$)/iu.test(specifier) &&
        specifier !== '@dinkster/ui/styles.css' &&
        resolve(dirname(path), specifier) !==
          resolve(repository, 'packages/ui/dist/dinkster.css')
      )
        report(
          path,
          line(node),
          'Stylesheet imports must use @dinkster/ui/styles.css',
        )
    }
    const visit = (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        checkStylesheetImport(node.moduleSpecifier.text, node)
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source)
        if (tag === 'style')
          report(
            path,
            line(node),
            'Embedded styles are outside the shared stylesheet',
          )
        if (
          tag === 'link' &&
          node.attributes.properties.some(
            (attribute) =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.text === 'rel' &&
              attribute.initializer?.getText(source).includes('stylesheet'),
          )
        )
          report(
            path,
            line(node),
            'Use the shared stylesheet import instead of a stylesheet link',
          )
        if (controls.has(tag) && !primitiveTags.get(path)?.has(tag))
          report(path, line(node), `Raw ${tag}; use a shared Product component`)
        if (
          /^[a-z]/u.test(tag) &&
          !primitiveTags.has(path) &&
          node.attributes.properties.some(ts.isJsxSpreadAttribute)
        )
          report(
            path,
            line(node),
            'Native element spreads can bypass shared styles; pass attributes explicitly',
          )
      }
      if (ts.isJsxAttribute(node)) {
        if (node.name.text === 'style')
          report(
            path,
            line(node),
            'Inline styles are outside the shared stylesheet',
          )
        if (node.name.text === 'class' || node.name.text === 'className') {
          if (node.initializer) classExpression(node.initializer)
        }
        if (node.name.text === 'classList')
          report(
            path,
            line(node),
            'Use static shared classes and semantic data attributes',
          )
      }
      if (memberName(node) === 'classList')
        report(
          path,
          line(node),
          'Use static shared classes and semantic data attributes',
        )
      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        memberName(node.expression) === 'style'
      ) {
        const name = memberName(node)
        if (!geometry.has(name))
          report(
            path,
            line(node),
            'Only measured geometry may use imperative inline styles',
          )
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        if (memberName(node.left) === 'className') classExpression(node.right)
        if (memberName(node.left) === 'style')
          report(
            path,
            line(node),
            'Inline styles are outside the shared stylesheet',
          )
      }
      if (ts.isCallExpression(node)) {
        const method = memberName(node.expression)
        const [first, second] = node.arguments
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          first &&
          ts.isStringLiteralLike(first)
        )
          checkStylesheetImport(first.text, node)
        if (
          method === 'createElement' &&
          first &&
          ts.isStringLiteralLike(first) &&
          controls.has(first.text)
        )
          report(
            path,
            line(node),
            `Raw ${first.text}; use a shared Product component`,
          )
        if (
          method === 'setAttribute' &&
          first &&
          ts.isStringLiteralLike(first)
        ) {
          if (first.text === 'style')
            report(
              path,
              line(node),
              'Inline styles are outside the shared stylesheet',
            )
          if (first.text === 'class' && second) classExpression(second)
        }
      }
      if (ts.isStringLiteralLike(node) && colorLiteral.test(node.text))
        report(path, line(node), 'Literal color; use a shared token')
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  function checkClasses(value, path, line) {
    for (const name of value.split(/\s+/u).filter(Boolean))
      if (!classes.has(name))
        report(path, line, `Class ${name} is not in the shared stylesheet`)
  }
  for (const directory of sources) await visitDirectory(directory)
  if (!args.length)
    for (const name of ['app', 'canvas', 'client', 'core', 'widgets'])
      await visitDirectory(resolve(repository, `packages/${name}/src`), true)
  if (problems.length) throw new Error(problems.join('\n'))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await checkDesignSystem(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

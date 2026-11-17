import { readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import postcss from 'postcss'
import ts from 'typescript'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stylesheet = resolve(repository, 'packages/ui/styles.css')
const primitiveTags = new Map(
  [
    ['controls.tsx', new Set(['button', 'input', 'textarea', 'select'])],
    ['layout.tsx', new Set(['button'])],
    ['menu.tsx', new Set(['button'])],
    ['messages.tsx', new Set(['dialog'])],
  ].map(([file, tags]) => [resolve(repository, 'packages/ui/src', file), tags]),
)
const controls = new Set(['button', 'input', 'textarea', 'select', 'dialog'])
const colorLiteral =
  /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/iu
const colorProperty =
  /^(?:color|background(?:-color)?|(?:border|outline)(?:-(?:top|right|bottom|left|block|inline|start|end|color|width|style))*|fill|stroke|(?:box|text)-shadow|accent-color|caret-color|text-decoration-color)$/u
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
  const checkDeclarations = (tree, path) =>
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
  checkDeclarations(css, stylesheet)

  async function visitDirectory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visitDirectory(path)
      else if (/\.(?:[cm]?[jt]sx?|css|html)$/u.test(entry.name))
        await checkFile(path)
    }
  }

  async function checkFile(path) {
    const text = await readFile(path, 'utf8')
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
      ts.ScriptKind.TSX,
    )
    const line = (node) =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
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
    const visit = (node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        controls.has(node.tagName.getText(source))
      ) {
        const tag = node.tagName.getText(source)
        if (!primitiveTags.get(path)?.has(tag))
          report(path, line(node), `Raw ${tag}; use a shared Product component`)
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
      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'style'
      ) {
        const name = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : ts.isStringLiteralLike(node.argumentExpression)
            ? node.argumentExpression.text
            : undefined
        if (!geometry.has(name))
          report(
            path,
            line(node),
            'Only measured geometry may use imperative inline styles',
          )
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left)
      ) {
        if (node.left.name.text === 'className') classExpression(node.right)
        if (node.left.name.text === 'style')
          report(
            path,
            line(node),
            'Inline styles are outside the shared stylesheet',
          )
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text
        const [first, second] = node.arguments
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

import { readdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tokenFile = resolve(repository, 'packages/canvas/src/tokens.ts')
const geometry =
  /(?:width|height|size|radius|inset|padding|gap|stroke|offset|margin|spacing|overhang|clearance|opacity|alpha|dash|fontWeight|scaleFloor)/iu
const colorLiteral =
  /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/iu
const paintProperties = new Map([
  ['fillStyle', 'color'],
  ['strokeStyle', 'color'],
  ['shadowColor', 'color'],
  ['lineWidth', 'size'],
  ['shadowBlur', 'size'],
  ['shadowOffsetX', 'size'],
  ['shadowOffsetY', 'size'],
  ['lineDashOffset', 'size'],
  ['globalAlpha', 'opacity'],
  ['font', 'font'],
])
const callArguments = new Map([
  ['arc', [0, 1, 2]],
  ['arcTo', [0, 1, 2, 3, 4]],
  ['ellipse', [0, 1, 2, 3]],
  ['rect', [0, 1, 2, 3]],
  ['roundRect', [0, 1, 2, 3, 4]],
  ['fillRect', [0, 1, 2, 3]],
  ['strokeRect', [0, 1, 2, 3]],
  ['moveTo', [0, 1]],
  ['lineTo', [0, 1]],
  ['bezierCurveTo', [0, 1, 2, 3, 4, 5]],
  ['quadraticCurveTo', [0, 1, 2, 3]],
  ['fillText', [1, 2, 3]],
  ['strokeText', [1, 2, 3]],
])

export async function checkCanvasLiterals(args = []) {
  const roots = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--source' || !args[index + 1])
      throw new Error(
        'Usage: check-canvas-literals.mjs [--source <directory>]...',
      )
    roots.push(resolve(args[++index]))
  }
  if (!roots.length)
    roots.push(
      resolve(repository, 'packages/canvas/src'),
      ...[
        'CanvasHost.tsx',
        'palette-node-preview.ts',
        'AppWidgetPreview.tsx',
        'minimap.ts',
      ].map((file) => resolve(repository, 'packages/app/src', file)),
    )
  const files = []
  async function collect(path) {
    if (/\.[cm]?[jt]sx?$/u.test(path)) files.push(path)
    else
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
        if (entry.isDirectory() || /\.[cm]?[jt]sx?$/u.test(entry.name))
          await collect(resolve(path, entry.name))
      }
  }
  for (const root of roots) await collect(root)
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
  })
  const checker = program.getTypeChecker()
  const declarationsOf = (node) => {
    let symbol = checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(node) ? node.name : node,
    )
    if (!symbol && ts.isElementAccessExpression(node)) {
      const name = staticText(node.argumentExpression)
      if (name !== undefined)
        symbol = checker.getTypeAtLocation(node.expression).getProperty(name)
    }
    const shorthand = symbol?.declarations?.find(
      ts.isShorthandPropertyAssignment,
    )
    if (shorthand)
      symbol = checker.getShorthandAssignmentValueSymbol(shorthand) ?? symbol
    if (symbol?.flags & ts.SymbolFlags.Alias)
      symbol = checker.getAliasedSymbol(symbol)
    return symbol?.declarations ?? []
  }
  const returnExpressions = (node) => {
    if (!node.body) return []
    if (!ts.isBlock(node.body)) return [node.body]
    const expressions = []
    const visit = (child) => {
      if (ts.isReturnStatement(child) && child.expression)
        expressions.push(child.expression)
      else if (!ts.isFunctionLike(child)) ts.forEachChild(child, visit)
    }
    visit(node.body)
    return expressions
  }
  const bindingValues = (binding, seen = new Set()) => {
    if (seen.has(binding)) return []
    seen.add(binding)
    const pattern = binding.parent
    const owner = pattern.parent
    const sources = ts.isBindingElement(owner)
      ? bindingValues(owner, seen)
      : owner.initializer
        ? [owner.initializer]
        : []
    const index = pattern.elements.indexOf(binding)
    const key = ts.isArrayBindingPattern(pattern)
      ? String(index)
      : binding.propertyName
        ? ts.isComputedPropertyName(binding.propertyName)
          ? staticText(binding.propertyName.expression)
          : binding.propertyName.text
        : binding.name.text
    const select = (source, visited = new Set()) => {
      if (!source || visited.has(source)) return []
      visited.add(source)
      if (
        ts.isParenthesizedExpression(source) ||
        ts.isAsExpression(source) ||
        ts.isNonNullExpression(source) ||
        ts.isSatisfiesExpression(source)
      )
        return select(source.expression, visited)
      if (ts.isConditionalExpression(source))
        return [source.whenTrue, source.whenFalse].flatMap((branch) =>
          select(branch, new Set(visited)),
        )
      if (ts.isCallExpression(source)) {
        const returned = declarationsOf(source.expression).flatMap(
          (declaration) =>
            returnExpressions(declaration.initializer ?? declaration),
        )
        return returned.length
          ? returned.flatMap((value) => select(value, new Set(visited)))
          : [source]
      }
      if (ts.isArrayLiteralExpression(source)) {
        // A preceding spread makes the selected runtime index uncertain.
        if (
          source.elements
            .slice(0, index + (binding.dotDotDotToken ? 0 : 1))
            .some(ts.isSpreadElement)
        )
          return [...source.elements]
        return binding.dotDotDotToken
          ? source.elements.slice(index)
          : source.elements[index] &&
              !ts.isOmittedExpression(source.elements[index])
            ? [source.elements[index]]
            : []
      }
      if (source.getSourceFile().fileName === tokenFile) return []
      if (binding.dotDotDotToken) return [source]
      if (key === undefined) return [source]
      const property = checker.getTypeAtLocation(source).getProperty(key)
      if (property)
        return (property.declarations ?? []).flatMap((declaration) =>
          ts.isShorthandPropertyAssignment(declaration)
            ? [declaration.name]
            : declaration.initializer
              ? [declaration.initializer]
              : ts.isFunctionLike(declaration)
                ? returnExpressions(declaration)
                : [],
        )
      return declarationsOf(source).flatMap((declaration) =>
        declaration.initializer
          ? select(declaration.initializer, visited)
          : ts.isBindingElement(declaration)
            ? bindingValues(declaration, seen).flatMap((value) =>
                select(value, visited),
              )
            : [],
      )
    }
    return [
      ...sources.flatMap((source) => select(source)),
      ...(binding.initializer ? [binding.initializer] : []),
    ]
  }
  const staticText = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return undefined
    seen.add(node)
    if (ts.isStringLiteralLike(node)) return node.text
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return staticText(node.expression, seen)
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text
      for (const span of node.templateSpans) {
        const value = staticText(span.expression, new Set(seen))
        if (value === undefined) return undefined
        text += value + span.literal.text
      }
      return text
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = staticText(node.left, new Set(seen))
      const right = staticText(node.right, new Set(seen))
      return left !== undefined && right !== undefined
        ? left + right
        : undefined
    }
    if (ts.isIdentifier(node)) {
      for (const declaration of declarationsOf(node)) {
        const values = ts.isBindingElement(declaration)
          ? bindingValues(declaration)
          : declaration.initializer
            ? [declaration.initializer]
            : []
        for (const value of values) {
          const text = staticText(value, new Set(seen))
          if (text !== undefined) return text
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const values = declarationsOf(node.expression)
        .flatMap((declaration) =>
          returnExpressions(declaration.initializer ?? declaration),
        )
        .map((expression) => staticText(expression, new Set(seen)))
      if (
        values.length &&
        values[0] !== undefined &&
        values.every((value) => value === values[0])
      )
        return values[0]
    }
    const type = checker.getTypeAtLocation(node)
    return type.isStringLiteral() ? type.value : undefined
  }
  const memberName = (node) =>
    ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node)
        ? staticText(node.argumentExpression)
        : undefined
  const problems = new Set()
  const report = (node, kind) => {
    const source = node.getSourceFile()
    const { line, character } = source.getLineAndCharacterOfPosition(
      node.getStart(),
    )
    problems.add(
      `${relative(repository, source.fileName)}:${line + 1}:${character + 1}: Literal canvas ${kind}; use packages/canvas/src/tokens.ts`,
    )
  }
  const inspect = (node, kind, seen = new Set()) => {
    if (!node || node.getSourceFile().fileName === tokenFile || seen.has(node))
      return
    seen.add(node)
    if (ts.isNumericLiteral(node)) {
      // Color conversions use numeric indices and radices, not CSS colors.
      if (kind === 'color') return
      // Zero is a coordinate origin/empty extent, not a designed dimension.
      if (kind !== 'size' || Number(node.text) !== 0) report(node, kind)
      return
    }
    if (ts.isStringLiteralLike(node)) {
      if (
        kind === 'color' ||
        (kind === 'font' &&
          /\d+(?:\.\d+)?(?:px|pt|em|rem)\b|^\s*[1-9]\d{2}\s/u.test(node.text))
      )
        report(node, kind)
      return
    }
    if (ts.isConditionalExpression(node)) {
      for (const branch of [node.whenTrue, node.whenFalse]) {
        if (ts.isNumericLiteral(branch) && branch.text === '1') continue
        inspect(branch, kind, seen)
      }
      return
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      // Halves, diameters and unit increments describe coordinate/count math.
      if (ts.isNumericLiteral(node.left) && ts.isNumericLiteral(node.right)) {
        inspect(node.left, kind, seen)
        inspect(node.right, kind, seen)
        return
      }
      const arithmetic = [
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
      ].includes(operator)
      for (const operand of [node.left, node.right]) {
        if (
          operator === ts.SyntaxKind.QuestionQuestionToken &&
          operand === node.right &&
          ts.isNumericLiteral(operand) &&
          operand.text === '1'
        )
          continue
        if (
          kind === 'opacity' &&
          arithmetic &&
          ts.isNumericLiteral(operand) &&
          [1, 2].includes(Number(operand.text))
        )
          continue
        if (
          kind === 'size' &&
          arithmetic &&
          ts.isNumericLiteral(operand) &&
          [0, 1, 2, 0.5].includes(Number(operand.text))
        )
          continue
        inspect(operand, kind, seen)
      }
      return
    }
    if (
      ts.isIdentifier(node) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const declarations = declarationsOf(node)
      for (const declaration of declarations) {
        if (ts.isBindingElement(declaration)) {
          for (const value of bindingValues(declaration))
            inspect(value, kind, seen)
        } else if (declaration.initializer)
          inspect(declaration.initializer, kind, seen)
        else if (ts.isFunctionLike(declaration))
          inspect(declaration, kind, seen)
      }
      if (!declarations.length && ts.isElementAccessExpression(node))
        inspect(node.expression, kind, seen)
      return
    }
    if (ts.isFunctionLike(node)) {
      for (const expression of returnExpressions(node))
        inspect(expression, kind, seen)
      return
    }
    if (ts.isCallExpression(node)) {
      const method = memberName(node.expression)
      if (
        ['at', 'slice', 'substring', 'toString', 'padStart'].includes(method)
      ) {
        inspect(node.expression.expression, kind, seen)
        return
      }
      inspect(node.expression, kind, seen)
      for (const argument of node.arguments) {
        if (
          ['max', 'min'].includes(method) &&
          ts.isNumericLiteral(argument) &&
          argument.text === '1'
        )
          continue
        inspect(argument, ['sin', 'cos'].includes(method) ? 'size' : kind, seen)
      }
      return
    }
    if (ts.isTemplateExpression(node)) {
      if (
        kind === 'color' &&
        [
          node.head.text,
          ...node.templateSpans.map((span) => span.literal.text),
        ].some((text) => colorLiteral.test(text))
      )
        report(node, kind)
      if (
        kind === 'font' &&
        [
          node.head.text,
          ...node.templateSpans.map((span) => span.literal.text),
        ].some((text) =>
          /\d+(?:\.\d+)?(?:px|pt|em|rem)\b|^\s*[1-9]\d{2}\s/u.test(text),
        )
      )
        report(node, kind)
      for (const span of node.templateSpans)
        inspect(span.expression, kind, seen)
      return
    }
    ts.forEachChild(node, (child) => inspect(child, kind, seen))
  }
  for (const file of files) {
    if (file === tokenFile) continue
    const source = program.getSourceFile(file)
    const geometrySource =
      args.length > 0 ||
      file.startsWith(resolve(repository, 'packages/canvas/src') + '/')
    const visit = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const name = memberName(node.left)
        const kind = paintProperties.get(name)
        if (kind) {
          // Canvas painters restore the context to fully opaque after dimming.
          if (
            !(
              name === 'globalAlpha' &&
              ts.isNumericLiteral(node.right) &&
              node.right.text === '1'
            )
          )
            inspect(node.right, kind)
        }
      }
      if (ts.isCallExpression(node)) {
        const name = memberName(node.expression)
        if (name === 'setLineDash') inspect(node.arguments[0], 'dash')
        else
          for (const index of callArguments.get(name) ?? [])
            inspect(node.arguments[index], 'size')
      }
      if (ts.isPropertyAssignment(node)) {
        const name = ts.isComputedPropertyName(node.name)
          ? staticText(node.name.expression)
          : node.name.getText(source).replace(/^['"]|['"]$/gu, '')
        const kind =
          paintProperties.get(name) ??
          (name === 'color' && geometrySource ? 'color' : undefined)
        if (kind) inspect(node.initializer, kind)
      }
      if (
        geometrySource &&
        (ts.isVariableDeclaration(node) ||
          ts.isPropertyAssignment(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isParameter(node) ||
          ts.isBindingElement(node)) &&
        !ts.isArrayBindingPattern(node.name) &&
        !ts.isObjectBindingPattern(node.name)
      ) {
        const name = node.name.getText(source)
        if (geometry.test(name))
          for (const value of ts.isBindingElement(node)
            ? bindingValues(node)
            : node.initializer
              ? [node.initializer]
              : [])
            inspect(
              value,
              /opacity|alpha/iu.test(name)
                ? 'opacity'
                : /dash/iu.test(name)
                  ? 'dash'
                  : 'size',
            )
      }
      if (ts.isStringLiteralLike(node) && colorLiteral.test(node.text)) {
        // This measures a displayed hex value, not a paint color.
        const parent = node.parent
        if (
          !(
            ts.isCallExpression(parent) &&
            ts.isIdentifier(parent.expression) &&
            parent.expression.text === 'measureWidth' &&
            parent.arguments[1] === node
          )
        )
          report(node, 'color')
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  if (problems.size) throw new Error([...problems].sort().join('\n'))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await checkCanvasLiterals(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

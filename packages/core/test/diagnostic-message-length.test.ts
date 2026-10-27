import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import ts from 'typescript'

const root = join(import.meta.dirname, '../../..')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.tsx?$/.test(path)
        ? [path]
        : []
  })
}

it('keeps authored diagnostic message templates within 120 characters', () => {
  const paths = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(root, 'packages', entry.name, 'src')),
    )
    .flatMap((entry) => sourceFiles(join(root, 'packages', entry.name, 'src')))
  const program = ts.createProgram(paths, {
    noLib: true,
    noResolve: true,
    jsx: ts.JsxEmit.Preserve,
  })
  const checker = program.getTypeChecker()
  const violations: string[] = []

  // Bound authored prose, not arbitrary server errors or user-assigned names.
  // Interpolation source counts conservatively; conditional branches count separately.
  function templates(node: ts.Expression, seen = new Set<ts.Node>()): string[] {
    if (seen.has(node)) return []
    seen = new Set(seen).add(node)
    if (ts.isStringLiteralLike(node)) return [node.text]
    if (ts.isTemplateExpression(node)) return [node.getText().slice(1, -1)]
    if (ts.isConditionalExpression(node))
      return [
        ...templates(node.whenTrue, seen),
        ...templates(node.whenFalse, seen),
      ]
    if (ts.isParenthesizedExpression(node))
      return templates(node.expression, seen)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = templates(node.left, seen)
      const right = templates(node.right, seen)
      return (left.length ? left : ['']).flatMap((a) =>
        (right.length ? right : ['']).map((b) => a + b),
      )
    }
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer
      )
        return templates(declaration.initializer, seen)
    }
    if (ts.isCallExpression(node))
      return node.arguments.flatMap((arg) => templates(arg, seen))
    return []
  }

  for (const path of paths) {
    const source = program.getSourceFile(path)!
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'diag'
      ) {
        const declaration = checker.getSymbolAtLocation(
          node.expression,
        )?.valueDeclaration
        const signature =
          declaration && ts.isVariableDeclaration(declaration)
            ? declaration.initializer
            : declaration
        const parameters =
          signature &&
          (ts.isFunctionDeclaration(signature) || ts.isArrowFunction(signature))
            ? signature.parameters
            : []
        const messageIndex = parameters.findIndex(
          (parameter) => parameter.name.getText() === 'message',
        )
        const message = node.arguments[messageIndex < 0 ? 3 : messageIndex]
        if (message)
          for (const text of templates(message)) {
            if (text.length <= 120 && !/[\r\n]/.test(text)) continue
            const line =
              source.getLineAndCharacterOfPosition(message.getStart()).line + 1
            violations.push(
              `${relative(root, path)}:${line} (${text.length}): ${text}`,
            )
          }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(violations).toEqual([])
})

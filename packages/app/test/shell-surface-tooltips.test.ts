import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')

describe('shell and surface product tooltip markup', () => {
  it('rejects native title attributes on backend-panel HTML elements', () => {
    const parsed = ts.createSourceFile('BackendsPanel.tsx', source('BackendsPanel.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const nativeTitles: string[] = []
    const visit = (node: ts.Node): void => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /^[a-z]/.test(node.tagName.getText(parsed))) {
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && attribute.name.getText(parsed) === 'title') nativeTitles.push(node.getText(parsed))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    expect(nativeTitles).toEqual([])
  })
})

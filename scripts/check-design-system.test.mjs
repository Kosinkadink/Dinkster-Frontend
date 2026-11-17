import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const checker = fileURLToPath(
  new URL('./check-design-system.mjs', import.meta.url),
)

test('design check accepts shared classes and geometry but rejects screen-local controls and styling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dinkster-design-check-'))
  const source = join(directory, 'screen.tsx')
  const run = () =>
    spawnSync(process.execPath, [checker, '--source', directory], {
      encoding: 'utf8',
    })
  try {
    await writeFile(
      source,
      `
      // Raw-looking text in comments is not a control: <button />.
      const route = '#account'
      const view = <section class={invalid ? 'dinkster-field-error' : 'dinkster-description'}><ProductButton>Save</ProductButton></section>
      menu.style.left = anchor.left + 'px'
    `,
    )
    const accepted = run()
    assert.equal(accepted.status, 0, accepted.stderr)
    for (const [text, expected] of [
      ['const view = <button>Save</button>', 'Raw button'],
      ['const view = <input />', 'Raw input'],
      ['const view = <select />', 'Raw select'],
      ['const view = <textarea />', 'Raw textarea'],
      ['const view = <dialog />', 'Raw dialog'],
      ['const color = "#F2F4F5"', 'Literal color'],
      ['const color = "oklch(0.8 0.1 120)"', 'Literal color'],
      ['const view = <div style={{ "font-size": "19px" }} />', 'Inline styles'],
      ['const view = <div class="private-card" />', 'Class private-card'],
      [
        'const view = <div class={callerClass} />',
        'Class names must be statically',
      ],
      ['element.style.color = "red"', 'Only measured geometry'],
      ['element.style["fontSize"] = "18px"', 'Only measured geometry'],
      ['element.style.setProperty("color", "red")', 'Only measured geometry'],
      ['document.createElement("button")', 'Raw button'],
      ['element["style"]["color"] = "red"', 'Only measured geometry'],
      ['element["className"] = "private-card"', 'Class private-card'],
      ['import "../outside.css"', 'Stylesheet imports must use'],
      ['import("../outside.css")', 'Stylesheet imports must use'],
      ['const v=<style>{".private {color:red}"}</style>', 'Embedded styles'],
      [
        'const v=<link rel="stylesheet" href="../outside.css"/>',
        'stylesheet link',
      ],
      [
        'const attrs={style:{color:"red"}};const v=<section {...attrs}/>',
        'Native element spreads',
      ],
      ['element.className = "private-card"', 'Class private-card'],
      ...[
        'node.classList.add("private-card")',
        'node.classList.toggle("private-card", true)',
        'node["classList"]["add"]("private-card")',
        'const classes = node.classList; classes.add("private-card")',
      ].map((mutation) => [
        `const node = document.createElement('div'); ${mutation}`,
        'Use static shared classes',
      ]),
      ['element.setAttribute("class", "private-card")', 'Class private-card'],
      ['element.setAttribute("style", "color: red")', 'Inline styles'],
    ]) {
      await writeFile(source, text)
      const rejected = run()
      assert.equal(rejected.status, 1, text)
      assert.match(rejected.stderr, new RegExp(expected), text)
    }
    await writeFile(source, 'const view = <section class="dinkster-stack" />')
    await writeFile(
      join(directory, 'screen.css'),
      '.private { color: red; font-size: 17px }',
    )
    const css = run()
    assert.equal(css.status, 1, css.stderr)
    assert.match(css.stderr, /Styles belong in packages\/ui\/styles.css/u)
    assert.match(css.stderr, /Literal color/u)
    assert.match(css.stderr, /Literal font size/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

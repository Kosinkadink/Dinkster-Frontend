import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  registerCoreWidgets,
  type WidgetRegistrationDoors,
} from '@dinkster/widgets'
import { AppState } from '../src/app-state.js'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string =>
  readFileSync(join(appRoot, path), 'utf8')
const sourceTree = (path: string): string =>
  readdirSync(join(appRoot, path), { withFileTypes: true })
    .flatMap((entry) => {
      const child = join(path, entry.name)
      if (entry.isDirectory()) return sourceTree(child)
      return /\.tsx?$/u.test(entry.name) ? source(child) : []
    })
    .join('\n')

describe('core extension door dogfooding', () => {
  it('registers every built-in widget kind through the widgetKind door', () => {
    const kinds: string[] = []
    const doors: WidgetRegistrationDoors = {
      widgetKind: (id, kind) => {
        expect(id).toBe(kind.type)
        kinds.push(id)
      },
      widgetView: (id, view) => expect(id).toBe(view.id),
      previewRenderer: (id, renderer) => expect(id).toBe(renderer.id),
    }

    registerCoreWidgets(doors)

    expect(kinds).toEqual([
      'INT',
      'FLOAT',
      'STRING',
      'BOOLEAN',
      'COMBO',
      'MULTI_COMBO',
      'COLOR',
      'CURVE',
      'COMPOSITOR',
      'ASSET',
      'SAVE_TARGET',
      'VIDEO_EDIT',
    ])
  })

  it('keeps built-in command writes behind frontendDoors.command', () => {
    const appState = source('src/app-state.ts')
    const appSource = sourceTree('src')
    expect(appSource.match(/\.commands\.register\(/gu)).toEqual([
      '.commands.register(',
    ])
    expect(appState).toContain(
      'this.commands.register(descriptorWithId(id, command))',
    )
    expect(
      appSource.match(/(?:this|app)\.frontendDoors\.command\(/gu)?.length,
    ).toBeGreaterThan(10)
  })

  it('preserves live command properties through the public command door', () => {
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'http:', host: 'test' },
      configurable: true,
    })
    try {
      const app = new AppState()
      let label = 'First label'
      const unregister = app.frontendDoors.command('test.live-label', {
        get label() {
          return label
        },
        run: () => {},
      })

      expect(app.commands.get('test.live-label')?.label).toBe('First label')
      label = 'Second label'
      expect(app.commands.get('test.live-label')?.label).toBe('Second label')
      unregister()
      expect(app.commands.get('test.live-label')).toBeUndefined()
    } finally {
      Reflect.deleteProperty(globalThis, 'location')
    }
  })

  it('registers all five built-in editors through frontendDoors.editor', () => {
    const app = source('src/App.tsx')
    const appSource = sourceTree('src')
    expect(app).not.toContain('app.editors.register(')
    expect(app.match(/app\.frontendDoors\.editor\(/gu)).toHaveLength(5)
    expect(appSource.match(/\.editors\.register\(/gu)).toEqual([
      '.editors.register(',
      '.editors.register(',
    ])
  })
})

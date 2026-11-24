import { For } from 'solid-js'
import type { MenuItem, ResolvedMenuGroup } from '@dinkster/core'
import { ContextMenu } from '../../app/src/ContextMenu.js'

const action = { kind: 'host', action: 'gallery' } as const
const item = (id: string, label: string, more: Partial<MenuItem> = {}): MenuItem =>
  ({ id, label, action, ...more }) as MenuItem
const submenu = (id: string, label: string, icon?: string): MenuItem =>
  ({ id, label, ...(icon ? { icon } : {}), children: [item(`${id}.child`, 'Child')] }) as MenuItem

interface MenuExample {
  readonly id: string
  readonly caption: string
  readonly groups: readonly ResolvedMenuGroup[]
}

/** Menus shaped like the canvas right-click menus, one for each column layout. */
const examples: readonly MenuExample[] = [
  {
    id: 'icons',
    caption: 'Every item has an icon: the icons, then the labels, start 12 px in.',
    groups: [
      { group: 'a', items: [submenu('mode', 'Mode', 'sliders-horizontal'), submenu('color', 'Color', 'palette')] },
      { group: 'b', items: [item('copy', 'Copy', { icon: 'copy', shortcut: 'ctrl+c' }), item('delete', 'Delete', { icon: 'trash-2', shortcut: 'delete' })] },
      { group: 'c', items: [item('flatten', 'Flatten subgraph one level', { icon: 'ungroup', shortcut: 'ctrl+shift+f', disabled: true })] },
    ],
  },
  {
    id: 'no-icons',
    caption: 'No item has an icon: the labels start 12 px in, with no empty column.',
    groups: [
      { group: 'a', items: [item('add-node', 'Add node...'), item('add-group', 'Add group'), item('add-value-source', 'Add value source')] },
      { group: 'b', items: [item('paste', 'Paste', { shortcut: 'ctrl+v' }), item('empty-subgraph', 'Create empty subgraph')] },
    ],
  },
  {
    id: 'mixed',
    caption: 'Some items have an icon: every label starts in one column after the icons.',
    groups: [
      { group: 'a', items: [item('up-to', 'Execute up to selection', { disabled: true })] },
      { group: 'b', items: [submenu('mode', 'Mode', 'sliders-horizontal')] },
      { group: 'c', items: [item('group-node', 'Group node'), item('minimize', 'Minimize', { shortcut: 'alt+c' }), item('rename', 'Rename...'), submenu('color', 'Color', 'palette')] },
      { group: 'd', items: [item('copy', 'Copy', { icon: 'copy' }), item('delete', 'Delete', { icon: 'trash-2', shortcut: 'delete' })] },
    ],
  },
  {
    id: 'checkable',
    caption: 'Items that can be checked: a check column comes first, marked on the chosen item.',
    groups: [
      {
        group: 'a',
        items: [
          item('inherit', 'Inherit', { checked: true }),
          item('off', 'Off', { checked: false }),
          item('cheap', 'Cheap', { checked: false }),
          item('quality', 'Quality', { checked: false }),
          item('auto', 'Auto', { checked: false }),
        ],
      },
    ],
  },
]

/** The app's own context menu, open, in each column layout. */
export function ContextMenuGallery() {
  return (
    <div class="dinkster-canvas-examples">
      <For each={examples}>
        {(example) => (
          <figure class="dinkster-canvas-example" data-testid={`context-menu-example-${example.id}`}>
            <div class="dinkster-canvas-example-stage dinkster-context-menu-stage">
              <ContextMenu
                menu={{ x: 12, y: 12, worldX: 0, worldY: 0, groups: example.groups }}
                onInvoke={() => {}}
                onClose={() => {}}
              />
            </div>
            <figcaption class="dinkster-metadata">{example.caption}</figcaption>
          </figure>
        )}
      </For>
    </div>
  )
}

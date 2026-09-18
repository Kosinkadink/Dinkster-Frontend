# Node minimization

Minimization hides a node's editing rows without changing its graph behavior.
It is persisted as node view state, so save, reopen, import, copy, paste, undo,
and redo preserve it without affecting compile output or semantic hashes.

## Controls

- Double-click a node title to minimize or restore it. Double-clicking a
  subgraph still opens the subgraph.
- Press **Alt+C** to toggle the selected nodes.
- Choose **Minimize** or **Restore** from the node context menu.
- Use the minimize/restore button in the selection toolbar.

Selection toggles are atomic. If any selected node is expanded, the action
minimizes all selected nodes. If every selected node is minimized, it restores
all of them. The toolbar's mode button opens the same **Active**, **Muted**, and
**Bypassed** selector as the node context menu.

## Presentation and links

A minimized node is title-width with an 80 px minimum. Its stored expanded
size remains unchanged and returns exactly when restored. The compact preview
row is always visible and shows available image output or a short preview
status.

Editing rows, resize handles, individual pins, widget taps, data panels, and
lens actions are hidden. Each side with one or more connections shows one
aggregate pin, and every noodle on that side meets the aggregate position.
The aggregate pin cannot start a link drag. Dropping a compatible link on the
compact node body or aggregate position still resolves to a real hidden input.

Screen-reader navigation announces the minimized state and the count of hidden
connected inputs and outputs. Hidden individual pins are not separate
navigation items.

## ComfyUI import

A LiteGraph node with an exact `flags.collapsed: true` imports as minimized.
False, missing, and non-Boolean values do not. The imported state then uses the
same Dinkster save, load, undo, clipboard, and rendering paths as a state created
inside Dinkster.

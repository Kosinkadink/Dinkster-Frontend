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

A minimized node keeps the width it has when open and shows only its title
bar; header badges stay inside that bar as they do on the open node. Its
stored size remains unchanged and the height returns exactly when restored.
Below the title bar it keeps the "Preview" caption row, folded, only while it
has real content to show: a picture the canvas paints, such as a decoded image
output or a 3D model's poster, shown as a small picture and its size, or else
the start of the first line of a recorded text result. With nothing to show, a
pending or unavailable preview, or a ready video or audio player, there is no
second row and no label. Clicking the caption opens the picture under it at
its open height without restoring the node; minimizing or restoring folds it
again (see [In-node output previews](in-node-preview.md)).

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

# Node minimization

Minimization hides a node's editing rows without changing its graph behavior.
It is persisted as node view state, so save, reopen, import, copy, paste, undo,
and redo preserve it without affecting compile output or semantic hashes.

## Controls

- Click the arrow at the left end of a node's title bar. It points down on an
  open node and right on a minimized one. A press that drags moves the node
  like the rest of the title bar, and a click on the arrow never opens a
  subgraph.
- Double-click a node title to minimize or restore it. A subgraph node's title
  works the same way; its mark at the right end of the title bar enters it.
- Press **Alt+C** to toggle the selected nodes.
- Choose **Minimize** or **Restore** from the node context menu.

Selection toggles are atomic. If any selected node is expanded, the action
minimizes all selected nodes. If every selected node is minimized, it restores
all of them. The arrow on a selected node acts on the whole selection by this
rule; the arrow on a node that is not selected acts on that node alone and
leaves the selection unchanged. The arrow is drawn at every zoom but takes
clicks only where rows take clicks, and in a read-only run view it changes
nothing. The selection toolbar has no minimize button; its mode button opens
the same **Active**, **Muted**, and **Bypassed** selector as the node context
menu.

The canvas scene navigator lists a **Minimize** or **Restore** button after
each node; Enter toggles that node alone. It is not a Tab stop on the canvas.

## Presentation and links

A minimized node keeps the width it has when open and shows only its title
bar; a subgraph's mark stays in that bar and the tabs above and below stay
outside it, as on the open node. Its
stored size remains unchanged and the height returns exactly when restored.
Below the title bar it shows a one-row strip only while it has real content
to show: a picture the canvas paints, such as a decoded image output or a 3D
model's poster, or else the first line of a recorded text result. With
nothing to show, a pending or unavailable preview, or a ready video or audio
player, there is no strip and no label.

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

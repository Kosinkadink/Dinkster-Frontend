# Boundary editor

The Boundary panel shows what is on a subgraph node: one list of rows in
stored order, the inputs first and then the outputs. It edits the definition
open on the canvas or, with no subgraph open, the definition of the one
subgraph node selected on the canvas. Every change here changes every subgraph
node of that definition, so the head names the subgraph and says how many
places in the document use it ("used in 3 places").

Each row is 26 px tall and shows the type's color dot, its label and, in quiet
text, the inner node it goes to. An output's label and dot sit at the right
end of its line, where its pin is on the node. After the label, an eye marks a
row with a "Show" condition and a warning sign marks a row with a problem.
Rows cannot be reordered, grouped or added here: a row reaches the node from
the canvas, by showing a field on the subgraph node or by a wire to the Inputs
or Outputs panel.

Clicking a row selects it: the raised background and a 3 by 14 px accent bar
at its left edge. The arrow keys move the selection. The selected row's
settings sit in a fixed area at the bottom of the panel, so the list never
moves when another row is picked. The selection is session state
(`AppState.boundaryFocus`) and is not saved.

## Row settings

Each setting is one command and one undo step, and is kept through save and
load, copy and paste, and undo and redo. None of them changes a row's id, a
stored value, a wire, a cache key or what a run sends.

- **Label** sets the row's display name (`boundary.renameItem`), shared by the
  panel and every subgraph node. Clearing it restores the inner field's name,
  then the bound port or tap id as written. Unattached and literal-source rows
  fall back to their interface ids.
- **Help text** is the row's tooltip on every subgraph node
  (`boundary.setTooltip`); empty falls back to the inner field's tooltip.
- **Goes to** (an input) or **From** (an output) names the destination in
  words, such as "strength on Blend", with "and 1 more" for a row that feeds
  several fields. Clicking it centers the canvas on the destination through
  the standard diagnostic focus route; with no subgraph open it opens the
  subgraph through the selected node. An unattached row reads **Nothing
  inside**.
- **Default**, for a field: the value a new subgraph node starts with, which
  is the inner field's stored value (`node.setValue`). Numbers, text,
  dropdowns and toggles are edited with the product's form controls; any
  other kind shows its value and a link to the inner field on the canvas.
- **Limits**, for a number field: a lowest and a highest value
  (`boundary.setLimits`). They narrow the inner field's range on every
  subgraph node and never widen it; a wider value is refused with a sentence
  that names the inner range. Editing a subgraph node's field is held inside
  the limits. A value a node already stores outside them is kept, sent as
  stored and reported as a node's own limits report it. If the inner range
  later shrinks past the stored limits, the row has a problem.
- **Show**, for an input: **Always**, **When X is plugged in** for each other
  input, and **When X is Y** for each dropdown input and option. It is stored
  as a formula in the formula language (`boundary.setVisible`), read at each
  subgraph node over that node's own inputs. Only inputs whose id the formula
  language can name are offered; when some cannot be, a quiet line says that
  inputs from an imported workflow cannot be used in a condition yet. A
  condition whose input was removed is a problem on the row, and the row
  shows. The condition is stored and checked; the subgraph node does not hide
  rows by it.
- An input pin also says whether it may be left empty. The nodes inside
  decide that; it is not a setting.
- **Remove from subgraph node** opens a confirmation that says how many places
  change. Confirming removes the row in one batch of `boundary.unbind`, the
  row's extra bindings first and its primary binding last. Unattached,
  literal-source and forwarded-family rows have no Remove.

A row with a problem shows it in words above its settings, and what to do
about it. Edits wait for final command acceptance. While an edit is pending,
editing controls are disabled and the displayed values still reflect the
document. A refused edit keeps its draft for retry and shows an inline notice;
acceptance clears the draft. Navigating away clears transient drafts and
notices without cancelling a submitted command. Its later completion cannot
clear a newer draft or report a refusal in another view.

## No subgraph open

Selecting one subgraph node on the canvas shows its rows, so they can be
renamed and limited without going in. With nothing selected, the panel shows a
ProductEmptyState prompt with an Open action for each subgraph node on the
current canvas whose definition has a boundary. Open enters through that node,
preserving instance navigation without editing the document. When there is no
such node, the prompt explains how to open a subgraph on the canvas.

Drilling into a subgraph definition leaves the current side-panel tab active.
An information badge highlights the Boundary tab while its editor is available;
the badge clears after navigating back out of the definition. The badge follows
the tab when it is moved to another dock zone, floated, or opened in a window.

Imported interface slots without an internal endpoint retain their declared
type and ordered position as `unbound` bindings. They do not create body
nodes, inner wires, or promoted widgets. An unattached output has no producer;
connecting it cannot fabricate an execution value. Flattening a definition
with unattached slots is refused until its interface can be resolved.

## Nested slot exposure

A forwarded family starts in **Tracks template** mode. New nested slots become
exposed automatically. **Pin selection** records the current explicit slot
set; checkboxes then expose a whole subtree, a narrowed subtree, or no part of
that subtree. **Track all slots** removes the explicit set.

The document remains authoritative. Slot edits use `boundary.setSlots` and
`boundary.clearSlots`, remain one undo step, and never keep a second local
selection. The panel refuses an empty pinned selection, reports invalid stored
paths and derivation diagnostics inline, and names an unavailable schema
catalog instead of hiding the exposure state.

## Regions and frozen views

When the definition was reached through a region occurrence, the panel shows
that occurrence's binding and iteration limit above the rows, and the selected
row's input role, output role, state mapping, or continuation output in its
settings. These controls dispatch the existing region
commands; refused combinations leave the document unchanged and appear as a
status message. Focus or hover an output-role choice for its runtime effect:
Gather preserves one result per iteration, Compact keeps only present results,
Flatten concatenates list results, State returns the final carried value, and
Continuation selects the Boolean that repeats a while region. The choices edit
only the drilled occurrence, not the shared definition.

Canvas input tooltips show what the consumer does when a linked value is absent.
They distinguish a schema-declared policy from the required-input Skip and
optional-input Omit defaults. Skip leaves the consumer unrun, Omit treats the
input as unconnected, Accept runs with no value, and Fail stops execution while
reporting the absence origin.

Execution snapshots are read only. Editing controls are disabled, while
destination focus remains available for inspection. Notices use status
semantics and diagnostics use alert semantics.

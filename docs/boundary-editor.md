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

The panel and the canvas point at each other. While a row is selected, the
canvas outlines its row on the Inputs or Outputs panel in the selection color
and rings each inner pin it goes to, or outlines the inner field. A click on a
row's name on the Inputs or Outputs panel, without dragging, selects that row
in the Boundary panel; dragging the name still moves the panel, and a
double-click still renames.

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

## Fields on the canvas Inputs panel

Inside an open subgraph, the Inputs panel drawn on the canvas shows each
input that the subgraph node outside shows as a field as the same field, in
the same order, with its pin and wire to the inner node kept. An input that
is only a pin outside stays a name and a pin. The Outputs panel is unchanged.

The fields carry the values of the subgraph node the editor came in through,
and the title says whose they are ("Inputs of Soften"). Editing a field
there is the same command as editing it on that node outside and is one undo
step; two subgraph nodes of one definition keep their own values. In a
subgraph inside a subgraph the same rule applies one level down, and an edit
is written to whichever outer node owns the value. Entered with no node, the
panel shows and edits the defaults a new subgraph node starts with (the inner
node's stored value), and the quieter text after the title says "defaults".

The inner field the row is wired to shows the same value dimmed, as an
arriving value. A field that the entered node receives by a wire outside the
subgraph is dimmed and not editable, and shows the arriving value when the
document fixes it. A frozen run view shows the values that run used and
edits nothing.

A field takes the view chosen for it on the subgraph node (a slider stays a
slider); the view is chosen there, so a right-click on a panel field opens
the canvas menu. Tab, Enter and Escape move through the panel's fields as
through a node's, skipping wired ones, and the canvas keyboard list names
each as a row of Inputs. A choice whose options are edited on the node
itself (editable choices) stays a name and a pin. A field
row is renamed in the Boundary panel, not by double-clicking it. A text box
has the height the subgraph node gives it and is resized there.

A field whose input reaches the inner node through a reroute is the same
field, and the inner field shows its value through the reroute.

A value source exposed as a field is a field too. It shows the value the
entered node (or the outer node that owns it) gives the source, and the
source's own value when that node sets none. While a node is entered, the
source's pill and the fields it feeds show that same value dimmed, as an
arriving value, and the pill is not edited there: an edit on it would change
the value every other node of the definition falls back to. Entered with no
node, the field is the source's own value: its stepper and drag edit the
source, and a click opens the source's own editor over the field (never an
in-row editor), the same editor a click on the pill opens.

## Showing a field on the subgraph node

Inside a subgraph, the right-click menu of a field on an inner node offers
**Show on subgraph node**. It adds a boundary input bound to that field,
at the end of the inputs and in one undo step, and the subgraph node
outside shows it as a field with a pin, starting from the inner field's
value. No wire is drawn inside: the Inputs panel row is a field without a
pin, and the inner field has no pin and shows the entered node's value dimmed, as a wired
one does. The entry is not offered in the top-level workflow, on a field
a wire or another input already drives, on a choice's or type choice's own
row, or on a row of a construct already shown whole, and it is refused with a
message on any other field the subgraph node cannot show (a row with no
stored value). A group, choice, type choice or described row is shown whole
instead, by **Show <name> on subgraph node** (see Groups and choices below);
its wire is always drawn.

On a field already on the subgraph node the entry reads **Remove from
subgraph node** and removes that input. A field whose wire is drawn also
offers **Hide wire**, which keeps the input and every node's value.
Dragging a wire from the Inputs panel to a field also puts the field on the
subgraph node; dragging one to a field shown without a wire draws its wire
again and keeps the same input. Whether the wire is drawn is stored with the
input in the document, so a shared session and every later opening agree;
it never changes what runs.

A field shown without a wire carries the cyan subgraph icon before its name,
on the inner node and on its Inputs panel row; a field whose wire is drawn
and the subgraph node outside carry none. Hovering the icon names the input
("On the subgraph node as strength"); clicking it opens the Boundary panel
with that input selected.

A value source exposed as a field has no wire to its pill either (the pill
has only an output), so its Inputs panel row has no pin and carries the icon
too. While a node is entered, the pill carries the same icon before its
title, so the pill and the row read as one field; hovering and clicking it
work as on a field, and a click elsewhere on the pill works as before.

## Groups and choices

A boundary item forwards one inner input or output by its flattened id, such
as `loras.lora0.strength` (see [Node body](node-body.md)), or shows a whole
group, choice, type choice or described row. Right-click any row of one inside
the subgraph and choose **Show <name> on subgraph node**; the item binds the
construct and the subgraph node shows its members, pick and fields, stored on
that node. Inside, the definition's own members come first and the entered
node's follow with its values; editing one, or picking an option, writes the
entered node. A row inside a construct that is already shown, or a construct
around a row that is already shown, is not offered and is refused
(`boundary.constructOwned`). Boundary diagnostics, such as a row of an option
that is not chosen, appear inline on their item.

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

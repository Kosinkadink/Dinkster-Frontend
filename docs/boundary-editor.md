# Boundary editor

The Boundary panel presents the public interface of the workflow definition
currently open on the canvas. Inputs describe values entering the workflow;
outputs describe values returned by it. Empty sections remain visible so the
absence of an interface is explicit.

Imported interface slots without an internal endpoint retain their declared
type and ordered position as `unbound` bindings. They do not create body
nodes, inner wires, or promoted widgets. An unattached output has no producer;
connecting it cannot fabricate an execution value. Flattening a definition
with unattached slots is refused until its interface can be resolved.
The panel identifies these slots as **No internal endpoint** and disables
their **Show** action; connected slots retain their ordinary focus action.

Outside a subgraph, the panel shows a ProductEmptyState prompt instead of a
blank area. An Open action is available for each subgraph occurrence on the
current canvas whose definition has a boundary. It enters through that
occurrence, preserving instance navigation without editing the document.
When there is no available occurrence, the prompt explains how to open a
subgraph on the canvas. Empty input and output sections use ProductEmptyState
and retain their status announcements.

Drilling into a subgraph definition leaves the current side-panel tab active.
An information badge highlights the Boundary tab while its editor is available;
the badge clears after navigating back out of the definition. The badge follows
the tab when it is moved to another dock zone, floated, or opened in a window.

Each item shows its name, canvas destination, binding kind, and region role
when applicable. Names prefer an explicit boundary display name, then the
bound schema's display name, then the bound port or widget tap id as written.
Case, punctuation, member suffixes and uppercase output type labels are
preserved; repeated labels are not numbered. Unattached and literal-source
slots fall back to their interface ids. The **Display name** field sets a
user-defined name shared by the interior boundary panel and every collapsed
occurrence; clearing it restores the schema name or exact binding id. Names persist
through save/load, copy/paste, and undo/redo. **Show** uses the standard
diagnostic focus route to select and center the destination node without
changing the workflow. Long identities wrap, and the panel remains vertically
scrollable at narrow viewport widths.

Edits wait for final command acceptance. While an edit is pending, editing
controls are disabled and the displayed choices still reflect the document.
A refused name edit retains its draft for retry and shows an inline notice;
acceptance clears the draft. Navigating away clears transient drafts and
notices without cancelling a submitted command. Its later completion cannot
clear a newer draft or report a refusal in another view.

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
a wire or another input already drives, or on a choice's or type choice's own
row, and it is refused with a message on any other field the subgraph node
cannot show (a group or another construct, a row with no stored value).

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
as `loras.lora0.strength` (see [Node body](node-body.md)). Forwarding a whole
group, choice or type choice is refused: the item shows the
`boundary.familyBind` diagnostic inline, and compilation reports the bound id
as an unknown port (`compile.port.unknownInput` or
`compile.port.unknownOutput`). Other boundary diagnostics, such as a
row of an option that is not chosen, also appear inline on their item.

## Regions and frozen views

When the definition was reached through a region occurrence, the panel shows
that occurrence's binding, iteration limit, input roles, output roles, state
mapping, and continuation output. These controls dispatch the existing region
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

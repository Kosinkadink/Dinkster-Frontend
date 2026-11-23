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

## Canvas panel positions

The Inputs and Outputs panels inside a subgraph keep their own saved positions.
Moving, adding, removing or resizing other graph items does not move them. Drag a
panel, alone or in a selection, to reposition it.

New definitions store their initial content-bound positions during extraction,
paste or import. Opening an older document does not change it: the first command
that edits a definition stores its previously drawn panel positions in that same
undo step. Undo restores the edited items and the panels' original places.

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

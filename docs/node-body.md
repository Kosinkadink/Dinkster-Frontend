# Node body

A node schema describes its node as one ordered tree of rows,
`NodeSchema.body` (`packages/core/src/schema/model.ts`). The Dinkster schema
wire is version 2 and carries the node body only: `parseDinksterSchema`
(`packages/core/src/schema/dinkster-wire.ts`) refuses another version and a
non-empty legacy `interface` list.

## Rows

- **Input**: a pin, a field, or both. A `pinFirst` field is shown as a pin
  until the user converts it, a `pin: false` field has no pin, and a hidden
  input is stored and sent to the run but never drawn.
- **Output**: an output pin.
- **State**: a stored value with no pin and no field. State that is part of
  the run is sent with the node's inputs; other state stays with the workflow
  only.
- **Section**: a titled box that holds rows and can start folded (wire
  `collapsed`). Layout only; it adds nothing to row ids.
- **Row**: two to four cells side by side: fields, notes and buttons.
  Layout only: each cell is drawn beside the one before it when both are in
  the same section. A line with a field folds. Folded, its start state, the
  cells share one row and only a field with a wire keeps a pin: wires in
  gather at the middle of the line's left end and wires out at its right,
  in declared order. Unfolded, each cell has its own row and its ordinary
  pins, with a rail beside them. The fold state is view state, saved per
  node in `lines` under the flattened id of the line's first field, apart
  from the sections' map because a section and a field may share an id.
- **Note**: read-only text with no pin, on its own line or as a cell of a
  Row. It keeps its line while its text is empty. A note whose text is a
  formula or a lookup shows its `unknown` text dimmed (empty when it has
  none), because the editor does not evaluate formulas yet.
- **Button**: a capsule with its label and no pin, on its own line or as a
  cell of a Row. It does nothing when clicked: the editor never runs a
  button's steps.
- **Editor**: decoded with the schema; the canvas does not draw it. An editor
  row is a custom or compositor widget with no value of its own; it must name
  at least one row it writes or reads.

A custom or compositor widget, on an editor row or on an input, may carry
`writes` and `reads`: its own part names mapped to row ids of its scope. The
editor keeps them on the widget spec, apart from the widget's own options, and
does not hand those rows to the widget yet.
- **Group**, **Choice**, **Type choice** and **Described**: the rows below.

Every row's `visible` (a boolean or a formula) and an input's or output's
label written as a formula are decoded and kept as declared. The editor does
not evaluate them yet: every row shows, and a formula-labelled input or
output is labelled by its id.

## Elaboration and flattened ids

Elaboration (`packages/core/src/schema/elaborate.ts`) reads the body against
one node's stored values, stored dynamic state and link existence, and
produces the rows the node draws and the run receives. It never reads solved
types. Every row gets a flattened id:

| Row | Flattened id |
| --- | --- |
| member of a group of values | `<group>.<key>` |
| row of a member of a group of records | `<group>.<key>.<row>` |
| row of a choice's chosen option | `<choice>.<row>` |
| row a type choice reveals | `<typeChoice>.<row>` |
| entry of a described row | `<described>.<entry id>` |

The option or variant key is not part of the path, so rows of different
options with the same id share one stored value, and switching options keeps
the other options' values stored. The flattened id is the stored value key,
the link port and the input name the run receives. The node's dynamic state
is keyed by flattened id as well: a group's `members`, `seq` and member
labels, and the `selected` key of a choice or type choice.

A body nests at most 16 boxes, a group holds at most 512 members, and a node
has at most 1024 flattened rows; exceeding a limit stops elaboration with one
error.

## Groups

A group repeats its member rows. A group of values has one input or output
per member; a group of records repeats a list of rows per member. Member keys
come from the group's naming rule: numbered (prefix, start number and padding)
or a fixed list of names. A key is never reused after its member is removed.

How a group grows:

- `link` and `filled`: once every stored member holds a value or a wire, the
  node shows one spare member.
- `button`: the node shows an add control after the members.
- `count`: a formula over stored values gives the number of members, within
  the group's bounds. These members are not stored and there is no spare.
  A formula or lookup argument that reads the size or the members of such a
  group from outside a member (`len(g)`, `sum(g.s)`), a count reading its own
  group included, is refused at load as not built yet; a member's formulas
  may read its own rows.
- `followList` is refused with `elab.group.followList`.

A count or leader formula that names a row under an option that is not
chosen, from outside the choice or from another of its options, reads it as
unknown, and `linked()` is false for it; so does a group's size or a list
across its members under such an option. An unknown count gives the group's
`minMembers`; an unknown leader gives the choice's first option. A formula
reads a choice's key the same whether the choice is declared before or after
it, including a led choice or one with nothing stored yet. A field with
nothing stored reads its default, also under the chosen option, in a stored
member, or where a `Use` gives it another default.

A group that grows by link, filled field or button has its first
`minMembers` members stored whenever it is part of the node: on a new node,
and at the moments a required choice's start key is stored (below). Members
already stored keep their order and the missing ones follow with the keys Add
would give. The spare member the node shows is drawn and never compiled;
connecting or editing it stores it in the same undo step
(`dynamic.materialize`). A run refuses a group with required rows and fewer
stored members than its minimum (`elab.autogrow.underMin`); such a document
still opens and can be edited. With `optionalAfterMinimum`, member rows past
the minimum are optional.

Disconnecting, rewiring away, deleting a link or deleting its source removes
members the user no longer uses, in the same undo step (`dynamic.compact`).
Paste does the same. **Remove unused dynamic inputs** in the node context menu
compacts on demand. A member is in use when it holds a value, a link, a
boundary binding, an optional choice's key, a required choice's key other
than its start key, or a nested member in use. A group that grows by hand
keeps its first unused members up to its minimum. Everything stored under a
removed member goes with it, nested `seq` too; the group's own `seq` stays so
a removed key is never handed out again.

When a count shrinks, what its later members stored stays and returns when
the count grows. Those members are not part of the node or a run, and
retention reads their stored state as it reads an option that is not chosen,
for any key the group's naming can make up to its limit.
Connected member sockets keep a hollow center (see
[Optional outputs](optional-outputs.md)).

Member labels come from the group's `memberLabel`, else the name, else the
prefix and the member's position counted from 1. Rows of a record member are
labelled with the member label first.

The members of a `reorderable` group that grows by link, filled field or
button can be moved (`dynamic.moveMember`, one undo step). A move changes
only the stored order: keys, values, labels a user typed, wires and boundary
bindings stay with their member, while the shown number and the order a run
receives follow the new position. A count group, a group that is not
`reorderable`, and a node whose schema is not loaded refuse the move
(`dynamic.notReorderable`). The canvas has no gesture for it yet.

## Choices

A choice holds a list of options, each with its own rows, and rows several
options share. An option places a shared row with a `Use`, directly or inside
one of its sections, and may override the row's label, tooltip, field,
default or whether it is required; an overriding field is checked against the
shared row's type. Shared rows hold values: a Section, Row, Note, Button or
Editor there is refused at load. Different options may each hold a section,
note, button or editor with one id, since only one option shows. Without a
leader it draws a dropdown of its options; changing it stores the new key
(`dynamic.selectOption`) as one undo step. A choice with a leader formula has
no dropdown: the formula over stored values and link state gives the key.

A required choice always has a stored key. A new node stores its start key
(its `default`, else its first option), and the editor stores it, with the
minimum members of groups the node now holds, when a command touches the
node or when an opened document meets its schemas (`dynamic.storeStartState`).
A run never makes one up: a required choice without a stored key is refused
(`prompt.missing_dynamic_choice`), and a document holding one still opens,
with incomplete retained ownership until the key is stored. An optional
choice starts on none, which shows no option's rows, and may not declare a
default.
A hidden choice shows neither its dropdown nor its chosen option's rows; its
stored key still selects those rows, and they are still stored and run.

A stored key that names an option the pack no longer has is treated as no
pick when the document opens: a required choice goes to its start key, an
optional choice and an optional type choice go to none, and a required type
choice has nothing selected, so the document opens and a run is refused until
a variant is picked. Opening stores that change in one undoable edit; the old
values stay in the document. Stored state for a removed group or choice also
stays in the document but contributes no live rows. Malformed state is still
refused when opening the file. Problems lists one warning per adjusted node
under "Upgraded on open"; selecting it moves the canvas to the node, and
undoing the edit restores the old key without dismissing the warning.

A shared choice has one stored key, and each `Use` of it may offer fewer of
its options with `only`. When retention, flattening or a replacement reads an
option that is not chosen, a stored key that place leaves out is not a
problem. The place reads as its start key: its default when it offers it,
otherwise its first offered option. Nothing is stored or changed. A stored key
that no option of the shared choice declares, or that the chosen option leaves
out, is treated as an option the pack no longer has, and is reported once for
the choice.

## Type choices

A type choice is led by the type plugged into its pin. Connecting a producer
of a concrete type stores the one variant that accepts it, in the same undo
step, when no variant is stored yet; the pin's context menu chooses or clears
a variant. The chosen variant's rows and the rows every variant has appear
under the pin. A type choice without variants reveals its rows while the pin
has a value or a link. A connected type choice without a valid stored variant
is refused at compile (`compile.slot.missingVariant`). A `typeVariable` binds
a node-level type variable to the chosen variant's type.

## Described rows

A described row lists rows from a stored description, kept under the row's
own id as JSON `{"entries": [...]}`. Each entry has an `id`, a `label` and a
`kind` naming one of the row's declared input or output kinds, and becomes
that input or output under `<described>.<id>`; input entries may also carry a
`default` and widget option fields. The description holds at most 1 MiB and
512 entries within the row's own bounds; ids are row ids, ids and labels are
unique, and labels are non-blank, at most 256 characters, without NUL. With
`fixedIds`, each entry id equals its kind id. A linked description is refused
(`elab.outputDescriptors.linkedSource`) and an invalid one reports
`elab.outputDescriptors.invalid`.

## Boxes: sections, groups and choices

A section, a group and the chosen option of a choice are drawn as boxes
(`packages/canvas/src/layout.ts`, painted by `renderer.ts`). Each item of the
elaborated interface carries `boxes`, the keys of the boxes around it,
outermost first: a section's flattened id, `group:<path>`,
`member:<path>.<key>` and `option:<path>`. A box is layout only: ids, stored
values and pin positions are the same with or without it.

- The outline sits past the pins: its inner side lines up with a field
  outside any box, and a field in one box sits 3 px inside it, so it is
  3 px narrower on each side. Each box inside a box steps in 7 px more. A pin row inside a box keeps its pin on
  the node's edge; only its name moves in. The node's least width grows with
  the nesting.
- A section or group box opens from its own header row: an arrow, the name,
  and for a group its member count. Closed, the box is one row at the same
  place, so opening or closing it moves neither its name nor any row above
  it. The closed row shows how many rows stand directly inside it (an inner
  box counts one; for a group, how many members) and a dot when a value
  inside is not its default. The whole row opens or closes the box and
  highlights under the pointer; the right-click menu does the same.
- A box declared with `openName: false` shows no header while open, only a
  small tab on its top edge; closed, it is an ordinary closed row.
- Closing a box hides its rows and unconnected pins. Connected pins gather
  at the closed row, inputs on the left edge and outputs on the right. The
  open or closed state is view state (`view.setSectionCollapsed`, keyed by
  the box key) over the schema's start state; groups start open.
- A wire dropped on a closed row takes the first port inside that fits, in
  declared order, a free input before a wired one, and the box stays
  closed. While the wire is held there, the row names that field in place
  of its count. If nothing inside fits, the drop is an ordinary drop on the
  node.
- A member of a group of records that draws more than one row gets its own
  box, headed by its label and a remove cross; members cannot be dragged.
  In a group that grows by hand, a member that is one row has no box: the
  row ends in the remove cross and its field stops short of it. The cross
  does not remove the member by itself; unused members go with **Remove
  unused dynamic inputs**. A group that grows by hand ends in an outlined
  Add row. A group that grows by
  plugging in shows its spare member last with a hollow pin and a dimmed
  name.
- A choice's dropdown reaches its box's outline and has its own outline; the
  chosen option's rows sit in a box joined to its underside. An option with
  no rows draws no box, and neither does a choice led by a formula.
- Outputs pair only with rows inside the same boxes. A top-level section with
  id `advanced` stays below every other row.

## Run submission

Compile (`packages/core/src/compile/compile.ts`) sends each node's inputs
under their flattened ids. Members the node does not store, a choice's
dropdown and rows of options that are not chosen are not sent. The graph wire
carries, per node:

- `slotVariants`: the key of every choice and type choice that takes part in
  the run, by flattened id.
- `outputMembers`: the stored member keys of each grown group, in order.
- `outputIds`: the node's wireable outputs in elaborated order.

## Subgraph boundaries

A boundary forwards one inner input or output by its flattened id, such as
`loras.lora0.strength`. The member must be stored on the inner node
(`boundary.memberMissing`), except in a group grown to a count; a row under a
choice or type choice must belong to the chosen option or variant
(`boundary.branchInactive`). A `construct` binding shows a whole group,
choice, type choice or described row instead: each subgraph node owns its
members, pick and values under the item's id, after the definition's own
members. A `port` binding that names a construct is refused
(`boundary.familyBind`). See [Boundary editor](boundary-editor.md).

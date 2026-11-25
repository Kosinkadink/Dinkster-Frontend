# Automatic values

A node's field may declare `automatic`: a formula or a lookup that works the
field's value out until the user fixes one. The declaration must also give a
`default`, and the field must be a whole number, a decimal number, text, a
choice or a yes or no.

## Automatic and fixed

A field is automatic while nothing is stored for it, and fixed once a value is
stored. There is no other marker in the document.

- A new node stores nothing for an automatic field.
- Any stored value fixes the field, even one equal to the worked-out value or
  the default. A workflow saved before the field declared `automatic` has a
  value stored there, so it opens fixed.
- `Reset to default` (and the section and node resets) removes the stored
  value of an automatic field, so it is automatic again. It is one undo step
  with the other resets of the same item.
- A wire into the field wins; nothing is worked out for a wired field.

## How the row looks

A closed automatic row shows the word "auto", then the value in use, both
dimmed: "auto 24". When the value cannot be worked out, a yellow dot comes
before "auto" and the value is the default. A fixed row shows its value as any
field does. The minus and plus steppers of an automatic number step from the
value in use and store the result at once, which fixes the field.

An opened automatic field is empty, with "auto" and the value in use as its
hint, so leaving it without typing keeps it automatic. Emptying a fixed field
and leaving it removes the stored value, which makes it automatic again. On a
number field, the side part's default line reads "automatic (24)", or
"automatic (not known)" when the value cannot be worked out, with a spinner
while a lookup loads, and its link empties the field. While the field is empty, the side part also gives
the warning, or one plain line when a lookup's answer is not fresh: "Could not
refresh", "Paused", "Offline" or "Waiting for the file to be checked.".

## Working the value out

The editor works the value out whenever it elaborates the node, over the
node's values in use, with the same formula evaluator the engine uses. The
result is shown and never stored: working it out is not an edit and leaves no
undo step. A formula of another row that reads the field reads the worked-out
value.

When the value cannot be worked out - the formula reads something not known
or fails, the result is not a value of the field, a lookup fails, runs out of
time, or has an argument that fails, is None or cannot be known in the editor,
such as a wired input - the field's default is used and the field carries a
warning, "Could not work out frame rate. Using the default, 24.", listed in
Problems. A lookup takes no None argument, so the editor and the engine both
use the default without calling it. While a lookup's answer is still to come,
one of its arguments reads another automatic field still waiting on its
lookup, or an argument is None because it reads a field left empty - one the
run is sent nothing for that stores nothing or null, such as an optional
source rate not set yet - the field shows the default without a warning. A
required field with no default whose widget has a start value is not empty:
the run is sent that value, so the lookup is called with it. For an empty
field the side part reads "Waiting for source rate.", with that field's label,
or "Waiting for a value." when the argument is not that one field.
The editor does not yet send a file field as a lookup argument: a formula
cannot read a file field, so such an argument is refused and the field shows
the default with the warning, whether or not a file is picked.

A lookup's answer kept for the same arguments is shown as worked out, with no
warning, while a newer one loads, after a refresh failed, or while the editing
budget is spent. Offline, paused or waiting for a file to be checked, with no
answer kept, the field shows the default with no warning: nothing is under
way that the field can fix.

A whole-number field takes a whole number or a decimal that is exactly whole;
a decimal field takes either; a choice is checked against its options only
when they are written in the declaration.

## Queueing a run

The editor leaves an automatic field with nothing stored out of the run it
submits. The engine works the value out again when the run is queued, before
any cache lookup, uses the default when it cannot, and records for each such
field the value used and whether it was worked out or was the default
(`automaticValues` on the job). A run is never blocked by an automatic value.

An automatic field with nothing stored whose value is copied into another
node, through a widget tap or from a node that does not run, passes on the
value its row shows: the worked-out value, the lookup answer the editor
holds, or the default when there is neither. When that is the default, the
field carries the warning "Could not work out frame rate. Retime 2 gets the
default, 24.", listed in Problems in place of the field's own warning. The
engine still works out the owning node's own value when the run is queued,
so it can differ from the value passed on. The editor keeps each value passed
on with the run it queued; when the owning node ran and its recorded value
differs, the field carries the warning "The last run used 30 for frame rate,
but Retime 2 got 24.", listed in Problems. It is one warning for the field,
naming two nodes ("Retime 2 and Retime 3") or counting more ("3 nodes"), and
it goes when the user fixes a value or wires the field, or a later run
replaces the record. Fields on nodes inside a region body are not compared.

When the latest run of the open workflow used the default for a field that
the editor works out now, the field carries the warning "The last run could
not work out frame rate and used the default, 24.", also listed in Problems.
It goes when the user fixes a value or wires the field, and when a later run
works the value out. The editor reads the record from the finished job.

A frozen view of a past run shows, on each automatic field, the value that
run recorded rather than one worked out now: worked out, or the default with
the dot and the warning when the run could not work it out.

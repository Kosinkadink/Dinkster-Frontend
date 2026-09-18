# Boundary editor

The Boundary panel presents the public interface of the workflow definition
currently open on the canvas. Inputs describe values entering the workflow;
outputs describe values returned by it. Empty sections remain visible so the
absence of an interface is explicit.

Drilling into a subgraph definition leaves the current side-panel tab active.
An information badge highlights the Boundary tab while its editor is available;
the badge clears after navigating back out of the definition. The badge follows
the tab when it is moved to another dock zone, floated, or opened in a window.

Each item shows its generated name, canvas destination, binding kind, and
region role when applicable. Generated names prefer meaningful schema labels,
humanize type-like labels, remove implementation suffixes such as `_m4` and
`_3`, and number repeated names in boundary order. The **Display name** field
sets a user-defined name shared by the interior boundary panel and every
collapsed occurrence; clearing it restores the generated name. Names persist
through save/load, copy/paste, and undo/redo. **Show** uses the standard
diagnostic focus route to select and center the destination node without
changing the workflow. Long identities wrap, and the panel remains vertically
scrollable at narrow viewport widths.

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

# Dynamic output families

The current Dinkster schema can declare top-level output families whose size comes
from a required `core.int` input. The count must be a stored, nonnegative safe
integer within every family bound that uses it. A linked count input is invalid.

Members use canonical suffixes `0` through `count - 1`. Their document
addresses are `{port: familyId, members: [suffix]}` and their backend IDs are
`familyId.suffix`. Multiple output families can share one count input.

Editing a count is one undoable command. Reducing it does not silently delete
links from departing members. Those links remain in the document and appear as
missing-port problems until they are disconnected or the count is restored.
Undo restores the former output rows and makes the preserved links valid again.
Copy and paste preserve the stored count and exact member addresses.

Replacement rules can copy a whole count-bound output family or map ordinary
source outputs to explicit members. Whole-family copies preserve every member
suffix, link, and named-net source. Explicit mappings must list canonical
zero-based suffixes and set the target count to the exact member total. Count,
bounds, and shared member-budget failures block the replacement.

Subgraph boundaries project count-bound output families with the same
canonical suffixes and output indexes. A definition-local count produces a
fixed instance family. Exposing its count input as a promoted boundary widget
makes the family size occurrence-local, so sibling instances can have different
outputs without changing the shared definition. Drilling into an occurrence
shows that instance's output members and routes count edits back to the owning
instance, including the first edit of an inherited definition count. Occurrence
edits use the same bounds and member-budget validation as native count widgets.
An invalid definition count reports `boundary.countBoundOutputInvalid` and
omits only that boundary output when the count is fixed. An unlinked promoted
count remains usable on instances that hold a valid value. A linked definition
count reports the same diagnostic and always omits that output because
runtime-computed arity is not supported. Queueing reports
`elab.outputFamily.linkedCount` for linked counts or `elab.outputFamily.badCount`
for missing/invalid literal counts, without submitting a prompt. Other boundary
items remain usable. Browser coverage is in `boundary-output-families.spec.ts`
and `boundary-output-refusals.spec.ts`.

The sibling-instance browser proof and inspected before/after screenshots are
in `packages/e2e/tests/count-bound-output-boundary.spec.ts` and
`dinkster-evidence/frontend/issue-308/`.

Count-bound schemas require one ordinary template slot; execution-time arity
remains refused under [#397](https://github.com/Kosinkadink/Dinkster-Frontend/issues/397).
Generic nested autogrow output families cross chained boundaries with exact
member identities and terminal output indexes, as covered by
`packages/e2e/tests/boundary-output-families.spec.ts`.

## Named, typed output descriptors

The schema also supports `outputDescriptors`: a concrete type catalog plus the name of a
required `core.string` source input. Its stored JSON is an object with an
ordered `entries` array. Each entry has a stable `id`, display `name`, and
catalog choice `type`. Other document and entry fields belong to the node and
are preserved, including expression text, values, and indices.

Descriptors work with ordinary `acceptsStorage` inputs. Choice `alphaPolicy`,
`maskPolarity`, and `maskSemantic` declarations follow the selected output
through elaboration and subgraph boundaries. Invalid policies are rejected.

Click the source widget on the node to open the output descriptor editor.
Edit names and types, reorder rows, or add/remove outputs, then choose **Apply
outputs**. One ordinary value command commits the whole document and is
undoable. **Stored JSON** edits node-owned fields or repairs malformed data.
Links follow IDs, not row positions: removing an output leaves repairable
missing-port links instead of deleting or retargeting them.
Documents containing unsafe integers or overflowing numbers use read-only
structured controls with an explanation. Stored JSON remains editable and
Apply preserves its exact text, without rounding node-owned numeric values.

Descriptors are limited to 1 MiB of UTF-8 and at most 512 entries within the
schema's declared bounds. IDs must be unique and match `[A-Za-z0-9_-]+`.
Names must be unique, nonblank, at most 256 characters, and contain no NUL.
Types must select a concrete catalog choice; wildcard fallback is forbidden.
IDs cannot collide with other effective outputs or family IDs.

Direct subgraph output bindings select the raw entry ID. Promoting the source
widget projects its stored value through chained occurrences, with definition
fallback and sibling isolation. Save, recipe identity, and undo retain the
ordered source document. Linked sources, including region deliveries, are
invalid: execution cannot change the output schema.
Promoted source widgets retain the descriptor editor and metadata probe through
chained boundaries even when all generated outputs stay inside the subgraph.

Schemas with `probe` and `fixedIds` expose **Probe current asset**. The editor
requests `/api/output-profiles/model?digest=...&revision=...` from the node's
current backend, without filename detection. Model profiles use stable
`model`, `clip`, and `vae` IDs and canonical `dinkster.*` types. Changing the asset
inactivates its old profile immediately; links remain for repair. Probe results
are discarded after a node edit or backend-generation change. Stored profiles
must match the current asset digest and declared detector revision; backend
admission independently revalidates metadata before cache lookup.

Probed profiles are read-only: names, types, order, membership, and Stored JSON
cannot be edited. Use Probe and Apply to retain the canonical backend profile.
`fixedIds` alone does not make nonprobed descriptors read-only.

When a saved link names an output absent from the current profile, the editor
lists that stable ID under **Inactive linked outputs**. The link remains in the
document and blocks execution until a matching profile restores it or the user
disconnects it. Profile changes never move a link to another output by position.

`dinkster.load_model_profile` declares a required concrete `dinkster.asset` input
named `checkpoint`, with descriptors stored in `entries`. Asset and query
digests are canonical `blake3:<64 lowercase hex>`; `shapeDigest` is SHA256.

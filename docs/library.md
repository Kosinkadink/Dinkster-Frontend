# Library

The left-dock Library browses five sources in a stable order: Packs,
Templates, Workflows, History, and Runs. The Library header names the backend
that owns the current tab and shows its exact protocol and connection state.
Search, filters, paging, grid/list preference, and row keyboard navigation use
the shared `CollectionPanel` contract; each source remains responsible for
server-side ranking and cursor semantics.
In shared grid views, selected metadata and actions stay below the preview
inside their tile rather than wrapping into a second column.

Packs, Templates, and Workflows use the Library content language. Rows expose
readable names and badges without hiding exact identifiers or provenance.
Selecting a row reveals its complete metadata and explicit actions in a detail
rail when space permits, or inline at narrow widths. Long identifiers wrap and
remain selectable. Loading, failure, empty-corpus, and no-match states name the
active source instead of presenting a generic blank panel. Switching sources
hides rows from the previous source while the replacement page loads. Backend
status updates preserve the active source and its browsing context. ComfyUI
backends identify saved workflows as unavailable instead of suggesting an
unsupported save.

Persisted native execution results keep their acknowledged asset-owner IDs,
revisions, source bindings and complete digest sets separately from bounded
display descriptors. Restore checks each recorded owner against the same
backend before exposing the result. A missing, changed or unreachable owner
leaves the record unresolved; it does not authorize release or a replayed
write. Legacy records without owner metadata do not certify completeness.
Restore admits an independent owner for the full saved roots, including roots
omitted from display descriptors, rather than adopting another window's owner.
Its pre-publication value reads require the validated job identity and the
unchanged backend lifetime; ordinary reads still require a live result owner.
Clearing history does not release results still present in the execution store
or pinned by a frozen view. Once neither a live result nor a persisted record
holds a locally admitted owner, the admitting application retires its captured
revision. Disconnected lifetimes and unreadable persistence remain blocked;
restart and backend removal do not authorize release. Lost release responses
reconcile only the exact next-revision tombstone, without repeating DELETE.

Shared-workspace operation recovery is written synchronously as unacknowledged
staging. Each added native document has a separate durable receipt, bound to
the staged content, backend and generation, before its operation is submitted
to the SharedWorker. Lost acknowledgments reconcile the exact receipt; refusal,
replacement or a changed backend/catalog leaves the staged entry unresolved.
Admissions settling out of order do not reorder the actor's operations. A
failed admission blocks that operation, not subsequent independent admissions;
storage recovery does not require a SharedWorker reconnect. A
reconnect admits fresh owners instead of trusting stored receipt metadata.
Journal removal, disconnect and application exit do not release these owners.

Canonical workspace snapshots, each window's recovery candidate, and each
document's recovery slot also admit separate owners for their exact saved
documents, without undo/redo roots belonging only to the live editor. Recovery
bytes are written synchronously, explicitly unacknowledged until admission
settles. A changed slot or catalog cannot inherit a stale acknowledgment.
Only a complete acknowledgment for the current canonical generation permits
removing unchanged covered workspace candidates and operation entries. Network
admission does not hold the cross-window persistence lock. Removing a source
does not itself release its durable owners.

Host-owned source controls, search labels, detail headings, confirmations, and
loading, failure, and empty-state copy follow the active application locale and
update while the Library remains open. Backend labels and status, protocol
product names, source labels, entry metadata, action labels, errors,
identifiers, digests, media types, and provenance remain source-provided data.

The labelled source button group supports Arrow keys to move and select, while
Home and End choose the first and last source. A compact source selector
replaces the buttons at narrow viewport widths. Workflow rows retain
their direct open behavior. Templates open only through **Open template** after
selection. Pack rows select for inspection. History and Runs retain their
existing execution-owned activation, actions, and clear semantics.

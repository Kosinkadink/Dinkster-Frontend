# Library

The left-dock Library browses five sources in a stable order: Packs,
Templates, Workflows, History, and Runs. The Library header names the backend
that owns the current tab and shows its exact protocol and connection state.
Search, filters, paging, grid/list preference, and row keyboard navigation use
the shared `CollectionPanel` contract; each source remains responsible for
server-side ranking and cursor semantics.

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

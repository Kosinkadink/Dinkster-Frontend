# Universal search

Universal search is the app-wide command, node, setting, and workflow-tab
finder. The topbar trigger shows the effective `search.open` shortcut and
opens one native dialog. The trigger remains visible at narrow widths.

## Host surface

`SearchSurface.tsx` owns the framework presentation vocabulary:

- `SearchInput` provides the search field, icon, accessible label, and input
  state.
- `SearchResultGroup` and `SearchResultRow` provide labelled listbox groups,
  option identity, active state, titles, details, descriptions, and badges.
- `SearchState` provides loading, empty, and error states.

Universal search composes that vocabulary into its dialog. The host owns all
markup, semantic CSS tokens, layout, overflow, focus, ARIA, announcements,
errors, and lifecycle. Search-specific result hierarchy stays separate from
generic text completion and generic floating-surface contracts.

The active result may include a versioned static preview descriptor. The host
renders its title, description, and label/value fields beside the result list
on wide viewports and in a bounded lower region on narrow viewports. Preview
content is not part of the option-only listbox and introduces no focus target.
The active option references preview content when details exist and adds the
preview heading only when its title differs from the result title.

Opening focuses the combobox. Up/Down moves through visible results, Enter
activates the current result, and Escape closes. Pointer and keyboard
activation share the same action path. The list uses `aria-activedescendant`,
labelled result groups, option semantics, and a polite status announcement.
Loading, failure, and empty states remain outside the option-only listbox.
Show more is an option in the same arrow-key and Enter sequence as results.
Closing restores focus to the element that opened the dialog. The results
region scrolls independently and keeps the active row reachable.

## Session and provider contract

The framework-free `createSearchSession` in `@dinkster/core` is the only query
orchestrator. It owns prefix routing, synchronous and asynchronous dispatch,
debounce, cancellation, provider churn, group/reset streaming, and stale
result rejection. Hosts render its snapshots and do not copy routing policy.
Provider failures are isolated per group and surfaced without discarding
successful groups.

`SearchRegistry` accepts typed `SearchProvider` records. Providers contribute
identity, label, prefix, priority, typed result data, and action descriptors.
They do not contribute DOM, CSS, themes, app stores, sockets, network handles,
or Canvas handles.

Search host actions use a closed discriminated union for command lookup,
settings focus, tab activation, and node placement. The host strictly decodes
the exact string parameters before recency, modal, tab, Canvas, or document
effects. Malformed or unknown actions fail closed.

Extension packs declare `searchProvider` contributions through the manifest
host. The contribution id and provider id must match. Labels own group names,
priorities own group order, and optional result previews are versioned plain
data. The host copies, freezes, bounds, and decodes every returned result and
passes the callback only frozen tab/selection identity plus the request abort
signal. Gates and pack disposal unregister providers and trigger the existing
session's provider-churn path; failed initial activation publishes no transient
registry change. Nested registry batches retain independent commit decisions,
so rolled-back staging cannot suppress a committed reentrant gate change or
publish an independently rolled-back nested change.

Core providers are:

- `core.commands`: menu and command actions with effective shortcuts.
- `core.settings`: settings index entries and focus actions.
- `core.nodes`: canonical node schemas and placement actions.
- `core.tabs`: open workflow tabs and activation actions.

Registered provider changes immediately rerun the current query. Disposers
are idempotent and only publish a registry change when they remove the active
registration.

## Routing and ranking

- No prefix searches every provider.
- `>` searches commands.
- `@` searches nodes.
- `#` searches settings.
- `~` searches open workflow tabs.

Prefixes are provider-declared. Results retain provider order, use the shared
`scoreMatch` fuzzy scorer, and receive a bounded persisted frecency boost.
Each group initially shows five rows; Show more expands that group without
changing the other groups.

Node display names are presentation and may collide. Duplicate display names
show pack, category, and canonical type context. Result identity and placement
always retain the exact canonical node type.

## Static pack schemas

`RemoteNodeCatalog` reads `schemas/index.json` and its referenced
`packs/<name>/<version>/schemas.json` files directly beneath one configured
static prefix. URLs stay relative to that prefix, so a recursive static copy
does not require registry API routes. Only the authenticated first-party
publisher entries advertised by the index are accepted. Pack identity,
version, SHA-256 body digest and schema wire version are validated before
ordinary node interfaces are decoded with `parseDinksterSchema`.

The client exposes preview-only `CatalogNode` records, not an executable
registry. `cached()` synchronously reads previously validated bodies;
`refresh()` coalesces concurrent calls, uses up to four schema requests at a
time with five-second request deadlines, and revalidates bodies with ETags.
Persistent cache keys include each full resource URL, isolating mirrors.
Missing or invalid network data falls back to validated cached bodies; an
uncached offline client returns an empty external catalog. A successful empty
index removes old discovery entries, and a changed digest never falls back
to a body from the previous digest. Storage failure does not prevent a live
response from being used. Responses are streamed with a 16 MiB body limit,
including when Content-Length is absent or inaccurate. Discovery accepts at
most 1,024 packs and 16,384 nodes per pack; oversized input is rejected, not
silently truncated. Cached input is subject to the same limits.

`search.registryUrl` selects the registry or static mirror prefix; clearing
it disables external discovery. Opening search revalidates in the background,
without delaying installed results. `core.nodes` ranks the combined display
corpus, retaining search terms and omitting external nodes whose type or pack
is already installed on the active backend. External rows always identify
their pack and localized Not installed state.

Both installed and external node results paint their ordinary schema with
the palette's `paintSchemaPreview`, CanvasRenderer and current widget views.
Selecting an external node opens a pack/version/platform preview prompt,
never placement. The host rechecks the schema fingerprint and backend at
selection, rejecting stale results. The prompt reports when installation is
unavailable without altering the workflow. A later installed result uses
the ordinary placement path.

## Node placement

Activating an installed node result arms click-to-place without changing the workflow
and returns focus to the canvas the search opened over. The ghost appears
immediately at the current cursor position - zero mouse movement required -
whenever the cursor is inside the canvas, and otherwise the status bar names
the pending node until the pointer enters the canvas. A presentation-only
ghost then follows the Canvas pointer. Canvas click commits through the
existing palette placement path. Escape, tab/graph changes, or a frozen
owner cancel placement, with no prior canvas click needed. The ghost is
renderer overlay state and never document state.

## Verification

Core search tests cover routing, ordering, sync/async streaming, cancellation,
provider churn, extension result decoding/ownership, transactional registry
publication, failures, and stale rejection. App component tests cover
semantic grouping, result caps, keyboard navigation, input focus,
loading/empty/error states, provider failures, extension previews and gates,
announcements, and no document mutation before activation. Playwright covers
native focus restoration, the topbar entry point, extension group/order,
preview containment, live teardown, typed action dispatch, node placement,
cancellation, zoom geometry, scroll reachability, and layout auditing.

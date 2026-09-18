# App View

App View is the `app` editor kind. It presents selected workflow inputs,
previews, instructions, and groups without the node canvas while retaining the
same document, command store, schema registry, execution store, undo history,
and collaboration session as Graph View. Authors can place multiple queue
buttons that each run a selected part of the workflow.

Use the top-bar **App** selector or **Alt+V** (`view.toggleAppView`) to switch
the active tab. The selected editor kind persists with the tab. App View shows
the workflow title and description, an **Arrange** toggle, and the same queue
action used by the workflow toolbar.

## Modes

**Use mode** is the default presentation. It shows only authored content,
controls, previews, and queue actions. Input edits dispatch the same
`node.setValue` commands as Graph View.

**Arrange mode** adds placement, labeling, grouping, reorder, and removal
controls. Arrange state belongs to the tab UI, survives an editor-kind switch,
and is not document data or persisted across reloads. Frozen tabs cannot enter
Arrange mode.

The Arrange toggle exposes its current state with `aria-pressed`.
The Desktop and Mobile layout preview buttons are another pressed-button group;
that selection changes only the authoring preview. Use mode always follows the
editor container width.

## Exposure model

Controls are promoted from a widget context menu or the Graph View Exposure
lens. Their ordered registry is stored in:

```text
doc.ext['dinkster.exposed']
```

Each entry is identified by `{ graphId, nodeId, inputId }` and may have a
`label`. `inputId` is the elaborated input id. Forwarded-family rows record the
owning node identity, while synthetic rows that have no document value cannot
be exposed.

Node previews are promoted from the preview context menu or Exposure lens.
Their ordered registry is stored in:

```text
doc.ext['dinkster.exposedPreviews']
```

Each preview entry is identified by `{ graphId, nodeId }` and may have a
`label`. A schema-declared preview-capable node offers **Promote to App View**
from its compact preview row before execution; the action does not require
preview content to exist. Preview exposure is per node rather than per output.

Both registries are tolerant reads. Malformed entries and duplicate identities
are skipped without invalidating the workflow. The next valid write rewrites
the affected registry in canonical form. Stale entries remain removable in
Arrange mode.

Exposure writes use serializable commands:

| Command | Purpose |
| --- | --- |
| `params.expose` | Add a control identity and optional label. |
| `params.unexpose` | Remove a control identity, including a stale one. |
| `params.setLabel` | Set or clear a control label. |
| `params.move` | Reorder the exposed control registry. |
| `previews.expose` | Add a preview identity and optional label. |
| `previews.unexpose` | Remove a preview identity, including a stale one. |
| `previews.setLabel` | Set or clear a preview label. |
| `previews.move` | Reorder the exposed preview registry. |

## Layout model

Authored layout is optional document data stored at:

```text
doc.ext['dinkster.appLayout']
```

The supported shape is version 1:

```json
{
  "version": 1,
  "desktop": {
    "items": [
      {
        "id": "intro",
        "kind": "text",
        "role": "heading",
        "text": "**Portrait** controls",
        "x": 0,
        "y": 0,
        "w": 12,
        "h": 2
      },
      {
        "id": "settings",
        "kind": "group",
        "title": "Settings",
        "children": ["steps"],
        "x": 0,
        "y": 2,
        "w": 6,
        "h": 3
      },
      {
        "id": "steps",
        "kind": "control",
        "ref": { "graphId": "root", "nodeId": "sampler", "inputId": "steps" }
      },
      {
        "id": "result",
        "kind": "preview",
        "ref": { "graphId": "root", "nodeId": "preview" }
      },
      {
        "id": "generate-base",
        "kind": "queue",
        "label": "Generate base",
        "targets": [{ "graphId": "base", "nodeId": "save" }]
      }
    ]
  },
  "mobile": {
    "customized": true,
    "items": [],
    "order": ["result", "intro", "settings"]
  }
}
```

Every item has a stable string id. Version 1 supports:

- `control`: a reference into `dinkster.exposed`.
- `preview`: a reference into `dinkster.exposedPreviews`.
- `queue`: a labeled partial-run action with one or more definition-based
  `{ graphId, nodeId }` targets.
- `text`: restricted Markdown with a `heading`, `body`, or `caption` role.
- `group`: a titled card with an ordered list of child item ids.

Groups do not nest. A group child is rendered only inside its group and cannot
have grid coordinates. Items that are not referenced by a group remain at the
top level.

Queue targets use graph-definition identity, matching App View controls and
previews. At activation, each target expands to every reachable occurrence of
that definition node and the result is submitted through the existing
occurrence-qualified partial execution scope. This means one button can run the
same stage in two instances of a shared subgraph definition. Stale targets stay
visible and removable in Arrange mode; available targets on the same button
remain runnable. A button with no available target is disabled.

Arrange mode adds queue buttons from the content palette. Each placement has an
editable label and a checkbox target picker. Use mode shows Ready, Submitting,
Queued, Running, Completed, Failed, or No available targets beside the action.
When a document has no valid queue placement, App View retains the fixed full
workflow Queue button. The fixed action is omitted as soon as the document has
an authored queue placement.

### Desktop flow and grid

Top-level items without grid coordinates render in flow order below the grid.
An item enters the grid only when all of `x`, `y`, `w`, and `h` are valid safe
integers. The grid has 12 columns, 64 px rows, and 12 px gaps:

- `x` is 0 through 11.
- `y` is non-negative.
- `w` is 1 through 12 and `x + w` cannot exceed 12.
- `h` is at least 1.

Placement collision resolution keeps the edited item fixed, pushes colliding
items down, and compacts unaffected items upward. Resolution is deterministic
and overlap-free. A null grid returns an item to flow. Moving an item into a
group also clears its grid placement.

Grid DOM order is row-major by `y` and then `x`, not storage order. Flow items
follow in authored order. Group children follow their child-id order. This
makes reading, focus, and visual order agree.

### Mobile ordering

Use mode switches to a single full-width column below 640 px of App View
editor-container width. The rule is container-based, so a narrow split,
workflow pop-out, and narrow browser use the same presentation.

Before customization, mobile order is derived on every read: desktop grid
items in row-major order, followed by desktop flow items. The first mobile move
stores `customized: true` and an id-only `order`. Content stays in
`desktop.items`; mobile does not duplicate text, titles, refs, labels, or grid
coordinates. Resetting resumes automatic desktop-derived order. The `items: []`
field remains in version 1 writes for compatibility.

Unknown and duplicate mobile ids are skipped. Current top-level ids missing
from a customized order are appended in automatic order. A missing or malformed
mobile container falls back to automatic order without invalidating desktop
layout.

### Text and stale placements

Text supports only `**bold**`, `*italic*`, and HTTP or HTTPS links. Rendering
builds text and anchor nodes directly; raw HTML is not accepted. Unsupported
markup remains literal, and non-HTTP links remain plain text.

Promoted controls and previews without explicit layout items append after the
authored layout in registry order. A layout reference that no longer resolves
is skipped in Use mode and shown as an inert status row with its reason and a
remove action in Arrange mode. Malformed items, duplicate item ids, partial or
invalid coordinates, unknown fields, and unsupported item kinds are skipped or
degraded to flow without making the workflow invalid.

Subgraph localization updates control and preview references. Definition
cleanup removes placements owned by deleted definitions and prunes their mobile
ids.

## Layout commands

Every authoring gesture is one serializable command and one undo step:

| Command | Purpose |
| --- | --- |
| `app.layout.add` | Add a text, group, control, or preview placement. |
| `app.layout.remove` | Remove a placement and its group/mobile references. |
| `app.layout.move` | Reorder or move a placement into or out of a group. |
| `app.layout.setGrid` | Set or clear a top-level grid rectangle. |
| `app.layout.setText` | Change text content or its semantic role. |
| `app.layout.setGroupTitle` | Rename a group. |
| `app.layout.setQueue` | Relabel a queue placement or replace its definition targets. |
| `app.layout.moveMobile` | Customize or change mobile order. |
| `app.layout.resetMobile` | Resume automatic mobile order. |

Layout commands patch individual placements so independent collaboration edits
can rebase without replacing the complete layout. Exposure and layout data
persist through save, reload, pop-out, and shared sessions.

## Interaction and accessibility

Every Arrange affordance is reachable without a pointer. Flow rows, groups,
text placements, stale placements, previews, and mobile placements expose
named buttons and form controls. Lists and list items describe placement
relationships without changing the visual chrome.

Grid placements support pointer drag and resize plus keyboard operation:

- Arrow keys move a placement one cell.
- Shift+Arrow keys resize the placement.
- Dedicated move and edge/corner handles expose the applicable shortcuts.
- Repeated keydowns form one gesture and commit once on keyup.
- Escape cancels an uncommitted move or resize and restores the prior grid.

Mobile placements support pointer drag, named move buttons, and focused
ArrowUp/ArrowDown gestures. Repeated keys commit once on keyup, and Escape
cancels the gesture. Focus remains on the operated placement after a commit or
cancel.

Grid and mobile keyboard gestures announce their pending placement through
polite live regions. Preview surfaces are labelled regions with polite live
updates, rate-limit streaming-frame announcements to one every two seconds,
and announce each settled preview source immediately. Preview media has a
content label. Stale placement list items include the reason in their
accessible name, and stale rows expose status text.
Responsive presentation changes wait for a focused placement draft to commit
or blur, preventing focus loss and discarded input.

## Controls and previews

Controls resolve against the live document and schema registry. INT, FLOAT,
STRING, BOOLEAN, COLOR, and static or remote COMBO inputs use product controls
and validate through the widget registry before dispatching `node.setValue`.
Connection-driven inputs, selector-derived values, and kinds without an inline
App View editor are read-only with an explanation. Missing graph, node, schema,
or input identities render as stale rows.

Registered `WidgetView` implementations may add their literal `drawCompact`
presentation. App View retains its inline form as the editing surface and does
not host `WidgetView.editorUi`.

Preview rows use the same source precedence and cache as in-node previews:
live sampling frame, executed image output, marked rendition, producer peek,
selected asset, then recorded string. Image and video previews render a
caption bar below the media - never overlaid on it - with the pixel
dimensions when known and the multi-output pager count. Execution-store
changes update visible
previews in place. A promoted preview with no content says that its preview
will appear after execution. Missing nodes or unavailable preview capabilities
render as stale rows in Arrange mode.

## Coverage map

- `core/test/exposed-params.test.ts` and
  `core/test/exposed-previews.test.ts`: tolerant reads, canonical command
  writes, identity, labels, ordering, stale removal, and undo patches.
- `core/test/app-layout.test.ts`: versioned tolerant reads, grid validation,
  collision resolution, flow/groups/text, automatic and customized mobile
  order, command inverses, localization, and definition cleanup.
- `app/test/app-view-rows.test.ts`, `app/test/app-view-text.test.ts`, and
  `app/test/AppWidgetPreview.dom.test.tsx`: live row resolution, restricted
  Markdown, preview resolution, stale states, remote options, and compact
  widget drawing.
- `app/test/editors.test.ts`: editor switching and transient Arrange state.
- `app/test/collab.test.ts`: two shared App State clients receive a complete
  App View layout and preserve concurrent text and group-title edits through an
  exact-base stale rebase.
- `e2e/tests/app-view.spec.ts` and `e2e/tests/app-view-previews.spec.ts`:
  exposure, input editing, preview updates, Use/Arrange behavior, labels,
  reordering, and stale recovery.
- `e2e/tests/app-view-layout.spec.ts`: text, groups, grid pointer and keyboard
  gestures, collision handling, responsive mobile presentation, mobile
  reordering, pop-out, reload, and stale layout recovery.
- `e2e/tests/app-view-accessibility.spec.ts`: DOM/reading order, names, pressed
  states, live regions, keyboard reachability, focus retention, and Escape
  cancellation across desktop and mobile presentations.
- `e2e/tests/app-view-journey.spec.ts`: complete exposure, authoring, grid and
  mobile layout, Use mode, pop-out, full-document reload persistence, and
  screenshot evidence.

# Design System

## Browser icons

Browser tabs use the approved colored D in `branding/favicon/`. Its square
canvas fits the D's horizontal edges and centers it vertically; the artwork,
colors and proportions match `branding/svg/dinkster-symbol-color.svg`.
Shared branding and desktop icons retain their original framing.

The app serves `/favicon.ico` plus SVG and 32px PNG references. The 180px
Apple touch icon uses the same D at 90% width on opaque dark `#111316`;
manifest icons use transparent 192px and 512px exports. Vite serves those files
in development and includes them in production builds. Regenerate with
`python branding/sources/export_favicons.py --inkscape /path/to/inkscape` using
Inkscape 1.2.2. The exporter changes only the SVG viewBox, renders each PNG
from that vector and packages the 16-256px PNGs into ICO without resizing.

## Source of truth

`branding/tokens/dinkster-colors.json` owns the dark/light palette and brand
identity values. `dinkster-components.json` beside it owns spacing, typography,
regular/bold weights, shape, motion, interaction and layout values. The private
`@dinkster/branding` package exports them as `@dinkster/branding/palette` and
`@dinkster/branding/components`. `packages/core/src/ui/tokens.ts` imports these
with native JSON type attributes and projects the semantic roles for the app
and canvas. It exports:

- `semanticDesignTokens`, the host token model;
- `semanticCssVariables` and `semanticCssRoot`, the CSS projection injected
  into the document head before application modules; and
- `canvasSemanticTokens`, the bounded typed subset available to Canvas code.

`pnpm build:ui` builds `packages/ui/dist/dinkster.css`, its relative `fonts/`
assets (including the font license), and `manifest.json` with the package
version and SHA-256 of each file. The framework-free stylesheet is exported
as `@dinkster/ui/styles.css`. Its classes live only in `packages/ui/styles.css`;
the build adds the same semantic variables the app uses and expands the shared
768px breakpoint. Consumers copy the entire distribution, not the CSS alone.
Use `dinkster-root` on the page root and `data-density="site"` for 14px site
text; the default density is the app's 13px. The full-width shell has a 56px
top bar, 240px sidebar, 720px content column (960px for tables) and 32px page
padding. Below the standard breakpoint, the sidebar is hidden unless opened.
Components own the corresponding menu, form, dialog and notification behavior;
CSS does not implement keyboard interaction or confirmation policy.

The site geometry scale is `siteLayout` in `dinkster-components.json`, projected
as `--dinkster-site-*` variables only under `data-density="site"`. It defines the
1040px centered shell, 220px navigation, 36px fields and main buttons, 28px row
buttons (32px on mobile), 8px panels and 6px controls, along with the site menu,
authentication card and provider-logo dimensions. `siteInteraction` supplies the
unitless 0.14 status tint. These variables do not override app geometry or type.
Site components consume the scale through the shared stylesheet; a token
addition alone does not change a rendered component.

## Shared SolidJS components and gallery

`branding/tokens/design-rules.json` owns button roles/fills, message behavior,
notification lifetime, sentence case and hidden unconfigured services. It names
tokens rather than colors and is exported as `@dinkster/branding/rules`. The
portable distribution includes it in the SHA-256 manifest.

App action labels, settings categories and panel headings use sentence case.
Canvas context-menu actions set their labels at the registry source, including
reset actions and plural counts. Proper names, acronyms and user-authored node,
net and selector branch names retain their original capitalization.

`@dinkster/ui` exports the script-enabled components from `packages/ui/src`.
They use only the shared stylesheet, not app-specific CSS. Import the stylesheet
alongside the components. `pnpm --filter @dinkster/ui dev` serves the live dark
component gallery on loopback port 5276 after `pnpm build:ui`; production gallery
files are in `packages/ui/dist/gallery`. The gallery is an isolated reference,
not an account service or a replacement for the app.

The Canvas pages include an Attached tabs proposal at controls and content
zoom in both themes. Each example shows production chips (Before) beside the
opt-in renderer layout: small header marks, bounded identity tabs above, run
details below, crowded icon strips and an overflow count. Hover reveals a strip
label; clicking a tab or overflow opens its full details. Tabs are 16px high
with 11px text and a 12px side inset, from the typed canvas tokens. A tab is as
wide as its padding, icon and measured text, the text capped at 120px; paint,
pointer targets and bounds share that measured width. Production continues to
use chips. Candidate tab icons and labels
choose a light or dark foreground against their actual fill, including the
hovered fill.

- `ProductShell` owns the frame and responsive navigation. With site density,
  its 1040px centered frame contains 220px navigation and a 32px content gap.
  With app density the sidebar spans the window's left edge. In both densities
  the content column is centered in the space beside the navigation (in the
  whole window without it); headings, text and content inside the column stay
  left-aligned.
  Its wordmark, Account product label and 32px account circle share that frame.
  On phones the navigation is a 240px overlay aligned 8px from the window edge
  and 4px below its toggle button; it closes on an outside press, Escape or a
  choice without moving the page.
  App density retains the full-width frame. The top bar stays while scrolling. Its caller
  changes `currentHref` and content synchronously in `onNavigate`, showing
  `ProductLoading` until data arrives. Selecting from open mobile navigation
  moves focus into the persistent main region, so loading and loaded content
  do not leave focus in the hidden sidebar. Desktop navigation keeps its link
  focused. Navigation retains real link targets.
  `ProductPage` owns the page title and the normal/table content width;
  `ProductSection` owns a titled section inside it.
- `ProductButton` names `intent` as add/remove/neutral and `fill` as
  solid/outline, and accepts native button attributes. `ProductIconButton` is
  the quiet, square icon-only control with a required accessible label and the
  same attributes. `pending` shows the spinner and ignores presses under a
  stable name. A pending button, and a button that becomes disabled while it
  holds keyboard focus, stays focusable and is announced as unavailable, so
  focus is never dropped to the page. `ProductLink` is the text link.
  The variant gallery is deliberately not a real screen's action hierarchy.
- `ProductField` binds its label, description and error to its child control;
  an error carries the error icon. Pass its attributes to `ProductTextInput`,
  `ProductTextArea` or `ProductSelect`.
  Native checkbox/radio behavior remains in `ProductCheckbox`/`ProductRadio`.
- `ProductForm` takes an initial record of text and true/false values once per
  mounted form. Its render callback receives values, a field setter, dirty and
  pending state. Save and Undo changes are disabled until the values differ
  from the saved baseline. A resolved save updates that baseline. A save that
  resolves `false` keeps the edits and shows nothing itself, for a refusal the
  caller shows under a field. A rejected save keeps the edits and shows a
  dismissible error until a later save succeeds. The browser's own validation
  messages are off; field problems are shown by `ProductField`.
  Changing to another record mounts a new form.
- `ProductMenu` owns click, outside-click, focus-leave and Escape dismissal,
  keyboard item movement and opener focus restoration. Disabled items are
  skipped; a disabled-only menu remains keyboard-dismissable. The menu aligns
  to its trigger's left edge, or to its right edge when it would not fit, and
  then uses the app's viewport algorithm from `@dinkster/core/floating-surface`
  to clamp and to flip above when needed. Scroll outside or resize dismisses
  the menu rather than leaving a stale anchor. Its document listeners exist
  only while it is open. Item text follows its intent. Removal callbacks open a
  confirmation. `ProductAccountMenu` shows the person's initial and name on a
  borderless trigger (the initial alone below the breakpoint), reads out name
  and email with the menu, and invokes Sign out immediately.
- `ProductNotice` is standing information without a dismiss button, including
  its warning tone for QA environments.
  `ProductErrorBanner` is dismissed explicitly or by the caller after success.
  `ProductToast` is the corner region for success feedback. Keep one mounted
  and pass each success as a new `notification` object, so the region exists
  before its text. A notification can be dismissed at once and otherwise
  leaves after five seconds, counted from when the pointer and keyboard focus
  have both left it.
- `ProductConfirmation` orders the title, consequence, solid action and Cancel.
  Sites use it as page content. Inside `ProductDialog`, omit the confirmation's
  duplicate title and let the dialog provide it. `ProductDialog` provides native modal inertness,
  Escape dismissal, keyboard focus wrapping and opener restoration for apps;
  while `pending` it cannot be dismissed, however often Escape is pressed.
- `ProductList`/`ProductListRow` and `ProductTable` provide bordered data surfaces.
  `ProductEmptyState` centers the approved D mark with a sentence and optional
  action in its column. `ProductLoading` is one status region with its label;
  `ProductSpinner` alone announces its label; `ProductIcon` provides lucide
  icon anatomy.
- `ProductFacts` renders labeled account facts as a definition list; values may
  contain shared links. `ProductCodeBlock` preserves selectable multiline text
  and wraps long values without widening the page. `ProductCopyValue` adds a
  neutral Copy button, holds it pending until the clipboard write finishes,
  and shows a dismissible error on refusal. Its caller owns success feedback
  through `onCopied` and must discard show-once secrets when the page leaves;
  the component stores nothing. `ProductDisclosure` uses native details/summary
  keyboard behavior for inactive history, initially closed unless `open`.
  `ProductQrCode` preserves the supplied image's aspect ratio and quiet zone,
  with required alternative text; the service owns enrollment content.
  These patterns appear on the gallery's Account data page.
- Passing an empty navigation list to `ProductShell` removes the sidebar and
  mobile toggle without centering the content in a card. The gallery's
  signed-out shell link demonstrates this state.
- The components supply short texts themselves, such as Save, Cancel
  and Sign out. `ProductStringsProvider` replaces any of them for its subtree,
  for another language; `defaultProductStrings` lists them.

The gallery names the components each sample shows, in monospace under its
heading, so a sample can be copied by name.

`reportProductEvent` is the single telemetry entry point. Its types permit only
page views, fixed action outcomes, and load/interaction timings for named
product routes. There is no provider, network call, storage, arbitrary string
payload, workflow content, prompt or filename. The function currently does
nothing; adding transport requires approval of the provider and event list.

`pnpm --filter @dinkster/ui test:browser` exercises the production gallery in
Chromium, with desktop/mobile screenshots and menu, form, toast, dialog and
navigation contracts, and runs axe on every page at rest and with a menu,
toast, refused form and dialog showing. `pnpm test:visual` includes these
checks. Keyboard focus, hover and pressed states are real browser states, not
simulated CSS classes.

### Centered site patterns

Use these inside `data-density="site"` with the shipped stylesheet:

- `ProductAuthCard` takes `title`, `children` and optional `footer`. It owns a
  centered 440px card with 28px padding and a 40px wordmark, without top bar or
  navigation. It does not own submission, OAuth or session logic.
- `ProductProviderButton` takes `provider` (`github` or `google`), translated
  children and ordinary button attributes. Its bundled SVG logo is 20px; the
  button is 220px wide and 36px high. Put providers after the form and "or".
- `ProductPanel` groups fields or facts inside one bordered 8px panel.
  `ProductField` children become label/control rows; controls are at most
  360px wide, and stack below labels on phones. Keep Save outside the panel
  in `dinkster-actions`, 16px below it and at the right.
- `ProductStatusPill` takes `tone` (`good`, `warning`, `problem`, `neutral`) and
  translated children. It is for value/item statuses, not row descriptions.
  Semantic status colors have a 14% tint; neutral uses the shared hover gray.
- `ProductAccountMenu.pictureSrc` accepts an optional same-origin HTTP(S)
  picture. Null, disallowed origins and load failures keep the name initial.
  No upload or avatar-setting behavior is provided. The site trigger has no
  visible name or caret, and its menu aligns right edges with a 4px gap.
- Site selects and disclosures retain native keyboard behavior and draw
  Lucide chevrons rather than browser triangles.

Gallery routes `#site-security` (alice and the reference Security rows),
`#site-profile` (grouped fields/Save/facts), `#site-keys` (status/disclosure),
and `#site-card` (centered sign-in/providers) exercise the shared patterns.
The Security route has computed-geometry and interaction checks at 1280,
1440, 1920 and 390px; screenshots are captures, not an approved baseline.
The canvas gallery uses app density and its full-width shell rather than the
centered account frame; as on every shell page, its content column is
centered beside the sidebar.

## Shared design build checks

`pnpm check:design-system` checks the shared component source and gallery against
`packages/ui/styles.css`. The package build runs the same check before emitting
files, and `pnpm ci:fast` runs both the check and its command-line regression
cases. A violation exits nonzero with its source path and line.

- Colors and font sizes come from tokens, not source literals. The stylesheet
  cannot define replacement custom properties; token definitions belong in
  `branding/tokens`.
- The shared stylesheet is the only CSS source. Imports of other stylesheets,
  JSX/HTML inline styling and imperative DOM styling are rejected, except
  measured placement geometry. Native element attribute spreads are limited
  to the named primitive implementations; screens pass native attributes
  explicitly so style/class props cannot bypass the check.
- Class names must be static names defined by that stylesheet. Conditional
  choices between shared classes are supported; caller-provided class strings
  and `classList` are not.
- Native buttons, inputs, selects, textareas and dialogs belong only in the
  enumerated shared primitive implementations. Screens use Product components.
  The check also covers imperative control creation and class/style attributes.

`--source <directory>` replaces the default source roots and may be repeated
when checking another adopter. Paths are relative to the command's working
directory; the stylesheet and primitive identities remain repository-owned.
The legacy app's existing `check:raw-controls` ratchet remains independent until
its shared-system adoption. Site sources are checked where their frontend
artifact is built; the Python service does not need Node to consume it.

## App semantic projection

The document's `data-theme="light"` selects the light CSS projection; dark
is the default. Settings -> Dinkster -> Theme switches both DOM and canvas
chrome immediately and persists across startup and Desktop preparation.
Primary actions use cyan with ink text, never white text on
cyan. Semantic danger reads the theme's danger entry, not identity coral.
Status foregrounds use their semantic status colors on panel surfaces.
Muted text on raised surfaces retains the brand guide's documented contrast
exception (dark 3.85:1, light 4.19:1); normal body copy uses secondary text.
Dark-theme danger text on the hover background retains the brand guide's second
exception (4.40:1) while a danger item is hovered or holds keyboard focus.

Deliberate literal-color exceptions are color-picker spectrum ramps and
editable color presets/defaults, user-authored media/GLSL/mask colors, calculated
black/white contrast labels, and graph data-type/link/execution-mode semantics.
These represent content rather than shell styling. Elevation shadows retain
neutral black alpha inside the token source. Canvas and minimap chrome share
the active renderer theme; graph data-type and link meaning do not switch.

Redesigned components consume semantic roles rather than copying token values.
Literal colors and dimensions are reserved for user data, media content,
calculated geometry, and other values that are not product styling. A surface
adopts the system when it replaces and deletes the old styling.

Schema catalogs, extension snapshots, mount discovery and collection pages
have a 30-second request deadline. A stalled read leaves loading for an error
with Retry; cancellation also prevents a late catalog from being committed.
The shell's connection display includes schema and mount HTTP failures rather
than treating a live WebSocket as sufficient. Library, Assets and Outputs
show ProductEmptyState alerts for those metadata failures and retry the failed
reads. Backends retains its schema retry and provides an output-mount retry.
Successful reads clear the corresponding error; a failed initial mount load
does not continue to claim it is loading. Concurrent mount readers follow the
newest request's snapshot or failure, so a late older response cannot restore
removed mounts in another panel. These presentation changes do not close the
WebSocket or change backend wire contracts.

Library collection and selection states, asset discovery and collection states,
and the output rail use ProductEmptyState for empty, loading and error content.
Collection request errors retain an enabled Retry action after the request
settles; a retry re-reads the selected source without changing its selection.
The Assets selection rail and single/multiple asset pickers use the same
ProductEmptyState instruction cards when nothing is selected. Picker staging,
upload limits, selection order, Apply and Cancel remain editor-owned.
Import resolution uses ProductEmptyState for absent replacement candidates.
The original asset name, unresolved radio choice, reason and decision footer
remain visible; accepting an unresolved name leaves its imported value intact.
Output states preserve the distinction between an absent execution, waiting
execution, retained-output loading, missing owner and failed execution.

Settings search and subgraph cleanup use the same ProductEmptyState title and
hint presentation. Cleanup distinguishes an unavailable workflow, no unused
definitions and no retained definitions without private success-border styling.
The Settings result-count announcement and Escape-to-clear behavior remain
independent of the empty presentation.

Canvas value-source and execution-selector popovers use ProductEmptyState when
their target is unavailable. The popover keeps its focus and anchor until focus
leaves it. Problems uses the shared empty card without a private color override.

Collaboration discovery uses ProductEmptyState for unavailable, loading, empty
and error results, and for a workflow that is not shared. Loading announces
politely and errors are alerts. Refresh remains available after a failed read;
retrying clears the error when discovery succeeds. The unshared workflow keeps
its focus target and explanation of how to share from the tab menu.

App view uses ProductEmptyState when nothing is exposed and when an arrangement
group has no children. The empty group retains its list-item semantics and
instructions for moving content into the group.

Template gallery uses ProductEmptyState for loading, failed reads, empty catalogs
and searches without matches. Failed reads retain Retry, and the empty folder
explanation preserves the permission-gated server-path form below it.

The Focused panel uses ProductEmptyState for an absent document and a context
without problems. Context selection, problem filtering and canvas navigation
remain independent of the empty presentation.

Badge popovers use ProductEmptyState when error, log or problem details are
absent and when subgraph or replacement data is unavailable. These are missing
detail messages, not new runtime alerts; popover focus and existing actions
retain their behavior.

The region iteration inspector uses ProductEmptyState for absent iteration
activity, nodes without outputs, unavailable execution owners and loading.
Retained-value refusals keep their reason and explanation in a neutral status
card, not an execution error alert. Selection and stale-read cancellation
remain owned by the inspector. Progress and reconciliation updates for the same
execution and workspace tab-list refreshes preserve the selected iteration and
body node. Switching tabs, region occurrences or executions starts a new
inspection.

The workflow queue popover uses ProductEmptyState when its owner has no jobs.
Queue activation, disclosure, keyboard navigation and Escape focus restoration
remain owned by the queue control.

Search feedback in the asset picker, node palette and universal search uses
ProductEmptyState for loading, no matches and provider failures. Loading is a
polite status with a decorative spinner that respects reduced motion; provider
failures are alerts. Result selection and provider isolation remain owned by
the search surfaces.

Declarative host UI accepts semantic tones only. The app renderer maps those
tones to host-owned text, status, and action classes; extension trees cannot
provide classes, style, theme values, tags, or elements.

Product forms use one host-owned language across settings, backend controls,
ordinary widget editors, and modal flows. `ProductField` associates the label,
optional help or validation message, control, and row actions. `ProductNotice`
provides semantic info, warning, error, and polite-status presentation.
`ProductActionFooter` keeps decision actions and optional status copy in one
wrapping footer that stacks at narrow widths. These primitives own structure
and semantic-token styling only; callers retain value, validation, command,
and request lifecycle ownership.

`ProductTextInput` accepts `density="canvas"` for an opt-in 24px field with
12px text from the shared tokens. The default app field remains 40px and the
site field remains 36px. The canvas variant retains native string values,
`inputMode`, field associations, validation, focus, disabled and read-only
behavior; it does not parse numbers. Core widget rows in the gallery shows
the actual primitive beside the default field, with exact integer strings,
decimal input and unavailable/invalid states. Canvas editors do not adopt it.

## Product primitive catalog

Every host control uses one of these primitives. A native control or styling
literal may remain only when it is recorded by `pnpm check:raw-controls` and
linked to tracked work. New exceptions and increases are rejected.

The check rejects stale allowlist entries, including files with zero remaining
raw controls, and `rawControl` or `cssLiteral` ceilings above the current total.
After removing controls or literals, run `pnpm check:raw-controls:write` to remove
stale entries and lower ceilings. Write mode never permits count increases.

`packages/app/src/styles.css` is the ordered entrypoint for the surface files
in `styles/`. Keep imports in cascade order: base and product controls, search
and modals, canvas and widget surfaces, panels and library, shell and execution
log, widget assets and App view, collaboration and boot, then image editor.
Keep each surface's responsive and reduced-motion rules beside its rules;
do not regroup selectors across files if that changes override order.
The `cssLiteral` entry for `styles.css` aggregates the entrypoint and every
CSS file under `styles/`, so extracting a surface cannot bypass the ratchet.
Standalone component stylesheets keep their existing ownership and scope.

The executed image viewer uses compact `ProductButton` controls and grid tiles,
`ProductNumberInput` for independent left/right image selection, and
`ProductSlider` for the compare split. Selected modes use the primary variant.
Number inputs can normalize committed text with `normalizeCommit`; the viewer
restores blank input and clamps/truncates image numbers before displaying them,
including when the selected image does not change. Grid and toolbar CSS owns
layout only; shared primitives own control colors, borders and focus states.

Document-backed number fields use `onCommitAsync` instead of synchronous
`onCommit`. It returns final acceptance and receives a `stillWanted` guard
for caller-owned notices. While pending the field is read only and steppers
are disabled; refusal retains exact text for explicit Enter retry. Escape
restores the controlled value without cancelling the command. Callers present
errors, and `onDraftActive` lets the owning layout preserve unaccepted drafts.
Synchronous local-draft and continuous `onInput` behavior is unchanged.

Document-backed `ProductSelect` callers use `onSelectAsync` for final acceptance
instead of synchronous `onSelect`. The menu stays open with a busy state while
pending, ignores duplicate choices and retains the active option after refusal.
Acceptance closes it. The callback receives a `stillWanted` guard for notices
after dismissal; Escape, Tab and outside clicks dismiss without cancelling the
submitted command. Synchronous select callers keep their immediate behavior.
Option IDs preserve pointer targets across inventory refreshes and reordering;
labels, values and disabled state follow the current inventory.

The compositor editor uses the same buttons, number inputs, checkboxes,
sliders, text input and select controls as the Image document workspace.
Layer selection and flips expose pressed state with the primary variant.
`ProductColorInput` keeps the native color picker and forwards native input
props while using shared input styling; the compositor retains lowercase
color storage. Recipe edits, preview geometry and apply/refusal rules remain
owned by the editor, not by the controls.

The compositor uses ProductEmptyState when no target is open or when the
selected run has no compositor sources. The latter keeps the explanation that
the layer stack stays in the graph; Cancel remains enabled and Apply stays
disabled until runtime data supplies a configurable recipe.

The GLSL editor uses ProductEmptyState for missing targets, absent runtime
inputs and unavailable browser previews. Preview refusals stay neutral while
their diagnostics remain alerts; shader editing and native execution remain
independent of whether the browser can display a preview.

Runtime settings uses compact `ProductButton` actions and `ProductTextInput`
fields for worker arguments, logger overrides and textual memory values.
`ProductField`, `ProductNotice` and `ProductActionFooter` retain the form
structure; numeric, slider, select and checkbox editors use their existing
Product controls. Native form submission, disabled fieldsets, grants, reset
and refresh behavior remain owned by the runtime settings panel.

The output descriptor editor uses compact `ProductButton` actions,
`ProductTextInput` name/ID fields, `ProductTextArea` stored JSON and the existing
`ProductSelect` type picker. Semantic tokens style its entry and stale-link
containers. The editor retains draft commits, profile probing, read-only
metadata, exact stored JSON and stale-link disconnection behavior.

Disabled primary buttons use the neutral raised surface and secondary text
without fading their labels. The missing accent fill distinguishes them from
enabled primary actions while keeping the action name readable in both themes.

| Primitive            | Contract                                                                                                                                          | Adopted surfaces                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ProductButton`      | Native button props and caller-owned aria-busy; primary, secondary, danger and ghost variants; loading disables activation and exposes busy state | Learn, Node help, Activity, Execution log, Problems, Desktop management, mounts, audio recorder and Image document empty state |
| `ProductTextInput`   | Native text input props and invalid state                                                                                                         | Learn, Desktop management and mounts                                                                                           |
| `ProductFileInput`   | Hidden native file input; forwards ref, accept, multiple and change events to a separately labelled activation button                             | Image document import, layers and masks                                                                                        |
| `ProductTextArea`    | Native textarea props and invalid state                                                                                                           | Desktop management                                                                                                             |
| `ProductSelect`      | Labelled combobox/listbox with controlled selection, keyboard navigation and focus restoration                                                    | Settings, Execution log and Desktop management                                                                                 |
| `ProductPanelHeader` | Level-two title, optional headingId for section labelling, count and actions                                                                      | Problems, Backends, Memory and Collaboration                                                                                   |
| `ProductEmptyState`  | Title, hint, icon and action slots; empty, polite loading and alert error states                                                                  | Learn, Node help, Activity, Execution log, Problems, Image document and Memory                                                 |
| `ProductListRow`     | Leading, primary, secondary and action slots with selected state                                                                                  | Activity and Execution log                                                                                                     |
| `ProductTable`       | Native table semantics in a labelled keyboard-scrollable region, with optional caption and sticky header                                          | Data-heavy product surfaces                                                                                                    |

Backends and Memory use the shared panel header without local title-size or
padding overrides. The add-backend form uses `ProductField`, `ProductTextInput`
and a primary `ProductButton` in `ProductActionFooter`; discovery errors are
`ProductNotice` alerts associated with the address input. Memory uses
`ProductEmptyState` for missing device, consumer, detail and lease facts. An
initial telemetry failure replaces loading with an error, without claiming
that any previous telemetry has been retained.

The raw-control baseline after these adoptions is 441 controls, 70 inline-style
attributes and 423 CSS color/radius literals. The largest remaining control
surfaces are App view (60), Canvas host overlays (39), Image document's editor
controls outside its converted empty state (36), App shell (20), Executed image
viewer (18), Compositor editor (15), Runtime settings (13), and Video edit,
Output descriptor and Combo editor (12 each). Their counts may shrink but may
not grow. This inventory is a migration queue, not a second component system.

## Token model

| Family      | Roles                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Space       | 4, 8, 12, 16, 24, 32 px                                                                         |
| Type        | metadata 11/16, canvas 12/16, body 13/20, section 15/20, title 18/24; regular 400, bold 700                   |
| Surface     | canvas, panel, inset, raised, selected                                                          |
| Text        | primary, secondary, muted, disabled, inverse, on-selected                                       |
| Border      | subtle, strong, focus, selected                                                                 |
| Meaning     | accent, success, warning, danger, info; each has foreground, background, and border             |
| Shape       | 4 px small, 6 px control, 8 px card/panel, capsule for tags and removable active filters only   |
| Interaction | 32 px compact control, 40 px primary input, 24 px canvas input, 2 px focus ring, hover, pressed, selected, disabled |
| Motion      | fast, standard, reduced-motion duration, one product easing curve                               |
| Elevation   | low and high only                                                                               |

Canvas code receives space, relevant type roles, surfaces, text, borders,
meaning, shapes, and bounded interaction state. It does not receive DOM
elevation or motion tokens. DOM surfaces consume the generated
`--dinkster-*` variables.

`pnpm check:raw-controls` also rejects undefined `--dinkster-*` references in
app TypeScript and every app stylesheet. Use a name from the shared projection
or a local CSS declaration. Compact controls use `control-compact-height`,
caption text uses the metadata type scale, and monospace labels use `font-mono`.

The application bundles Noto Sans regular, bold and italic and Noto Sans Mono
in `packages/app/public/fonts`, with the SIL Open Font License beside them.
DOM and canvas text share these faces through the type tokens. Font faces use
`font-display: block`; startup waits for them before canvas text measurement.
Generic sans-serif and monospace families are fallback glyph sources only.
To replace the fonts, replace the woff2 assets and license, update
`packages/app/src/fonts.css`, the font loads in `main.tsx`, and the two family
tokens in `packages/core/src/ui/tokens.ts`, then regenerate the visual baselines.
These woff2 files are lossless conversions of Debian `fonts-noto-core` and
`fonts-noto-mono` version `20201225-2`, made with FontTools 4.67.0 and Brotli 1.2.1.

Selected surfaces use `text.onSelected` for foreground content. Token objects
and their projections are recursively frozen at runtime.

The shared application shell consumes this projection directly: top bar,
workflow tabs, activity rail, panel hosts, the right zone's tab row, status
bar, focus rings, and responsive sheets use semantic surface, text, border,
space, type, shape, interaction, motion, and elevation roles. Feature panel
bodies do not supply private shell headers, tab chrome, or resize chrome.
Status-bar Product buttons retain their shared colors, borders and focus
behavior but use intrinsic metadata-line height without vertical padding to
preserve the 28 px desktop footer and its canvas space.
Desktop status groups use the shared 8 px gap so full metadata and contribution
labels fit at 1280 px with wider system fonts. Compact status groups retain
their wrapping layout.

Transient product UI shares `.floating-surface` for root chrome and uses
`placeFloatingSurface` for block, inline, or point anchoring. Universal search
uses that chrome while retaining its search-specific dialog geometry. Its
host-owned `SearchInput`, `SearchResultGroup`, `SearchResultRow`, and state
components define searchable hierarchy without accepting provider markup or
styles. The node palette composes the same vocabulary with its category
browser, type-filter dialogs, schema preview, and Canvas placement lifecycle.
`SearchInput` also owns optional clear-button focus restoration and compact or
primary presentation. Assets supplies only its query behavior and result copy;
it does not fork search chrome.
The ASSET widget dialog composes the same `SearchInput` and state vocabulary
inside its shared `CollectionPanel`, uses `ProductNotice` for validation and
source failures, and uses `ProductActionFooter` for upload status and decisions.
Its compact requirements, current selection, semantic preview fallbacks, and
model-variant facts remain product presentation; exact AssetRef identity,
compatibility, source paging, uploads, and command semantics remain with their
existing owners.
Context-menu children and seed-controller options use the same semantic text,
surface, border, spacing, type, shape, and interaction roles. At reduced motion,
loading indicators and animated switches use the zero-duration motion role.
Seed-controller menus use measured point placement so the complete menu stays
inside the canvas as its bounds change, with internal scrolling on short stages.

The bounded Canvas projection is available and tested. The renderer consumes
it through the `DesignTokens` adapter rather than maintaining a second color
authority.

## Canvas visual-system contract

### Token projection

`packages/core/src/ui/tokens.ts` is the only semantic token authority.
`CanvasSemanticTokenProjection` selects the roles available to Canvas2D:
spacing, compact typography, canvas/surface/text/border meanings, status
meanings, shape, focus, selection, and disabled state. Canvas-only metrics such
as row height, pin radius, link width, hit slop, preview thresholds, and grid
spacing may be typed geometry tokens, but must be derived beside this
projection and may not redefine a semantic color, type role, or state meaning.

`packages/canvas/src/tokens.ts` constructs the existing `DesignTokens` adapter
from that projection. Canvas, raised node, panel header, and inset widget roles
own the primary surfaces; primary/secondary/disabled text, subtle/selected
borders, accent selection, selected overlay, and info/success/warning/danger
meanings own their matching paint roles. The adapter remains the shared mutable
`defaultTokens` object accepted by custom renderers. Compact Canvas typography,
all layout and text-measurement metrics, the data-type palette, and unmatched
run/mute/bypass meanings remain unchanged. The focused multiline editor uses
the corresponding CSS variables while retaining the same projected geometry.
The subtle-border role owns idle ordinary-node outlines through `nodeIdleOutline`,
as well as inset preview and widget chrome. The strong-border `nodeOutline` role
owns structural borders and pseudo-node outlines. Run, problem, hover and selection
outlines retain their separate meanings.

Groups keep user-authored colors as document data. Uncolored groups use the
semantic strong-border role for their existing fill, header, and border
alphas. Selection uses the shared selected-border role plus the existing
dashed outset, without changing group paint order, geometry, or hit targets.

Canvas navigation chrome uses the DOM projection directly. The minimap frame,
settings and switches, zoom/fit cluster, and Graph/Lens controls share panel,
raised, text, border, focus, selection, shape, motion, and elevation roles with
the shell while retaining their labels and behavior. Above 520px the corner
cluster remains 250 by 200 pixels. At 520px and below it becomes 210 by 172
pixels, with a 210 by 122 minimap and a separate 210 by 44 zoom/fit footer.
Every action keeps a hit target of at least 36 by 36 pixels.

DOM chrome consumes the CSS projection of the same source. A canvas adoption
change therefore updates the projection or its canvas geometry adapter once;
it must not patch Canvas2D, app CSS, minimap, and tooltip colors independently.
Type colors remain data semantics, while selection, focus, status, warning,
error, mute, and bypass remain visual meanings. Every status also needs a
shape, label, line style, icon, or other non-color cue.

### Shared state and geometry

The document and core model own graph/product semantics. `scene.ts` owns the
immutable document-to-scene projection and `layout.ts` owns world geometry.
The app host owns runtime-derived presentation state: progress, diagnostics,
mode, companions, previews, badges, selector resolutions, remote presence,
and focused/transient controls. Command and undo ownership do not move into
the renderer.

One typed host projection must feed paint, hit, tooltip, keyboard mirror, DOM
overlay, and minimap consumers. Consumers may simplify presentation, but may
not re-derive semantic truth. In particular:

- paint and hit use the same committed bounds and shared geometry helpers;
  an unpainted affordance is not hittable;
- tooltips resolve the same target identity and state that paint exposes;
- DOM media/editors project the same node region and are transient;
- the minimap uses the same citizen identity, bounds, selection, mode,
  progress/error precedence, bookmarks, and viewport state, while intentionally
  simplifying curves, text, row content, pins, badges, and previews; and
- resizing and dragging use explicit transient geometry, then return to one
  committed scene after dispatch.

The main renderer's fixed paint phases are groups, links, reroutes/net views,
nodes and boundary nodes, value sources/selectors, selection/gesture
adornments, and screen-sized toolbox chrome. Host-owned bookmark state is
painted as minimap marker descriptors, outside the main renderer. Changes may
insert only into a named phase and must preserve occlusion and matching hit
priority.

### Culling and level of detail

Interactive zoom remains `0.05..4`; fit remains clamped to `0.1..2`. Every
world-space descriptor supplies finite conservative bounds. The host culls
groups, link control hulls, reroutes, nodes, pseudo-nodes, and adornments
before expensive paint. Screen-sized strokes and controls expand bounds by
their full paint radius so they do not pop at viewport edges.

`CANVAS_DETAIL_MIN_SCALE` is the shared `0.5` boundary for renderer text
detail and transient media DOM. `defaultTokens.mediaControlMinScale` is the
shared `0.75` boundary for interactive media controls and output paging. The
renderer derives one `CanvasDetailLevel` from those owners and the Canvas host
passes the same tier into hit testing:

| Scale and tier            | Required detail                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.75..4` - `controls`    | Full node and row detail; interactive media controls may mount for a visible, active, or focused preview.                                                                                                                                                                                                                                                                           |
| `0.5..<0.75` - `content`  | Node, group, row, badge, net-name, and detailed lens text remain; media is visible but compact controls are non-interactive.                                                                                                                                                                                                                                                        |
| `0.05..<0.5` - `overview` | Node rows, titles, badges, link midpoint handles, detailed lens paint, toolbox, and resize targets are omitted. Typed pins, links, reroutes, groups, selection, progress, execution/problem/mode outlines, drop targets, decoded images, and compact video/audio type/count badges remain. Omitted row and handle regions fall back to structural body, link, or group-header hits. |

The grid doubles world spacing until dots are at least 12 CSS pixels apart.
Critical outlines, links, typed pins, reroutes, selection, and dash patterns
retain a minimum screen-space weight at low zoom; their conservative culling
and hit radii expand by the same scale policy. Pending, cached, skipped, error,
muted, bypassed, done, and running states combine thickness, dash, alpha,
progress, or wash cues with color. Level of detail changes paint and hit
complexity, not document/scene identity or world geometry. Offscreen or omitted
detail must not retain DOM, decode, tooltip, or hit work.

### Accessibility mirrors

Workflow tablists own only their tab triggers through `aria-owns`; close and
new-workflow buttons stay separately operable in the visual overflow strip.
Listbox groups use their visible headings as accessible group names without
exposing the headings as invalid listbox children. Text controls derive their
names from their visible labels, and contextual names retain the visible text.
Canvas control mirrors are labelled groups. The shell has one level-one
heading and context help lives in a named landmark.

Run `node packages/e2e/a11y-pass-dinkster.mjs` against a fresh frontend and the
workflow-pinned native backend with its development pack loaded. In the
disposable backend's library root, set `settings.json` to
`{"features":{"templates":{"enabled":true}}}` before starting it so the
gallery is available. Set
`AUDIT_BASE`, `AUDIT_OUT` and `AUDIT_RESULTS` for the frontend URL, screenshots
and JSON report. The check requires each named screen's visible state before
capturing it and fails on missing screens, browser errors, or any
critical/serious axe violation across the original 18 audit screens. The demo
uses served Empty Image -> Upscale Image By -> Preview Image nodes; the scale
node supplies the COMBO editor and Empty Image supplies the INT editor. Axe
incomplete checks remain in the report for manual assessment; they are not
reported as passed checks or as violations.

The canvas keeps one accessible host label and DOM shell controls. Focused
editors, media controls, and popovers remain host-owned DOM. General semantic
navigation is a host-owned listbox over the shared presentation projection.
Its semantic inventory is derived only while the listbox has focus and it
mounts exactly five option rows regardless of graph size. `aria-posinset`,
`aria-setsize`, and `aria-activedescendant` preserve the complete reading
position without one live DOM node per graph citizen or subscriptions to
pan/zoom updates.

Mirror entries expose deterministic scene order, citizen kind and name,
selection, port direction/type/optionality, link endpoints, group membership,
and execution/problem/mode state. Arrow, Page, Home, and End keys move only the
reading cursor. Enter or Space selects and centers the current citizen without
changing the document; Escape restores Canvas focus. Paint and camera movement
remain independent until activation.

Host-owned audio/video previews and finished-output pagers mount only when
their projected region intersects the clipped Canvas stage. At most 24 media
or pager roots from each family may be live at once. Visible scene order is
stable, while a focused, playing, selected, or open-viewer item may displace
the last ordinary item so interaction is not destroyed by the cap. Tab changes
clear transient ownership. Canvas2D images and compact low-zoom media cues do
not add DOM roots.

### Canvas gallery

The shared component gallery includes `/#canvas`. Its theme buttons and its
Page list, grouped under Nodes, Tabs and states, Rows, Wires, Subgraphs and
Zoom, select fixed examples painted by the production `CanvasRenderer`,
registry widget painter, layout and scene builder, without a backend. Previous
page and Next page step through the list in order, and the selected page is
kept in the address as `?page=<id>` so a page can be linked. Each page
has one sentence on what to look at. Each example is its own card: a canvas
sized to the example's nodes, links, tabs and toolbar, with its name as the
caption, in rows that wrap. Whole graphs (structural parts, subgraph pages and
the minimap) are one card. A card wider than the column scrolls inside itself,
so no page scrolls sideways at phone width. A page that compares a previous
look with the current one shows both side by side for each example, captioned
Before and After, instead of a selector. The reusable fixtures live under
`packages/canvas/gallery/` and name each example's nodes; the gallery shell
owns only selection, cards, captions and decoded preview images. Gallery
captions are annotations, not part of node paint. Widget fixtures include link-driven inputs, offered
family members, propagated values and diagnostics. The widget-state page selects
each kind to show default, hovered, offered, diagnostic and empty rows. Zoom pages
cover controls, content and overview detail. The minimap includes groups, links and reroutes.
Core widget rows compares selected, empty and long values for the core kinds.
The default `widgetRowLook: 'inset-raised'` keeps direct values in inset fields
and gives color and asset openers raised faces, kind icons and an opening
chevron. Their real swatches and value summaries are preserved. Before shows
previous all-inset paint on the same fixture; that comparison does not change
other pages. Number paint is unchanged; this
is not a proposed number editor or approval of its appearance.

Collection widget rows proposal compares the current inset collection rows with
raised multi-choice, list, palette and curve openers. Only that gallery page
selects `widgetRowLook: 'inset-raised-collections'`. It uses selected, empty or
minimal, and long or varied document values: selection counts, literal list
values, palette swatches and counts, and sampled curves with point counts and
interpolation. Curves require at least one point, so the minimal fixture is a
flat one-point curve. Production defaults, other pages and editors do not use
the proposal. Before and After draw both paints from the same document.

The Idle outline page compares the previous outline (Before) with the quieter
current outline (After) on idle, hovered and selected nodes. The app and
gallery default to the shared subtle idle border; Before overrides only that
page's `nodeIdleOutline` role to retain the former strong-border comparison.

The app canvas and gallery use contrast-adjusted type colors in both themes.
The named palette keeps each hue and meets 3:1 against that theme's node body;
colors already meeting the threshold remain unchanged. Unknown types keep their
stable hashed hue with theme-specific lightness. Live app theme changes update
chrome and type paint together. The Pins and links page retains the previous
colors as a page-only Before; it cannot change app defaults or other gallery pages.

Node titles retain normal letter widths and end in an ellipsis when they do not
fit the space left by header marks. The typed `titleOverflow` default applies to
app canvases and node previews. Node titles and Node titles at content zoom
compare this current look with Previous squeezing in both themes, using fitting,
long, renamed and minimized titles in the same production layout. Only those
gallery pages can select the previous look; it cannot change other pages or the
app. Title placement, available width and overview title painting are unchanged.
The canvas gallery loads its regular, semibold and italic faces before measuring
or painting, so a cold page and a return to a page use the same glyphs.

Subgraph names compares previous generated names with production ids as
written in the interior Inputs/Outputs panels and the collapsed occurrence.
The default gallery document uses production derivation without display-name
overrides for ids. Exact case, underscores, member suffixes, custom names and
uppercase unnamed output types pass through the real schema/scene builder.
Only the previous-name comparison stages historical labels as explicit names.

Editable workflow run states and Frozen run states compare the same six runtime
states and absent execution. Editable paint retains only running and failed
nodes; frozen paint retains every recorded state and its bottom label. Collapsed
instances aggregate occurrence severity and running progress before this
visibility filter. These gallery-only pages use the shared canvas presentation
API, not an adopted app-view policy. Each example shows chips (Before) beside
16px attached tabs (After); attached tabs remain a proposal and production run
paint and chip defaults are unchanged.

`packages/ui/test/canvas-gallery.spec.ts` compares each page in dark and light
themes in the same Linux Chromium job as the shared component screenshots, and
checks that no page scrolls sideways at 390px and that the column is centered.
Intentional paint changes include reviewed picture differences; token-only
moves preserve the pictures. `packages/canvas/src/tokens.ts` owns shared
semantic paint roles and the fixed `canvasPaintTokens` geometry. Existing
geometry exports are aliases consumed by both drawing and hit testing;
changing their source cannot leave an independent pointer target behind.

`pnpm check:canvas-literals` checks canvas source and every app source file
using the TypeScript AST. App paint operations are identified by their typed
2D context, including editor previews, offscreen contexts, memory graphs and
new painter helpers; unrelated DOM styles and data are not canvas paint.
Fixed paint colors, sizes, opacity, font sizes and dash arrays belong in the canvas token file,
not context assignments, drawing arguments or named geometry declarations.
Constant aliases, including imports, helper returns, array lookups and
array/object destructuring, do not hide literal paint values. Destructured
bindings follow their selected source values and defaults. Later variable
assignments and arguments passed to painter helpers are traced to the same
value sources, using declarations rather than identifier spelling. Collection
lookups inspect stored values, not data keys. Computed property names are
resolved before checking context writes. Native `CanvasPattern` results are
paint objects; image sources and repetition modes are not color literals.
Paint used to draw a pattern's tile is checked normally.
The check runs in fast CI and before the app production build. Coordinate
origins, count/unit arithmetic, normalized clamps and fully opaque context
resets are not designed dimensions; protocol and gesture policy remain outside
paint ownership. A measured hex-value label is text, not a paint color.

### Extension descriptors

Extensions never receive canvas, DOM, CSS, theme, app-store, socket, network,
or full-scene handles. The Types lens uses renderer-owned retained text
descriptors instead of a raw paint callback. Its link-midpoint and node-output
anchors have stable ids, semantic text/font roles, conservative local bounds,
the fixed `over-scene` phase, retained scene ordering, host culling/clipping,
a 512-code-unit text limit, an 8,192-visible-descriptor frame limit, and zero
authored path segments or hit regions.

Future adornments use retained typed descriptors containing a namespaced
stable id, semantic token roles, an anchor, conservative bounds, one fixed
paint phase, bounded primitives, and at most one optional host-routed hit
action. The app-internal lens registry is not a general extension provider.

Every descriptor provider requires design review and declares enforceable
limits for descriptors per anchor and frame, path segments, text length, and
interactive regions. The host validates the limits, culls by declared bounds,
clips to the allowed anchor region, orders by phase and stable id, and resolves
actions through registered commands. A provider without approved numeric
limits or a conservative bounds function cannot register. Default descriptors
are non-interactive; descriptor data can name an action but cannot carry an
arbitrary callback.

### Performance methodology and budget

The historical measurements in [Performance baselines](perf.md) are not
active browser test gates. A wall-clock test requires elapsed time to be the
property under test and a bound derived from the slowest hosted runner with
at least a threefold margin. The removed browser timing cases did not meet
that requirement.

Performance comparisons use the same machine, Chromium build, display mode,
viewport, device scale, fixture, ports, worker count and environment on both
sides. Preserve measured distributions rather than a selected favorable sample.
Profiler evidence informs hot-path caching and algorithm changes. Nodes,
links, groups, overlays and minimap remain batched and cullable Canvas2D;
no per-node DOM may enter paint, pan or zoom paths.

Activity rows apply the shared data-rich surface language directly: separate
metadata fields, semantic badges and row markers, selectable message text,
keyboard-focusable overflow, and responsive reflow. The bottom-panel host
continues to own title, Clear, close, and resize chrome.

Library content applies the same language inside the existing left-dock host.
Packs, Templates, and Workflows expose source-specific empty/error copy,
selectable identity and provenance, semantic badges, and a selected-item detail
rail that collapses back into the row at narrow widths. The backend context is
always visible and distinguishes protocol and connection state without relying
on color alone. See [Library](library.md).

Subgraph-definition cleanup applies the same language without changing core
authority: named reachability badges, labelled impact facts, exact wrapping
identifiers and dependency names, focusable list overflow, and explicit empty
and unavailable states. The shared modal and action footer continue to own
dialog and destructive-action presentation.

Output inspection applies this language to read-only execution media. The rail
and modal use semantic surface, border, text, accent, success, warning, danger,
focus, spacing, radius, and control tokens. Preview imagery remains supporting
content: visible text carries backend, execution, runtime node, output,
descriptor, source, media, identity, and availability meaning. Long identities
wrap in metadata regions, while image stages and metadata tails scroll
independently at narrow widths and browser CSS zoom. See
[Output inspection](output-inspection.md).

App view validation and remote-choice failures use ProductNotice error feedback
beside their existing controls. Correcting a local value clears its validation
notice; a remote failure does not disable editing unrelated fields.

## Extension boundary

Extensions contribute namespaced serializable content and commands. The host
owns layout, breakpoints, tokens, focus order, ARIA wiring, transient-surface
placement, error boundaries, cleanup, and contribution ordering. Extension
DOM, CSS, class names, inline styles, themes, raw Canvas handles, app stores,
sockets, and unrestricted network handles are outside the contract.

Core surfaces use the same contract as extensions. A rich interaction that
the contract cannot express becomes a reviewed host primitive rather than an
escape hatch.

Extension management uses nested semantic groups for pack, category, and
contribution identity. Complete ids wrap instead of truncating. Text labels
distinguish deployment policy, user gates, registration, activity, missing
contributions, and activation failure; color and checkbox state only reinforce
those labels. Disabled controls reference a visible reason, diagnostic rows
retain severity and code, and stable list positions preserve keyboard focus
when a gate changes. The body owns contained scrolling and reachable tails at
narrow widths and browser CSS zoom.

## Extension asset editors

The specialized asset editor shell is parked in
[the rework queue](rework-queue.md#extension-asset-editor-shell). Generic
`WidgetView.editorUi` contributions still use bounded group, text, status
and action nodes through the Host UI renderer. The ordinary builtin asset
picker is independent and remains available.

## Font loading and captures

Bundled Noto faces use `font-display: swap` so site text does not wait for a
cold font transfer. Canvas startup still loads its measurement faces before
rendering. The shared browser capture fixture in `packages/e2e/visual.ts` waits
for `document.fonts.ready` and verifies the visible product font faces before
page, locator or golden-image captures. Failed font loads reject the capture;
screenshot baselines do not use fallback text.

## Desktop information

`ProductWindowChrome` reserves the native title-bar overlay area and the
macOS traffic-light inset, uses the shared 56px bar and palette, and marks
its empty background draggable while its contents remain non-draggable.
The host supplies the exact title and platform. The gallery shows Windows,
Linux and macOS geometry; native Electron control behavior is checked by
the adopting Desktop application, not the browser gallery.

`ProductAbout` renders the bundled theme-specific wordmark, product title and
version with shared typography and spacing. Its `theme` follows the host
window's theme; `title` carries the host's identity, including QA markings.
`ProductStringsProvider` can replace the Version label. The component adds no
controls, navigation or network activity. The gallery's Desktop information
page shows dark and light appearances and the QA title at narrow widths.

## Account site assets

`packages/site` builds the SolidJS account and authorization views on
`@dinkster/ui`, with no site-owned stylesheet or controls. The account service
owns API calls, navigation state and show-once secret lifetime; the view accepts
its bound screen model and exposes fields through `data-account-field`. Field
IDs and labels remain owned by `ProductField`. The service supplies the person's
name and email to the account menu. The renderer owns changed-field disabling;
controller callbacks update service state without rewriting button attributes.
Rejected changes remain retryable, and only a successful save advances the saved
baseline. Same-screen responses reconcile the existing controls, so a focused
Save remains focused through refusal or success. After success it is announced
as unavailable until focus leaves, then becomes natively disabled. Conditional
fields and token-history membership update with the service model.
Dismissing a toast or error updates the service-owned message state.
The service calls the view's `clear()` on pagehide alongside clearing its secret
variables; this removes secret DOM before a restored page is rendered.
The service model selects `layout: 'card'` for standalone sign-in, create-account
and reset flows. These render `ProductAuthCard` with no top bar. Blocks stay in
service-provided order: the sign-in form, separator, GitHub, then Google.
Provider blocks use `ProductProviderButton` with bundled logos and remain hidden
when that provider is not configured. Optional `screen.footer: { text, action }`
places the sign-in create-account prompt and outline action below the card.

Account pages use the shared Account shell. A `{ t: 'section', text, blocks }`
block maps to `ProductSection`; `{ t: 'panel', blocks }` groups facts or fields
inside one `ProductPanel`. The service declares these groups rather than the
renderer guessing them from headings. Nested fields retain `data-account-field`,
changed-field Save disabling, conditional visibility and same-screen focus.
Fact chips use `ProductStatusPill`; optional `tone` is `good`, `warning`,
`problem` or `neutral` (the default), independent of translated status text.

Optional `AccountModel.pictureSrc: string | null` passes the service-owned avatar
URL to `ProductAccountMenu`. Its existing same-origin HTTP(S) check and absent
or failed-picture initial fallback remain authoritative; no avatar setter or
upload control is supplied. The service owns any approved image proxy.

Authorization uses the same centered `ProductAuthCard`, retaining a native POST
form with the signed consent token and explicit approve/deny submitter values.

`pnpm --filter @dinkster/site build` creates the account, authorization and
portable Desktop About templates, renderer modules, one shared stylesheet,
bundled fonts and a SHA-256 file manifest. `about.html` uses relative local
assets and a self-only CSP with no network connection permission or inline
styles/scripts. Desktop supplies `title` and `version` as URL query parameters;
they render as text through `ProductAbout`. The view follows the OS color
scheme, including changes while open, and reports only the no-send
`desktop-about` route event. The existing wheel carries these files under
`static/site/`; consumers retain that directory structure.
Each template preloads its renderer and transitive static imports from Vite's
build manifest so controller imports do not add serial discovery round trips.
The build manifest itself is not distributed.
`scripts/build_release.py` includes these under `static/site/` in the existing
frontend wheel, covered by its version and wheel hash. Template configuration
placeholders must be HTML-attribute escaped by the service. No Node tooling is
required by the Python consumer. The renderer reports only fixed route/timing
events through the shared no-send reporting function.

### One-response callback page

`callback.html` is a static rendering of `ProductAuthCard` and `ProductLink`.
It embeds the shared stylesheet, bundled Noto faces and color wordmark, with no
scripts or follow-up asset requests. A loopback listener may close immediately
after its response. The page always includes a return-to-Dinkster link.

The `dinkster.site/1` manifest hashes the unbound template in `files` and provides
`callback.template`, `callback.csp`, `callback.textSlots` and
`callback.destinationSlot`. The existing frontend wheel version and SHA-256
identify the distribution. The wheel packager requires the callback template and
checks its manifest slots, digest and exact embedded-style CSP before producing
a release. Consumers also verify the template hash before binding values.

Replace all slots simultaneously in one pass (not repeated replacements):

- `__CALLBACK_HEADING__`: heading, accessible card label and document title.
- `__CALLBACK_MESSAGE__`: terminal outcome, as plain text.
- `__CALLBACK_RETURN_LABEL__`: link label, normally "Return to Dinkster".
- `__CALLBACK_RETURN_URL__`: destination in a double-quoted `href` attribute.

HTML-escape every value, including both quote characters, `&`, `<` and `>`.
Text slots never accept markup or a URL. Slot-like text inside a supplied value
stays literal. The engine must validate and capture the originating HTTP(S) app
root before starting authorization, without credentials, query or fragment, then
attribute-escape it for the destination slot. The provider's `flow.redirect` is
the callback endpoint, not the app return destination. Escaping alone does not
validate a destination; do not bind untrusted provider URLs to this slot.

Serve as UTF-8 HTML with `Cache-Control: no-store`, `X-Content-Type-Options:
nosniff` and `Referrer-Policy: no-referrer`. Use the manifest's exact CSP as a
response header, optionally adding `frame-ancestors 'none'` there (not supported
in a meta policy). The same CSP is embedded before content: deny by default,
only the exact stylesheet SHA-256 allowed, `data:` images/fonts, no base URL or
form submission. It permits no scripts, connections, external assets or inline
style attributes. Binding the slots does not change the stylesheet hash. Do not
add a service policy that permits extra sources or substitute style content.

## Replacement rule

Dinkster is unreleased. A redesigned surface deletes the superseded UI, styles,
exports, tests, docs, and contribution path in the same change. There are no
deprecation windows, shims, adapters, feature-flagged dual paths, or migration
periods for superseded frontend APIs. Internal work coordinates by sequencing
against the new contract.

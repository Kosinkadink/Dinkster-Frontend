# Widget compact controls and expanded editors

## Floating interaction surfaces

Product listboxes, cascading context menus, suggestion lists,
seed-controller menus, and ordinary expanded widget editors share one
semantic floating-surface chrome. Product listboxes, cascading menus, and
suggestion lists, plus ordinary widget popovers, also use one placement
primitive for anchored block, inline, and point placement. It flips toward
available space and returns bounded width and height limits. Each owner keeps
its existing ARIA, focus, keyboard, commit, and dismissal behavior rather than
delegating interaction semantics to the placement layer.

Product listboxes and fixed menus stay inside the viewport. Canvas widget
popovers stay inside the canvas stage, falling back to the viewport only when
the narrow shell intentionally hides that stage. Long labels wrap, overflowing
panels scroll internally, and keyboard-active product options scroll fully
into view. On a viewport too narrow for two cascading panels side by side, a
submenu may cover part of its parent instead of leaving the viewport; ArrowLeft
closes the child and returns to the parent tier.

## Product combobox and listbox

Product select fields share one dependency-free combobox/listbox surface.
The button retains its associated label, selected text, disabled state, and
focus-visible treatment without native select chrome. Opening the control
creates an anchored listbox in the owning dialog when present, otherwise in
the document body. The listbox uses the shared floating-surface placement,
semantic colors, spacing, and hit targets.

Tab reaches and leaves the trigger normally. ArrowUp, ArrowDown, Home, End,
and printable-character typeahead move only the active option; navigation
does not update a draft, setting, or document. Enter, Space, or deliberate
option activation selects once. Escape and outside activation close without
selecting, and closure restores focus to the trigger when focus was in the
popup. Disabled controls do not open and disabled options remain visible but
cannot become the committed selection.

The trigger exposes the combobox name, expanded state, popup relationship,
and active descendant. The popup and rows expose listbox and option roles,
selected state, and disabled state. Callers may synthesize a disabled current
option when a stored value is outside the available vocabulary. AppView keeps
typed COMBO values mapped by option index; runtime settings keep changes in
their Apply draft; SAVE_TARGET keeps mount choice staged until Save; registry
settings write immediately; and CollectionPanel preserves asynchronous,
open-vocabulary source and filter values while resetting paging on a source
change.

## Product number, slider, and color controls

ProductNumberInput renders a text-entry spinbutton with product-owned minus
and plus targets. It accepts decimal or numeric input hints without invoking
native number chrome. The control exposes declared minimum, maximum, current
value, and mid-edit text to assistive technology. Arrow keys step once,
PageUp and PageDown step ten times, and Home or End use only declared bounds.
An unconstrained step uses one for gestures while leaving typed input
unconstrained. INT commits require canonical base-10 integer text; fractions,
exponents, and leading zeroes are rejected rather than rounded. Escape restores
the last committed text.

Commit-on-change callers keep typing local until Enter, blur, or one stepper
gesture. Continuous callers receive every valid typed or stepped value. This
preserves AppView and region one-command edits, runtime Apply drafts, and
immediate registry settings without introducing coercion at the primitive.

ProductSlider renders a focusable product track and thumb with a 32px hit
height. Pointer click and drag emit stepped values continuously. Arrow keys,
PageUp and PageDown, Home, and End provide the equivalent keyboard path. Its
minimum and maximum are reactive, including runtime device budget bounds.
Pointer gestures stop at the slider so canvas editors and media overlays stay
open while scrubbing.

AppView COLOR uses a product swatch trigger and an anchored popup mounted in
the owning dialog when present. The popup accepts exact six-digit hex text and
offers 32px preset swatches. Invalid text does not commit. Escape discards the
draft, closes the popup, and restores trigger focus. A non-color stored value
displays white without writing that fallback into the document.

On the compact canvas row, a connection-driven input normally shows its
propagated value in neutral-grey italic companion style. Expected values,
recipe-proven retained values, and frozen exact values all keep that neutral
full-opacity treatment. Only an existing stale/unproven companion uses the
semantic light-blue `companionUnproven` token plus a dotted underline; the
underline communicates the state without relying on color, and full text
opacity preserves contrast. This token is separate from selection, progress,
and data-type blues. An unstored widget-tap source resolves through the same
schema default used by compact paint and execution, so storing an equivalent
`0`, empty string, or other dormant local value never changes the presentation
mode. Schema wire 34 lets a primitive identity output name its same-typed
integer, float, string, or boolean input. The frontend then follows that input
generically and presents an exact literal before execution; connected inputs
retain their upstream executed, cached, stale, or estimated provenance. Known
literals are not local estimates or execution results. If no propagated value
is available, the dormant stored value remains
readable but is dimmed and crossed out. Mouse hover and the pointer-inert
keyboard mirror expose the same `Stale/unproven value` wording without editing
or storing anything.

Compact rows are the primary workflow. INT and FLOAT edge steppers paint a
minus on the left and a plus on the right. They remain independent controls
that immediately write one undoable schema-aware step and never open the
editor. When both declared bounds are finite and `max > min`, the value zone
also carries a low-contrast background fill for the clamped
`(value - min) / (max - min)` fraction. Missing, partial, infinite, or equal
bounds paint no fill. The glyph and fill do not change the existing bump-zone
hit rectangles. They
resolve unstored values through the same intrinsic default the row paints,
then apply the shared min/max/step clamp and decimal quantization. BOOLEAN
toggles immediately and pairs its existing on/off text with a small
state-bearing track and thumb. COMBO retains its selected value and reserves a
12px right-edge down chevron; the caret and numeric +/- glyphs share a 3px
half-extent around centers 6px inside the true row edge. Controller chips leave
6px before the unchanged trailing stepper zone, while chip paint, text rails,
and hit testing derive from the same rectangle. Companion-driven rows keep the
shared read-only companion treatment and omit the chevron. Every row keeps its
compact value preview. Compact rows preserve a short complete value by shrinking and
ellipsizing the label first; values too long to fit beside the 44px label floor
retain proportional sharing. The ASSET `no asset` placeholder uses muted italic
text and remains complete at ordinary and minimum node widths. Activating the
row body opens optional expanded controls only when
more deliberate editing is useful. INT, FLOAT, single-line STRING, COLOR,
COMBO, and SAVE_TARGET use a small non-modal popover anchored to that row. A
node-input multiline STRING in the `core.text` representation is edited
directly in its painted rectangle instead. The popovers are non-draggable,
non-resizable, canvas-stage-clamped, and close through Escape, Cancel, a
committed selection, or an outside click. ASSET alone uses the native product
dialog because browsing, previewing, selecting, and uploading need a large
focus-contained surface. BOOLEAN is complete inline and deliberately has no
fake expanded surface. User dismissal and commit paths restore keyboard focus
to the graph canvas.

Popover fields never commit merely because focus moves. Numeric and single-line
text commit on Enter or Commit, value-source multiline text and raw JSON on
Ctrl+Enter or Commit, COLOR on Enter or Commit, COMBO on a deliberate option
activation, and SAVE_TARGET on Save. An outside pointer commits a changed,
valid INT, FLOAT, single-line STRING, COLOR, SAVE_TARGET, or raw-JSON field
through that same command path and then closes; unchanged or invalid text
closes without a write. COMBO still commits only a deliberately activated
option, and value-source multiline STRING closes without committing its draft.
Cancel and Escape discard uncommitted state. The in-node
multiline editor continues to commit changed text on Ctrl+Enter or
click-away/blur, cancel on Escape, and close without a write when unchanged.
Its local draft remains open across document updates. On commit, the editor
maps its character-range change over text that arrived after the editor opened,
so non-overlapping concurrent edits are retained. If the stored value is no
longer text, the editor falls back to the ordinary whole-value write.
INT and FLOAT popovers focus and select
their complete value when opened, so typing replaces the old value immediately.
That behavior belongs only to INT and FLOAT; every other editor's existing
focus and selection behavior is unchanged. Single-line STRING, multiline text,
and raw JSON retain ordinary focus without select-all. COLOR continues its
pre-existing select-all behavior because hex values are normally replaced
whole; audit-N does not change it. Native arrow, Home, and End behavior
remains untouched for frictionless caret placement; `widget-editors.spec.ts`
proves that ArrowLeft and ArrowRight collapse a numeric selection to the start
and end respectively. The numeric popover intentionally has no second pair of
+/- buttons: compact edge steppers remain the direct stepping control, while
the popover supplies exact text entry and an accessible constraint summary.
Declared minimum, maximum, and step values are shown; absent bounds say
`unbounded`, and an absent step names its effective default. ASSET retains its
immediate single-pick and staged multi-select rules described below.

Ordinary expanded editors share the product field and action-footer language.
The scalar, color, combo-search, and save-target controls expose visible labels;
invalid scalar, color, and prefix drafts are linked to inline alerts without
changing their existing commit rules. Footer actions wrap together and stack at
narrow widths. Loading, empty, and failure data remains in semantic notices,
while each editor retains ownership of its draft, validation, and command.

A registered `WidgetView.editorUi` takes precedence over the built-in editor
for that view. CanvasHost supplies an immutable, bounded JSON snapshot of the
value, widget type/options, and document target. The provider returns only the
strictly decoded host-UI tree; actions name registered commands and carry JSON
payloads. The host owns elements, semantic styling, preferred-size clamping,
focus, Escape and outside dismissal, canvas-stage placement, diagnostics, and
cleanup. Provider code receives no DOM, theme, store, socket, or network
authority. A provider failure stays inside the editor and appears through the
ordinary Problems ownership path.

An editor provider can return the root-only `asset-editor` presentation node
when it needs the shared Asset Editor shell. The bounded descriptor supplies a
responsive viewport state, display fields, authored origin labels, capability
labels, validation notices, fact groups, tool slots, and generic command
states. The host renders Inspector and Editor regions with the product field,
tab, notice, and action primitives. Known fields are display-only; an editable
capability can expose a separate registered command. Unknown field or
capability kinds render an unsupported notice without exposing their value or
action.

Asset Editor command slots invoke registered commands without a payload. The
descriptor carries already-authored labels and states only: it does not define
field precedence, transform values, operation order, output-fact meaning,
progress protocol, draft/apply/cancel behavior, gesture meaning, canonical
command identifiers, or backend routes. Displayed origin is an open
presentation label rather than a frontend semantic enum. These constraints let
backend-owned adapters supply future semantics without changing the host shell
or giving providers DOM, CSS, network, store, or raw route access.

## Text completions

Node-input `core.line` and `core.text` editors expose the same typed,
disposable completion provider seam. A provider receives graph, node, input,
node-type, and WidgetSpec context plus the current draft, caret, trigger text,
and an AbortSignal. It returns labels, optional detail text, and replacement
ranges only. Providers never receive the input element, document store, or
command dispatcher.

Schema wire 36 lets backend and custom-node authors declare static completion
items on any STRING widget. Each item supplies a matching value, visible label,
inserted text, optional detail, and either identifier or operator token
semantics. A declaration can also name dynamic input families; their current
member names become identifier completions without a node-specific frontend
path. Matching replaces only the identifier or operator token at the caret.
Math Expression declares its grammar vocabulary and `values` family through
this contract.

Typing or moving the caret starts a new request and aborts the previous one.
Late results are ignored after another edit, suggestion closure, editor unmount, or
provider disposal. A provider failure is logged and isolated so successful
sibling results still appear in stable registration order. The generic
host-owned suggestion surface supplies semantic listbox markup, active
descendant and status announcements, long-content containment, active-option
scrolling, and canvas-bounded placement that follows the textarea, flips at an
edge, and does not cover adjacent shell panels. ArrowUp and ArrowDown move the active result, Tab or Enter inserts it
into the local draft, and Escape closes the surface and restores textarea focus
without changing the draft or closing the editor. These keys do not reach
ordinary editor handling while suggestions are open. IME-composing key events
remain untouched. The host request session accepts the typed inventory handle
directly: loading appears immediately, ready items use normalized filter text
and stable source order, authoritative empty and provider error states remain
bounded to the same status surface, and cancelled or changed-scope results
dismiss without flashing a false state. After insertion, a single-line
popover commits with Enter, Commit, or click-away; an in-node multiline editor
commits with Ctrl+Enter or blur. The surface never dispatches a document
command itself.

The built-in embedding and LoRA inventory supports both text views and scans a
token backward from the caret to whitespace,
newline, or the start of the draft. `embedding:ca` can offer `embedding:cats`;
`<lora:po` can offer `<lora:portrait-style:1.0>`. It uses a typed choice source restricted to
`/api/choices/comfy.files.embeddings` and `/api/choices/comfy.files.loras`.
A lazy request immediately exposes an immutable loading state, then settles
to immutable ready, empty, or error data. Query and candidate filter text use
the same NFKC/locale-invariant lowercase normalization; candidates also include
stable source order and exact replacement ranges. The provider
forwards AbortSignal and explicit refresh, and refuses cancelled, superseded,
or changed-scope results. AppState captures the active live tab and its
selected backend's scoped client for each request, so tab or backend changes
cannot publish or accept foreign inventory. This seam has no DOM, store, or
command-dispatch authority. The app passes its handle directly to the generic
host suggestion surface; static extension providers remain available for
other completion sources.

FLOAT compact text derives its fixed precision from the effective schema step
and always shows at least one fractional digit (`step: 1` and `step: 0.1` show
`0.0`; `step: 0.01` shows `0.00`). Scientific-notation steps are normalized
deterministically, trailing zeros remain visible, and formatting never changes
the stored number. INT remains integer-formatted.

The type pill uses the same `typeColor` resolver and design tokens as canvas
pins and noodles, including namespaced ids such as `comfy.IMAGE`. Its text is
black or white according to the resolved color's relative luminance. The
SAVE_TARGET editor labels the pill with the input's canonical declared type
(for example `dinkster.save_target`) rather than the widget renderer family.
Its output-format row and inline filename context come only from the widget
descriptor's declared suffix. A `.png` suffix is displayed as `.png`; it is
not expanded through a guessed extension registry. An absent or empty suffix
stays `generic`; any declared suffix is displayed verbatim. The stored value
remains exactly `{mount, prefix}`.

The transparent popover layer is not hit-testable outside the solid editor.
CanvasHost asks the editor to commit-or-close during capture without preventing
or stopping the pointerdown, so that same click can open a second widget, select
another node, activate toolbar chrome, or begin a canvas pan instead of
requiring a second gesture. A successful change is one document command and
one undo step. Invalid typed text is dropped on click-away without changing the
stored value or opening a new error surface. Explicit Cancel and Escape remain
discard paths. The ASSET native backdrop owns the modal equivalent and its
upload lock still consumes outside interaction.

## In-node multiline editing

Compact views communicate these paint-only affordances through the existing
renderer-neutral `SceneBuilder` style records. Rect roles
`toggleAffordance`, `comboChevron`, and `numericRangeFill` carry boolean state
or fill fraction to the registry painter; `reserveRight` on the value text run
keeps glyphs from overlapping text. The roles are widget-view semantics, not
node-name checks. Canvas colors come from `widgetAffordance`,
`widgetAffordanceActive`, and `widgetRangeFill` design tokens.

A multiline node input is a large text surface, not a compact value picker.
Its 12px label floats in an additive 18px label band at the top of the field,
while prompt content uses the width below it after one permanent 8px scrollbar
gutter (6px scrollbar plus 2px rounded-edge inset). An empty canonical
value remains empty in the document but paints the input display name as a
muted italic placeholder. Populated values paint verbatim with 14px type, 20px
leading, and 6px content padding. These additive multiline tokens do not alter
the shared 12px/24px compact-row rhythm used by single-line and scalar widgets.

Opening the field replaces the painted multiline surface with a DOM textarea
over the exact widget rectangle rather than detaching the text into a popover.
This preserves the node's spatial context and removes the visual jump between
reading and editing. Value-source multiline editors and the raw JSON fallback
remain popovers because they are separate source controls rather than
node-owned text regions; all other widget families retain their dispositions
above.

The overlay derives its position from the widget's world rectangle and the
renderer viewport signal. Camera pan and zoom update its screen position and
dimensions while it remains open. Its 18px label band, 14px content font, 20px
line height, 6px padding, 8px reserved gutter, and corner radius scale with
zoom and match the Canvas2D field. The editor stays inside the shared 2px
top/bottom chrome inset, has no resize handle or browser outline, and uses a
6px product-themed scrollbar with bounded vertical scrolling. The scrollbar
starts at the content-box top, not below it. Overflowing painted content uses
the same gutter while idle and hover; hover paints a proportional scrollbar
indicator inside the rounded chrome. The painted indicator is deliberately
non-interactive because canvas rows have no scroll interaction.

Ctrl+Enter commits through the existing widget command path.
Escape cancels. An outside pointer explicitly blurs the field before the same
pointer continues to its target, so click-away commits changed text even though
the canvas is not a normal focus target. Opening and clicking away unchanged
does not create a revision, undo step, or ghost materialization.

Controller-enabled INT/FLOAT and remote COMBO rows expose their controller only
through the compact canvas chip and its detailed menu. Expanded editors do not
duplicate or cycle controller state. The menu routes fixed, increment,
decrement, randomize-after-run, and randomize-after-refresh choices through the
owner-routed `node.setController` command. Selecting randomize does not change
the current value immediately; it advances only after the named successful run
or refresh event. The chip does not move as the value gains digits. Wide rows
reserve 128px for value text (enough for a full JavaScript safe integer), while
narrow rows retain a 44px label floor and clip at one stable threshold. Hovering
the value zone exposes the complete effective value in the widget tooltip, so a
clipped seed remains discoverable without overlapping the chip or edge stepper.

Compact widget hover uses a neutral wash clipped to the exact visible rounded
widget chrome, and an anchored widget diagnostic uses the same rounded path as
a red outline. Both keep the chrome's 2px top/bottom breathing room and 4px
corner radius. Flexible multiline rows derive that path from their current full
layout height, so the highlight follows live node resizing without changing the
larger row hit target. Numeric minus/plus glyphs and controller chips remain
painted above these states with their existing geometry.

The COLOR editor contains an inline saturation/value square, a hue strip, and
the authoritative hex text field. Pointer drags update valid RGB hex text live.
When the field holds `#rrggbbaa`, visual picker changes preserve the final alpha
pair verbatim. Alpha remains text-only. The field accepts `#rgb`, `#rrggbb`, and
`#rrggbbaa`; invalid text remains visible with an error and is never committed.
The footer supplies the only Cancel and Commit actions.

## Schema-selected widget representations

Schema wire 17 can declare a finite `REPRESENTATIONS` set around one canonical
widget value/socket. Each alternative has a stable id, display name, and closed
widget descriptor. The schema's declared default chooses the initial compact
and expanded presentation. If and only if the schema sets `userSwitchable`,
the widget row context menu exposes a **Representation** submenu with the
current choice checked. For example, CLIP Text Encode defaults to Multiline and
also offers Single line.

An ordinary STRING without an explicit representation set receives compatible
Single line and Multiline views automatically. Its `multiline` hint chooses the
default, not the only available editor. An explicit representation set remains
authoritative: omitting an alternative restricts it, and setting
`userSwitchable` to `false` locks the declared default. Switchable rows expose
their choices only through the **Representation** submenu in the right-click
context menu; they do not paint a dedicated switch button.

The `core.text` compact representation has a two-line natural minimum made of
one 18px floating-label band, two 20px content lines, and 6px top/bottom content
padding plus the shared 2px top/bottom chrome inset (74px total). Canonical
empty and trailing lines remain preserved, and
measured wrapping creates additional visual lines. An empty value paints the
field display name as a presentation-only muted italic placeholder.
The canvas clips those lines to the allocated widget height instead of
flattening them into a first-line summary. Manually increasing the node height
assigns the extra vertical space to active `core.text` rows, revealing more
text. During a pointer resize this distribution is projected on every preview
frame, including following rows, pins, and link endpoints; document geometry
changes only when the gesture commits. With multiple active multiline rows,
each receives an equal whole-pixel share in schema order and the final row
receives any remainder. Manual shrinking still clamps at the natural two-slot
minimum.

This flexible-height behavior belongs only to the effective `core.text` view.
Switching to `core.line`, selecting another representation, or rendering any
numeric, combo, asset, or other compact view restores its ordinary fixed row
height; unused manual node space remains empty. Width changes fit and clip each
canonical line using measured word and overlong-token wrapping. The direct
multiline editor presents the same canonical value and text rhythm; stored text,
serialization, compilation, and submitted job value remain unchanged.

The selected id is client-owned editor state under the node view, not a node
input value. Switching is undoable and survives document save/reopen and
schema refresh, but it never changes the canonical value, TypeExpr, links,
compiled literal, job payload, semantic hash, or execution identity. A stale
stored id is retained for a possible later schema refresh while rendering falls
back to the current schema default; it is never fabricated as a valid menu
choice. Non-switchable sets and predecessor wire schemas have no switcher and
retain their singular/default widget behavior.

The native picker exposes one `Text` primitive. Its STRING value can use either
view. The legacy `dinkster.string_multiline` type remains loadable for existing
workflows and defaults to Multiline, but is hidden from search so it does not
create a duplicate picker entry.

## Registered widget inventory and expanded disposition

Supported schema wires inherit widget contracts from their introduction:
NUMBER display from wire 18, MULTI_COMBO from wire 21, structured combo choices
from wire 23, and exact decimal integer bounds from wire 33. Wires 39 and 40
retain these fields without losing options or rounding seed bounds. Older wires
keep their existing grammar and invalid descriptors keep their diagnostics.

This table inventories every family registered by `registerCoreWidgets`. The
schema column names only metadata currently carried by `WidgetSpec`; absence is
intentional and the UI must not infer backend behavior or synthetic limits.

| Registry family | Compact renderer | Expanded path and disposition | Schema-owned constraints and metadata | Primary regression proof |
| --- | --- | --- | --- | --- |
| `INT` | `core.number`: right-aligned exact integer, finite-bounds range fill for safe numeric ranges, independent immediate edge steppers, and optional controller chip/menu | Anchored exact-text popover with visible min/max/step summary, validation, and commit/cancel; no duplicate +/- or controller controls | `default`, exact `min`, `max`, and positive `step` from signed 64-bit minimum through unsigned 64-bit maximum, display name, after-generate controller and initial mode | `core/test/dinkster-wire33.golden.test.ts`, `core/test/numeric-step.test.ts`, `widgets/test/widgets.test.ts`, `canvas/test/interaction.test.ts`, `app/test/ProductNumberInput.dom.test.tsx`, `app/test/widget-commit.test.ts`, `app/test/controller-advancement.test.ts`, `e2e/widget-editors.spec.ts`, `e2e/seed-controller.spec.ts` |
| `FLOAT` | `core.number`: step-precision fixed text (at least one fractional digit), finite-bounds range fill, and independent immediate edge steppers | Anchored full-precision text popover with visible min/max/step summary and validation; no duplicate +/- controls | `default`, `min`, `max`, positive `step`, display name, after-generate controller and initial mode | `widgets/test/widgets.test.ts`, `widgets/test/widget-matrix.test.ts`, `canvas/test/registry-painter-label.test.ts`, `canvas/test/interaction.test.ts`, `app/test/ModalSurface.dom.test.tsx`, `app/test/combo-search.dom.test.tsx`, `e2e/widget-editors.spec.ts` |
| `STRING` | Fixed-height `core.line` or vertically flexible multiline `core.text`; ordinary strings synthesize both views and use `multiline` only as the default hint. `core.text` floats its label in an 18px band above a 14px/20px/6px-padded content strip with a permanent 8px scrollbar gutter, paints the display name as a muted italic placeholder only when the canonical value is empty, and supports measured wrapping plus live preview-height growth. Overflow hover paints a non-interactive scrollbar indicator inside the chrome. Explicit wire-17 representation sets can restrict or lock the choices; switchable rows use only the context-menu submenu | `core.line` uses the standard anchored single-line popover. Node-input `core.text` uses a live camera-tracked textarea with matching floating-label, gutter, and content metrics, bounded vertical overflow, no native resize/outline chrome, and a zoom-scaled 6px product scrollbar. Both use the same completion path. Value-source text and raw JSON remain popovers | `default`, `multiline`, display name; optional wire-17 stable representation ids/default/userSwitchable; optional wire-36 completion items and dynamic input-family sources; no schema max-length constraint exists | `widgets/test/widgets.test.ts`, `widgets/test/widget-matrix.test.ts`, `widgets/test/text-editor-extension.test.ts`, `canvas/test/layout.test.ts`, `canvas/test/interaction.test.ts`, `canvas/test/registry-painter-label.test.ts`, `canvas/test/renderer-paint.test.ts`, `core/test/dinkster-wire17.golden.test.ts`, `core/test/dinkster-wire36.golden.test.ts`, `app/test/menu-target.test.ts`, `app/test/text-completion.dom.test.tsx`, `e2e/widget-editors.spec.ts`, `e2e/widget-representations-wire17.spec.ts`, `e2e/text-completion.spec.ts` |
| `BOOLEAN` | `core.toggle` with a state-bearing track/thumb and optional true/false labels | Undoable inline toggle; explicit **no-modal** disposition because there is no additional complete control to present | `default`, `labelOn`, `labelOff`, display name | `widgets/test/widgets.test.ts`, `widgets/test/widget-matrix.test.ts`, `canvas/test/registry-painter-label.test.ts`, `e2e/widget-editors.spec.ts` |
| `COLOR` | `core.color`: filled square swatch and exact hex value | Anchored HSV/hex popover for visual picking and validated exact entry | `default`, display name; accepted value grammar is `#rgb`, `#rrggbb`, or `#rrggbbaa`; no backend color-space or alpha-slider semantics exist | `widgets/test/widget-matrix.test.ts`, `app/test/ModalSurface.dom.test.tsx`, `canvas/test/registry-painter-label.test.ts`, `e2e/widget-editors.spec.ts` |
| `COMPOSITOR` | `core.compositor`: saved command count, or a run-first prompt | Existing full-center Image editor in Compositor mode; selected-run ImageDocument and bounded layer previews plus layer order, visibility, opacity, all declared blends, transform, flips, canvas, background, and atomic Apply | Exact fieldless descriptor on concrete `dinkster.compositor`; version 2 commands bound to the runtime document digest and at most 50 layers | `core/test/compositor.test.ts`, `core/test/dinkster-wire41.golden.test.ts`, `widgets/test/widgets.test.ts`, `app/test/CompositorEditor.dom.test.tsx`, `e2e/compositor-editor.spec.ts` |
| `COMBO` | `core.select`: selected static or remote label, shared-edge-centered down chevron with a separate 12px text reserve, and optional refresh-controller chip/menu | Anchored searchable option popover for filtering, keyboard and folder navigation, per-option info, refresh, and errors; no duplicate controller control | typed static `options` with exact value plus optional label/info/folder presentation; optional remote route, refresh button, refresh controller metadata, retry/timeout/refresh hints; display name | `widgets/test/widgets.test.ts`, `widgets/test/widget-matrix.test.ts`, `core/test/dinkster-wire23.golden.test.ts`, `canvas/test/registry-painter-label.test.ts`, `app/test/ModalSurface.dom.test.tsx`, `app/test/combo-search.dom.test.tsx`, `e2e/widget-editors.spec.ts`, `e2e/dynamic-combo.spec.ts`, `e2e/seed-controller.spec.ts`, `e2e/widget-trailing-actions.spec.ts` |
| `ASSET` | `core.asset`: selected name, `N assets`, or `no asset` | Native product dialog with shared `CollectionPanel`, upload for non-model kinds, image/video preview, details, a right-side selection panel with a staged-selection Remove action, Cancel, and a primary Use-asset commit; modal warranted: yes, for a focus-contained browser | declared type determines single/list/merge selection; top-level semantic `kind`; MIME `accept`; `default`; display name; AssetRef digest/name/size/media type/virtual path; classified image uploads are limited to 256 MiB, audio/video and latent uploads to 1 GiB, and generic uploads to 16 MiB per file; model upload is disabled | `widgets/test/widget-matrix.test.ts`, `app/test/ModalSurface.dom.test.tsx`, `app/test/asset-browser.test.ts`, `app/test/LogicalModelCollection.dom.test.tsx`, `e2e/asset-widget.spec.ts`, `e2e/asset-browser.spec.ts`, `e2e/logical-model-picker.spec.ts`, `e2e/w9-f8-media-upload.spec.ts` |
| `SAVE_TARGET` | `core.saveTarget`: mount, prefix, and descriptor-only suffix | Anchored mount/prefix popover with canonical declared type, declared output format, ready writable-mount choice, and grammar-validated prefix entry | `default`, display-only `suffix`, declared socket type, display name; mount and relative-prefix grammar; backend mount readiness/mode | `widgets/test/widget-matrix.test.ts`, `app/test/ModalSurface.dom.test.tsx`, `e2e/save-target.spec.ts` |

Unknown widget types and registered views without `editorUi` use the generic
shared text popover. A registered `editorUi` uses the host-decoded path above;
it never executes provider DOM. Only schema-less value sources use the existing
raw JSON fallback.

## COMBO editor

The COMBO editor keeps its search field focused while ArrowUp, ArrowDown,
Home, End, and typeahead filtering move the highlighted option. Keyboard
and programmatic highlight changes (including the initial value and options
arriving from a remote source) scroll the active option into the nearest
visible position. Pointer hover still updates the highlight, but never
auto-scrolls the list. This source distinction prevents a stationary pointer
near the list edge from creating a mouseenter -> scroll -> mouseenter feedback
loop while ensuring selected values are revealed.
If a remote refresh shrinks the result set, the highlight moves to the last
surviving row instead of resetting to the stored value or temporarily leaving
the list without an active option. This applies with or without a search query,
and COMBO and MULTI_COMBO use the same repair.

The option list renders at most 300 rows at a time. Filtering, keyboard
navigation, Enter commit, and folder navigation always operate on the full
filtered list, but oversized lists put only a highlight-anchored window of
rows in the DOM, so a multi-thousand-entry option list cannot freeze the
editor. The window is sticky: arrow keys and pointer hover reuse the existing
rows for as long as the highlight stays inside the window, so rows never
shift under a stationary pointer, and movement that leaves the window
re-anchors it in half-cap blocks. A deep initial value is visible on open
because the window follows the highlight. Clickable
status rows above and below the window report how many options are hidden
("N earlier options", "N more options - type to narrow") and jump the
highlight across the boundary. Lists at or under the cap render fully with
no status rows. Both COMBO and MULTI_COMBO share this windowing.

Static COMBO and MULTI_COMBO choices may carry a display label, explanatory
info text, and an explicit slash-separated folder path. The stored and
submitted value remains the exact schema value; labels and folders never
become aliases. Info appears below the label, and search matches labels, info,
folders, and exact values across the whole choice tree. With an empty search,
folders open as navigable list rows; Backspace or the Back control returns to
the parent. Folder paths are schema-authored presentation and are never
inferred by splitting a value or label. Remote choice routes continue to
supply flat string lists.

DynamicCombo selectors use the same editor, but their value controls which
branch rows exist. On a fresh node, a wire-15-or-later DynamicCombo displays
and stores the first option in schema order, matching Comfy's stock combo
lifecycle. DynamicCombo descriptor defaults do not override that choice. An
older imported document with absent state displays and submits the same first
option without being rewritten merely by viewing it. Pointer or keyboard
changes persist an explicit selection, and undo restores the explicit initial
first option on newly created nodes. Imported or restored valid selections are
preserved. Invalid stored selections remain a visible problem and never
silently fall back. Branch-local values remain stored while another option is
active and return when their branch is selected again.

## ASSET editor

The ASSET editor is a non-draggable, non-resizable native product dialog. The
dialog has an accessible name and description, native focus containment,
Escape and explicit-close operation, opener-focus restoration, and a bounded
body that scrolls internally on narrow or short viewports. A compact context
row reports actual selection cardinality, semantic kind, MIME accept
constraints, and the applicable upload limit. A distinct current-selection
region presents staged names and available media without displacing the
search-first browse region. The shared CollectionPanel keeps search primary,
shows filters only when active or requested, and owns source, folder, paging,
selection, cancellation, and stale-response behavior. Media adapters and the
logical-model adapter supply the same collection entry and pick contracts;
the shell does not own their data shapes. Loading, empty,
no-match, source-error, and unavailable-source states use the shared search
and notice vocabulary. Classified image fields report a 256 MiB limit; audio
and video fields report the backend-aligned 1 GiB limit; `data/latent` fields
use latent-specific browse, empty, search, upload, and dialog language with
the same 1 GiB limit. Generic asset fields retain their 16 MiB limit. Model
upload is disabled, so model dialogs do not advertise an upload limit.

The shared action footer presents upload status separately from Upload,
Cancel, and the primary commit button (`Use asset`, or a staged count under
multi-select). Removing the whole staged selection is a `Remove` action inside
the selection panel; like every pick it only stages until the footer commit.
Pending upload state disables competing
writes while Cancel remains available to abort the request. The visible Upload
file action is a product-owned button with keyboard,
focus-visible, disabled, accessible-name, and 32px-target behavior. It opens an
invisible native file input and restores focus after selection or cancellation.
The native input remains only because browser security permits the OS file
chooser and trusted FileList acquisition through that browser-owned control;
application UI cannot replace or synthesize that privileged seam. The input is
cleared after every selection so choosing the same file again still fires.
The widget's MIME `accept` list gates both the hidden file input and pick
compatibility, and the widget's semantic `kind` (a top-level field on the
decoded widget spec, e.g. `media/image`) seeds the panel's kind filter and the
pick predicate. Assets are not only images; the editor's labels and previews
treat non-image assets as first-class. Selected images retain their image
preview. A failed image decode becomes a labelled image-unavailable surface
with a direct download link rather than broken-media chrome. Selected videos
use the owning backend's asset URL in a host-owned
`<video controls preload="metadata">`; a failed video decode uses the same
semantic fallback pattern. Collection entries without previews use
kind-specific host icons for folder, image, video, audio, model, and generic
asset rows. Temporary image and video upload previews use object URLs that are
revoked when replaced or when the editor closes. Audio assets retain their
existing non-visual editor behavior. Selected canvas AssetRefs dispatch their
exact MIME channel through the shared PreviewRenderer registry. Matching
image/video renderer metadata qualifies the host-owned selected-asset
presentation; compact drawing and `viewerUi` do not render that surface.
Broad built-in MIME renderers are fallbacks, so a matching extension renderer
retains registry precedence.

Model kinds (`model/*`) use a logical-model data adapter inside the same
CollectionPanel as media kinds. The existing kind-scoped ready mount catalog is
scanned through its current client path, canonicalized by digest, and ingested
by the logical-model merge core. Single-variant models are plain rows;
multi-variant models alone receive a group header. Rows contain only name,
size, and availability. Aliases, digest, mount/provider provenance, known model
facts, conflicts, and download state appear only in the right selection
panel's Details disclosure. Unknown facts are not invented.

Models default to list mode; media defaults to grid mode. Both use the shared
primary SearchInput, listbox semantics, selected-row ring, staging contract,
and footer commit. Choosing an installed variant stages its exact five-field
AssetRef through the same path as a media row. Multi-select continues to stage
those exact refs for one Apply command. Refresh replaces the grouped result and
is idempotent. Model upload is disabled. Download remains disabled with the
missing-acquisition-contract explanation.

### Unresolved imported model names

An imported ASSET value can remain a plain string when no local asset matches
the foreign workflow's model path. This is a distinct
`widget.ASSET.unresolvedImport` error, not the generic malformed-value warning.
The Problems entry and existing canvas error treatment identify the node and
widget row. The message names the original path, its final basename, and the
schema's expected model kind. Save and reopen preserve the original string
until the user explicitly maps it.

Opening that row shows the original path verbatim, normalized basename,
expected kind, and MIME accepts above the existing kind-scoped local picker.
A picker choice commits one complete AssetRef through the ordinary
`node.setValue` command. Retry matching makes the read-only
`POST /api/assets/guess` query and lists only candidates complete enough to
form the five-field AssetRef; nothing is auto-applied. Cancel, close, and Escape
leave the string untouched. Transport failures remain inline and do not close
the editor.

The Download section is deliberately disabled. The backend exposes no asset
acquisition contract: there is no provider metadata with license/size/digest,
writable destination mount selection, or approve/execute/progress endpoints.
Workflow-provided URLs are neither linked nor fetched. The existing guess route
matches names and paths only; it cannot recover a renamed asset by digest
because the unresolved import supplies no digest query.

Upload preserves the selected File as the request body: the editor passes that
exact object to `DinksterConnection.uploadAsset`, waits for success, and only then
commits a five-field AssetRef whose name, size, and mediaType come from the
File. Component and client tests pin object identity, bytes, metadata, and the
absence of a document write before upload success. The separate native browser
arm in `packages/e2e/tests/image-upload-byte-proof.spec.ts` uses a deterministic
valid PNG larger than 256 KiB and proves POST, vault GET, graph, export/reopen,
and Load Image -> Preview Image execution. Historical job
`019fd935047563a88365345d68d1cd8a` recorded a 300047-byte source AssetRef
for digest `blake3:b584866aabc7b7bb0c4c1016b809254d71261e15db24b392a3cb15bb62398b07`
while the vault held 78840 bytes because a single request-stream read did not
guarantee EOF. Backend commit `6a5a1c23a25d7b24b8c01c49eec021d513eb4910`
fixed the read by draining chunks to EOF, and `0313abfefc96ac037591d25879bd11d2eb831a01`
made reads and execution verify content against the digest. No frontend
truncation workaround is part of this contract.

A typed ASSET whose semantic or MIME-derived browse kind is exactly
`media/image`, `media/audio`, or `media/video` uses the bounded media-ingest
route. This includes native `asset<comfy.VIDEO>` inputs without a
`sourceFilename` binding. Wire-22 `sourceFilename` declarations remain the
legacy classifier. The editor posts the original File bytes to
`/api/assets/media` with that media kind and a bounded display basename, then
adopts the returned canonical AssetRef verbatim. Model kinds and opaque assets
stay on generic `/api/assets` with the 16 MiB limit. Browser File metadata does
not define stored metadata or a path. MIME constraints support exact media
types and wildcard families such as `image/*` and `video/*`; browse rows use
the same matching rules. Image files may be up to 256 MiB; audio and video
files may be up to 1 GiB. `DinksterConnection`
passes the browser File directly to `fetch` as the request body, without base64
conversion or a JavaScript byte copy; the browser owns request streaming. The
frontend does not add a resumable or chunk protocol. Legacy source-filename
`list<dinkster.asset>` inputs upload sequentially and preserve selection order and
duplicate server refs. Cancel and mere dialog navigation do not commit.
`e2e/tests/w9-f8-media-upload.spec.ts` proves these rules with an isolated
route-mocked server.

A `data/latent` ASSET uses the existing classified `/api/assets/latent` route,
passes the selected File and owned AbortSignal, and adopts the returned
five-field AssetRef verbatim. It does not construct a latent reference from
browser metadata or use the generic digest-only upload path. Because browsers
do not reliably type `.latent` and `.safetensors` files, that classified route
validates their bytes instead of relying on the browser MIME value. The
surrounding picker changes presentation vocabulary only; `data/latent`,
`asset<comfy.LATENT>`, and the backend response remain the authority for kind,
compatibility, and stored identity.

Completed jobs may retain host-validated saved files as execution
artifacts. The client accepts at most 1024 exact
`{nodeId,digest,name,size,mediaType,virtualPath}` rows, each no larger than 1
GiB, and ignores the entire optional artifact field when any row is malformed.
The persisted `job_state completed` notification triggers one job read after a
normal live run. The execution tracks unknown artifact state separately from
an authoritative empty list, and reconnect reconciliation retries completed
runs that have not received a valid artifacts field. Artifacts remain separate
from graph output descriptors, are associated with their runtime node ID, and
use that execution's backend asset URL. Saved images, videos, and audio then
enter the same in-node preview renderer as ordinary execution media. A
completed node's saved media takes precedence over its pass-through graph
output, and multiple saved files use the shared preview pager.

Grid mode uses browse-sized cards with a 4:3 thumbnail above a two-line asset
name and badges. Hovering the name reveals the complete name and virtual path.
When a mount omits `kind`, the browser derives a display kind from common
image, video, audio, and model filename extensions; unrecognized extensions
show no kind badge rather than an `unknown` placeholder. Image, audio, and video
MIME types also supply their unambiguous `media/*` compatibility family, so a
mounted image row without backend `kind` metadata remains visible and pickable
under a schema-declared `media/image` filter. The source, kind, and search
controls wrap as space narrows, while the grid has its own scroll region and the
paging, upload, cancel, and commit actions remain outside it.
On narrow dialogs the bounded collection content owns overflow, preventing a
tall asset tile from extending beneath the collection footer.

Selection arity follows the input's DECLARED type (typed-assets joint pin,
mirrored in `docs/promises.md`):

- `list<asset<T>>` or `list<dinkster.asset>`: the editor multi-selects. Picks and
  uploads stage into a chip list (each chip has a labeled remove control);
  nothing commits until the footer commit button commits the staged selection
  as ONE array of AssetRef descriptors - N selections are N descriptors in a
  list literal, no new server surface. Cancel discards staged changes.
  Reopening the editor restores the committed selection.
- Every other declaration stays single-select with the same staging rule: a
  pick or a finished upload stages one descriptor into the selection panel
  (a new pick replaces it), and the footer commit button commits it and
  closes the dialog. Nothing commits from the list itself.
- `asset<list<T>>` deliberately stays single-select: its multi-ness comes from
  the decoder (one file producing many values), not from selection.
- The scalar merge arm of the pin (scalar `T` whose type is listed in the
  registry's `mergeableTypes`) multi-selects and stamps the asset list for the
  backend's registered terminal merge provider. Absent capability data never
  guesses mergeability and remains single-select.

The stored value for a multi-select input is an array of AssetRefs; the
compact canvas row shows the single name or an `N assets` count. The value
schema accepts arrays regardless of the declaration so a document always
loads; a cardinality mismatch surfaces as the backend's structural refusal at
submit, never a silently vanished value.

The selection panel's Remove action follows the same staging rule under both
arities: it stages an empty selection, and the footer commit then commits `[]`
under a list declaration or `null` under a scalar or scalar-merge declaration.
Cancel restores the stored value either way.

Multi-file uploads run sequentially and stop at the FIRST failed or refused
file - the error stays visible and later files never reach the server. The
editor is always a native modal; while a batch runs it additionally advertises
`data-dismiss-blocked`, prevents native Escape/close dismissal, and retains the
canvas host's capture guards as defense in depth. Global Escape is consumed;
outside pointerdowns, clicks, auxclicks (middle-click), double-clicks, and
contextmenus are swallowed entirely (they must not activate anything
underneath - clicking another widget would replace the editor with a fresh
mount and orphan the running batch, a lens switch would rebuild the scene
and close it, a middle-click would close the tab under it); keys whose event
path is outside the dialog are consumed too, so outside-focused shortcuts
(Delete, undo, the lens toggle) cannot change the document or scene behind
the block - EXCEPT that an outside Tab is not merely eaten: it pulls focus
back onto the first enabled control inside the blocked dialog, so a
keyboard-only user whose focus dropped to the body (the upload trigger disables
when the batch starts) can still reach Cancel; the footer commit and
selection-panel Remove controls plus the picker's own staging paths (click,
Enter) are
refused. Presses inside the dialog stay usable, and Cancel stays ENABLED as
the lock's escape hatch: it aborts the pending batch (the upload fetch
carries an AbortSignal), then closes with staging discarded and the stored
value untouched - so a server that never answers can never wedge the UI.
Editor unmount (a document/schema/scene rebuild tearing the dialog down) also
aborts the owned pending upload, not only Cancel - a stalled POST never
outlives its editor.
Everything unblocks when the batch settles. Without the host-level check the
guard would be dead code: the host sees those events before any editor-local
handler.

## Image editor

An `asset<comfy.IMAGE>` ASSET row with a complete writable PNG AssetRef offers
**Edit image**. PNG is the bounded source contract because its unassociated RGB
channels can be recovered without browser premultiplication; JPEG, WebP, and
untyped image-like ASSET rows refuse rather than opening a broken editor.
The same action is available from a selection only when exactly one selected
node has exactly one unambiguous writable image ASSET input. Frozen execution
tabs, linked or driven inputs, VIDEO assets, bare tensor outputs, output-only
previews, missing values, and ambiguous image inputs do not enter the editor.

The action switches that tab to the registry-resolved `image` center editor.
Its target is session-only and is cleared on cancel, apply, editor switch, or
tab close. Mask editing is a capability inside this editor, not a separate
editor kind. The source bytes are fetched from `/api/assets/{digest}`. Red
overlay intensity is the Load Image convention `1 - alpha`; source RGB remains
visible under the overlay. Paint and erase support local brush size and
hardness, clear, invert, pan, and zoom. Each pointer gesture records one
serializable local mask operation; undo/redo moves through that operation
history without dispatching commands or advancing the document revision.

Mouse and pen paint through the same normalized image-coordinate sample
stream. Pointer moves consume coalesced samples in reported order. Pen samples
retain time, pressure, tilt X/Y, and twist; the current round brush uses a
linear pressure curve from 25% to 100% diameter and from 0% to 100% opacity.
Mouse painting uses full pressure. The current round brush ignores tilt and
twist while retaining them in the operation.

A completed pointer gesture is one local operation. Pointer cancellation,
unexpected capture loss, target replacement, or editor teardown rolls its
live preview back instead of adding partial history. While a pen gesture owns
the editor, touch pointers are ignored for palm rejection. Touch never paints:
one finger pans, and two fingers pan and pinch with the graph canvas's shared
zoom clamps. The Canvas scroll behavior setting also applies inside Image:
Zoom is cursor-anchored, while Pan uses both wheel axes and keeps Ctrl+wheel as
cursor-anchored zoom.

For a schema-verified `dinkster.load_image` whose `mask` output has consumers,
Apply stores the cumulative edit recipe in one `dinkster.mask.paint` node and
rewires only those mask consumers. The guarded command copies the complete
loader AssetRef into `source`, preserves direct link identities and named nets,
and updates the associated paint node on later edits instead of nesting nodes.
It refuses changed source, topology, recipe, schema, and occurrence-local
topology. Recipes are bounded to 4 MiB, 2,048 commands, 8,192 points per stroke,
and 32,768 total points. Reopening the associated node restores its cumulative
operations. One workflow undo/redo covers insertion or update and rewiring.

Other admitted image inputs retain **Bake to asset**. Apply encodes one PNG
that preserves source RGB even under transparent pixels and writes the inverted
mask in alpha. After `/api/assets` accepts the bytes, the editor creates a
complete AssetRef and dispatches exactly one `image.applyAsset`. The command
requires the source digest still to match, so collaboration rebase drops an
apply if another edit replaced the source. Upload failure keeps the editor and
source visible. A rejected command, deleted or changed destination, tab close
during upload, or Cancel does not claim success or write the document.

The editor remains a flat source plus mask operations. It does not define a
layer stack or general operation-stack document. Graph persistence is limited
to the published mask-paint recipe; other targets flatten to one AssetRef.
The inspected before/after and mask-tool frames are under
`dinkster-evidence/frontend/issue-310/`; pen/touch navigation frames are under
`dinkster-evidence/frontend/issue-280/`; graph-native mask apply is under
`dinkster-evidence/frontend/issue-400/`. The physical Huion Kamvas Pro 24 report and paired
screenshots in that folder record pressure-responsive width and opacity,
coalesced input, one-operation undo, capture-loss rollback, unchanged document
revision, and the available pen capabilities. That device exposes no touch HID
collection; Chromium coverage pins palm rejection and touch navigation.

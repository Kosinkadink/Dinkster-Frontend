# UI layout audit

All native scroll containers inherit the app-wide scrollbar convention from
`packages/app/src/styles.css`: an 8px dark track and rounded thumb for
WebKit/Blink, with matching `scrollbar-width: thin` and `scrollbar-color` for
Firefox. Components declare only their overflow behavior and do not duplicate
scrollbar rules or introduce a JavaScript scrollbar layer.

`packages/e2e/tests/ui-audit.spec.ts` opens every widget editor surface in a
real browser with the real stylesheet and holds it to the geometry
invariants in `packages/e2e/tests/ui-audit.ts`. It exists because
behavioral e2e coverage proved blind to total visual wreckage: on
2026-07-25 every asset test passed while the real ASSET editor rendered a
30px item sliver, a 220x184px Choose button overlapping it, 68px-tall
toolbar selects, and an 18px search input. Playwright happily clicks
sliver-width and overlapping controls; presence and behavior assertions say
nothing about what a human sees.

## Invariants (auditLayout)

Within an audited root element, the audit reports a finding when:

- the root extends outside the viewport;
- any element with non-visible overflow hides horizontal overflow
  (content pushed out of a card is a bug even when technically scrollable);
- any control (button, select, input, textarea, option row) is under 24px
  wide or 16px tall - a sliver no one can read or hit;
- any single-line control (button, select, non-file input) is stretched
  past 48px tall - a control rendered as a block;
- any `role=listbox` surface is under 100px wide;
- any two visible controls overlap by more than 6x6px (after clipping by
  scroll containers; ancestor/descendant pairs are fine).

Scrolled-out rows inside an overflowing list are clipped to nothing and
skipped - legitimate scrolling is never a finding.

A spec asserts the finding list is EMPTY, so a failure prints exactly which
element violates which invariant. The suite also carries a sensitivity pin
that re-injects the broken 2026-07-25 CSS and requires the audit to flag
it: the invariants cannot be silently weakened past the failure they were
born from.

## Screenshots for agent scrutiny

Every audited test saves a full-page screenshot via
`test.info().outputPath(...)`, so after

```bash
cd packages/e2e
npx playwright test tests/ui-audit.spec.ts
```

the shots are under `packages/e2e/test-results/ui-audit-*/editor-*.png`.
An agent (or human) reviewing UI work must open and look at them - the
audit catches geometric wreckage, but only eyes catch ugliness, wrong
affordances, or misleading states.

## Covered surfaces

INT, FLOAT, STRING, multiline STRING, COLOR, static COMBO, ASSET (populated
browser; with a selection + detail rail; and on a 460px-wide viewport where
the rail must wrap below the item list), SAVE_TARGET.

The narrow-viewport state first caught the historical draggable ASSET card
growing past the viewport bottom after its detail rail wrapped. INT, FLOAT,
STRING, COLOR, COMBO, and SAVE_TARGET now use small anchored popovers with
shared viewport clamping and internal overflow; ASSET alone uses the native
product dialog and its generic viewport bounds. The non-ASSET popover layer
is pointer-transparent outside the solid editor. Geometry review must be
paired with the `widget-editors.spec.ts` same-gesture proof: one outside canvas
pan both dismisses the editor and moves the viewport, with no transparent
full-screen catcher intercepting the gesture.
The batch-end E2E run also caught tall grid cards escaping the collection
content box while the footer covered their click target. The ASSET collection
content owns overflow, so entries scroll within its bounded area and the
footer remains separate.

## Adding a surface

When a slice adds or reshapes any editor dialog, panel, or overlay:

1. add a test to `ui-audit.spec.ts` that opens the surface in its most
   populated realistic state (audit empty states too when they have layout);
2. call `auditSurface(page, name, rootSelector)` (screenshot + audit + close);
3. run the suite and LOOK at the saved screenshot before shipping.

The audit is intentionally generic - it needs no per-surface tuning. If a
legitimate design violates an invariant (for example a deliberately huge
button), raise the design in review rather than special-casing the audit.

## Product-owned tooltip and search chrome

Non-shell information targets use the shared product tooltip controller, not
the browser `title` bubble. Runtime diagnostic codes, memory-bar segments,
collection entries and mode controls, node-palette port types and pending-link
filter, and App view read-only hints preserve their previous wording in
`data-tooltip-label`. Informational spans and read-only hints are keyboard
focus stops with explicit accessible labels and focus rings. Delegated DOM
tooltips open on pointer hover or keyboard focus and neither path changes the
workflow document.

Collection search suppresses the WebKit search-cancel pseudo-element. A
product-owned Clear search button appears only for a non-empty controlled
query. It is labelled, Tab-reachable, Enter/Space-operable, focus-visible, and
uses the input's ordinary `input` event path. Escape in a non-empty search
field uses that same path and leaves the collection open; clearing never
changes the workflow document.

The remaining shell, surface, and minimap native tooltip seams are closed too.
Execution rows and their pin action, backend labels and engine state, the tab
backend selector, replacement-review state, collaboration status, surface
delete/unbind/broken-binding controls, and the minimap bookmark switch now use
`data-tooltip-label` with explicit accessible names. Noninteractive status
targets and broken bindings are keyboard reachable. An execution submitted by
another client keeps its disabled action but exposes the same wording through a
focusable tooltip wrapper, so keyboard users are not asked to focus a disabled
button. The pin keeps propagation isolation and gains Enter/Space operation;
the minimap switch keeps its `aria-checked` setting contract. Exact source
markup is pinned by `shell-surface-tooltips.test.ts`. Existing execution-overlay
browser coverage pins pin/open propagation. Representative isolated Chromium
hover, independent keyboard focus, accessible naming, switch toggling, and zero
document-revision proof for shell, surface, and minimap targets lives in
`tooltips.spec.ts`.

## Product checkbox and radio controls

Checkboxes use the shared `ProductCheckbox` button rather than browser checkbox chrome. The control has a 24px minimum hit target, visible keyboard focus, native button disablement, and controlled `aria-checked` state. Boundary exposure adds the `mixed` state for narrowed subtrees and retains Enter alongside Space. Existing wrapping rows remain clickable, while settings keep their explicit label-to-control association.

Imported asset choices use `ProductRadio` inside one named radiogroup per unresolved query. Candidate names derive from their complete visible content so confidence, source, size, and warning text remain available to assistive technology. ArrowLeft, ArrowRight, ArrowUp, and ArrowDown wrap through enabled choices, skip incomplete disabled candidates, move focus, and select exactly once. Focus and navigation do not mutate the workflow document. The isolated Chromium proof is `e2e/tests/audit-f5-proof.spec.ts` on strict port 5358.

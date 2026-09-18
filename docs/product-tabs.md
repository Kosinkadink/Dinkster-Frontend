# Product tabs primitive

`ProductTabs` is the dependency-free presentation primitive for tabbed product
surfaces. It does not read or write application or document state. Consumers
provide stable tab ids, labels, panel content, and an accessible name through
`ariaLabel` or `ariaLabelledBy`. Tab ids must be unique within the primitive;
duplicates fail loudly instead of producing ambiguous ARIA relationships.

Workflow document tabs deliberately use `WorkflowTabs` instead. That shell
primitive owns document activation, dirty/shared/frozen state, close flows,
pointer reorder, focus restoration, and horizontal document overflow. Those
behaviors are not options on `ProductTabs`. Its new-workflow button follows the
last document inside the horizontal overflow strip, so it remains adjacent to
the tabs and reachable by scrolling.

The primitive supports controlled selection with `selectedId` and `onSelect`,
or uncontrolled selection with `defaultSelectedId`. Disabled tabs use native
button disablement and are never selected by pointer or keyboard activation.
When tabs change dynamically, an unavailable selection moves to the nearest
enabled tab. Focus follows that replacement when the removed tab owned focus.

An optional `trailing` element renders in the tab row after the tablist,
outside the `tablist` role, for host-owned actions (for example the right
dock zone's header-action/close cluster). It never participates in the
roving-tabindex traversal.

## Accessibility and keyboard contract

- The container, triggers, and panels use `tablist`, `tab`, and `tabpanel`
  roles.
- Every trigger and panel has a resolvable `aria-controls` or
  `aria-labelledby` relationship.
- Exactly one enabled selected trigger is in the Tab order.
- Arrow keys wrap through enabled tabs and activate on focus. Home and End
  move to the first and last enabled tabs.
- Tab from the active trigger enters the active panel.
- Focus-visible outlines and disabled colors use the product control palette.

Horizontal is the default orientation. The orientation property keeps the API
ready for vertical product surfaces and maps their navigation to Up and Down.

`packages/app/test/ProductTabs.dom.test.tsx` proves ARIA wiring, controlled and
uncontrolled behavior, disabled skipping, traversal, activation, and dynamic
add/remove focus safety. `packages/e2e/tests/audit-tabs-proof.spec.ts` proves
the keyboard, focus-visible, relationship, dynamic focus-repair, external-focus,
and zero-document-revision contract in isolated Chromium.

The right dock zone consumes this primitive through `DockZoneHost`
(`ShellChrome.tsx`): registered rail panels render as tabs with one visible
body, per user direction that the right panel's sections read as placed
tabs. Tab membership, order, and the active tab live in `DockLayout`, not in
this primitive (see `docs/shell.md`, "The right zone").

# Touch, wheel, and trackpad navigation

How the canvas responds to touch, wheel, and trackpad input (issues #279 and
#288).

## Gestures

- **One finger** behaves like the left mouse button: drag a node to move
  it, drag empty canvas to pan, tap to select. All existing gesture
  semantics apply unchanged.
- **Two fingers** navigate the viewport: moving both fingers together pans,
  and changing the distance between them zooms about the finger midpoint
  (the world point under the midpoint stays under it). Zoom clamps to the
  shared wheel-zoom limits in `packages/canvas/src/zoom.ts` (0.05-4).

## Wheel and trackpad scrolling

The persisted **Canvas scroll behavior** setting has two modes:

- **Zoom** is the default and preserves the ComfyUI-like behavior: wheel and
  two-finger trackpad scroll zoom about the pointer.
- **Pan** maps ordinary horizontal and vertical wheel/trackpad deltas to
  canvas movement. `Ctrl`+wheel zooms about the pointer instead; macOS
  trackpad pinch arrives through this path with `ctrlKey` set.

The setting does not guess whether an event came from a mouse or trackpad.
Pixel deltas apply directly, line deltas use 16 CSS pixels per line, and page
deltas use the visible canvas width or height. Touchscreen two-finger
navigation and pointed minimap wheel zoom are unchanged.

## Rules

- A second finger placed during a one-finger touch gesture cancels that
  gesture (nothing is committed to the document) and starts navigation.
  A gesture held by mouse or pen is never interrupted; extra touches are
  ignored while it runs.
- While two fingers navigate, all other input is inert: extra fingers do
  nothing, and mouse/pen presses are swallowed.
- Lifting either navigating finger ends navigation. The remaining finger
  does nothing until a new second touch pairs with it.
- Two-finger navigation is viewport-only. It never edits the document, so
  it needs no undo entry and survives scene rebuilds mid-gesture.

## Implementation

The pure touch math lives in `packages/canvas/src/touch-nav.ts`
(`touchNavViewport`); pure wheel policy and shared zoom clamps live in
`packages/canvas/src/zoom.ts` (`wheelNavigationViewport`). Tracking and input
ownership live in `packages/canvas/src/interaction.ts`. Invariants and failure
modes are recorded in `hazards.md` ("P4. Two-finger touch navigation"). Unit
coverage: `packages/canvas/test/touch-nav.test.ts`,
`packages/canvas/test/zoom.test.ts`, and the "two-finger touch navigation"
suite in `packages/canvas/test/interaction.test.ts`. Browser coverage:
`packages/e2e/tests/touch-navigation.spec.ts` and
`packages/e2e/tests/canvas-wheel-navigation.spec.ts` on the production canvas.

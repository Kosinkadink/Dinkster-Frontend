# Timeline viewport

`TimelineViewport` is the document-independent navigation surface for a
node-backed timeline editor. It is not registered as a complete editor and
does not define a timeline serialization format.

The caller supplies duration, frame duration, playhead seconds and a seek
callback. Arrow keys step by the supplied frame duration, including fractional
frame rates; Home and End seek to the boundaries. Clicking the ruler or changing
the seconds field seeks on that frame grid. Zoom changes only view scale;
Fit timeline resets zoom and horizontal scroll. Lane labels remain visible
while every lane scrolls on the same time axis. Tick allocation is bounded.

`TimelineLane` accepts caller-rendered content. The viewport supplies width and
pixels per second, not a second clip/track model. Selection, poster/thumbs,
audio and curve controls belong to the caller. No source bytes are fetched,
decoded, saved or modified by either component. An unavailable owner or absent
timing displays a refusal and removes seekable content rather than substituting
a frame rate or presenting stale lanes.

## Integration boundary

The complete editor requires the canonical backend document, widget/node
schemas and OTIO/render contract from
[the timeline backend](https://github.com/Kosinkadink/Dinkster/issues/1260).
The viewport has no save, trim, split, ripple, roll, effect, audio-mix or OTIO
commands. It must not be presented as satisfying
[the timeline editor acceptance criteria](https://github.com/Kosinkadink/Dinkster-Frontend/issues/405).

An integrating editor must render lanes directly from the authoritative
document and save through the graph command path, preserving asset digests,
effect references, audio semantics and automation. It must use advertised
bounded renditions for preview, not original VIDEO bytes that ignore lazy
edits. The backend render remains authoritative. The missing schema must not
be replaced by a UI-only timeline model or invented service routes.

## Verification

- `app/test/timeline-view.test.ts`: tick bounds and fractional-frame seeking.
- `app/test/TimelineViewport.dom.test.tsx`: controlled state, scale, shortcut
  isolation and unavailable-owner/timing refusals.
- `e2e/tests/timeline-viewport.spec.ts`: the actual component with explicitly
  labeled layout fixtures, selection, seeking, synchronized zoom/scroll,
  narrow layout and refusal screenshots. It asserts no media API requests.

The browser fixture is not a backend simulation or render/OTIO round-trip test.

## Preserved source

The `timeline-viewport` branch retains the viewport and its standalone fixtures:

- `packages/app/src/TimelineViewport.tsx`: controlled viewport and lane components.
- `packages/app/src/timeline-view.ts`: bounded ticks, time labels and frame-grid seeking.
- `packages/app/src/timeline-viewport.css`: ruler, playhead, lane and toolbar layout.
- `packages/app/test/TimelineViewport.dom.test.tsx`: component interaction contract.
- `packages/app/test/timeline-view.test.ts`: tick and seeking unit tests.
- `packages/app/test/fixtures/timeline-viewport.tsx`: synthetic document-independent lanes.
- `packages/e2e/tests/timeline-viewport.spec.ts`: real-browser fixture interactions and captures.

The branch also retains `packages/canvas/src/scene-audit.ts` and
`packages/canvas/test/scene-audit.test.ts`. These audit graph-scene geometry,
pin identity and link endpoints; they are not a timeline document model or
an integration of the viewport with the graph editor. Other canvas tests
call `auditScene` as an additional geometry assertion.

The viewport is not reachable through a registered product editor. Its
fixtures demonstrate navigation and layout only. A usable timeline still
needs the authoritative document and render contract described above,
editor registration, document-backed lane content and graph commands for
editing and persistence. Nothing in this branch supplies those missing
contracts or changes how existing image, video or graph editors work.

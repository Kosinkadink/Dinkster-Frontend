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

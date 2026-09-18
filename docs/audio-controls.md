# Audio previews and recording

Canvas and App previews share one audio transport. Executed AUDIO values show
the server's effective duration, sample rate, channel count and layout verbatim.
Unknown facts say "Not reported". No channel-count or speaker-layout allowlist
controls admission.
Source probe facts are not substituted for the edited value's effective facts.
Inspection preserves the source/probe/ordered-edit payload and metadata, including
shape `[B,C,T]` and codec version. Sample-based trim edits are not curve times:
audio CURVE points use `{position: seconds, value: strength}` objects.

The transport negotiates `waveform` and `window` parameters, defaults, limits
and renderer version from the value descriptor. Kind names alone grant no
selectors. Waveform dimensions use provider defaults capped by provider limits
and the UI's 512x128 pixel budget. WAV windows use the provider's default duration,
capped by its seconds/sample-value limits and the UI's three-second/32 MiB budget.
Known channel count/rate further constrain window length. Missing capabilities
disable the corresponding controls and explain why; no full-audio fallback or
local waveform decode occurs.
The existing first-batch `wav` rendition is not a bounded `window` fallback.

The position slider uses the effective timeline; playback advances window by
window. `element` remains nested-list descent only. Batch Previous/Next sends
the independent `batch` selector only when advertised, starting at the provider's
declared batch default. A new window cancels the previous request; unmount releases
media URLs and pending work. Client rendition caching remains capped at 64 entries
and 64 MiB, with provider version and selectors in its identity. Refusals and
browser decode failures remain visible. `X-Dinkster-Waveform: sampled-peak` is labeled
as sampled, not exhaustive, peaks; absent sampling metadata is not inferred.
When effective duration is unknown, only the first bounded window is playable;
the scrubber is disabled rather than presenting that window as the full duration.

Loop and gain (0-100%) affect preview playback only. They never append edits or
change stored audio. An artifact without an executed AUDIO descriptor retains
its explicit download but cannot supply window playback. Selected local input
assets can use browser playback; server waveform inspection requires execution.
Recorded audio downloads fetch only after a click and use an owned blob URL
to preserve filenames across origins. Closing the preview cancels a pending
download; failures remain visible and permit an explicit retry.

Typed upload-enabled audio asset pickers offer **Record microphone**. Discovery
does not capture audio. Recording requests browser permission only after a click;
the browser default or a discovered microphone can be selected. Recording stops
after the chosen 1-300 seconds (60 by default), or refuses above 32 MiB. Pending
permission times out after 30 seconds. Stop, discard, cancellation and closing the
picker release microphone tracks; late permission results are also released.
Missing devices, permission denial, unsupported browsers, empty recordings and
upload failures remain visible. **Save recording** stages the browser-encoded
clip through the ordinary classified audio-asset upload. **Apply** commits the
server-authored AssetRef. Cancel leaves the graph unchanged. Backend acceptance
of the browser's recording codec is authoritative; bytes are not converted.
Codec parameters are removed from the upload MIME. Chromium audio-only WebM
remains `audio/webm`; browser MP4 recording is outside this acceptance boundary.

The curve editor follows audio only for the exact typed graph relation
`dinkster.audio.envelope.curve -> dinkster.curve.editor.curve`. Direct links and named
nets preserve that relation. After an exact completed run, the editor displays
the retained envelope's authoritative `curve-points` rendition on a seconds
axis and remains read-only; it never copies computed points into graph state or
history. A playhead appears only for the AUDIO source linked into that envelope.
Unrelated audio previews do not affect it. Missing, stale, ambiguous or changed
provenance and executions are refused or cleared. Ordinary editable curves keep
their 0-1 position axis and never infer audio-follow behavior.

`audio-preview.test.ts`, `AudioRecorder.dom.test.tsx` and
`audio-controls.spec.ts` cover bounded negotiation, arbitrary channel counts,
independent list/batch selectors, provider limits/defaults/version, sampled-peak
labels, permission/device failures, cancellation, duration limits, waveform/window
rendering, loop/gain neutrality and recorded AssetRef staging. Browser tests
use route-mocked value/upload responses and a generated MediaStream with the
real browser MediaRecorder. Native acceptance covers validated audio-only Opus
WebM upload, AssetRef staging, `dinkster.load_audio`, and WAV rendition in
`audio-recording-live.spec.ts`. Physical
microphone acceptance runs headed Chromium with `DINKSTER_PHYSICAL_MICROPHONE`
set to an exact browser device label. It leaves `getUserMedia` native, pins the
selected live track and its release, proves MediaRecorder/upload byte equality,
then loads the clip and requires a non-silent three-second PCM window. The
committed station17 C920 receipt excludes raw audio and OS device identifiers.
Permission-denied and no-device states remain in deterministic browser coverage.
`AudioTransport.dom.test.tsx`, `editors.test.ts`, and `curve-editor.spec.ts`
cover exact envelope provenance, bounded computed points, linked-audio playhead
isolation, reactive refusal, and graph/history neutrality.

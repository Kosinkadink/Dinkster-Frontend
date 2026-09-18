# Media inspection

The Outputs panel offers an **Inspect node / output** disclosure for recorded
native media values, including intermediate outputs reported by node events rather
than only final job targets. Opening it requests metadata from the backend that
owns that execution, using the original job, runtime node and output IDs. It does
not download media, materialize a waveform, decode video, or edit the workflow.
Unavailable owners and refused or expired values remain visible diagnostics.

IMAGE rows show layout, alpha mode, dtype, storage dtype and color declarations.
MASK rows show polarity and semantic. AUDIO rows show sample rate, channels,
layout, duration and dtype. VIDEO rows distinguish the admitted source probe
(container, codec, pixel format, alpha, bit depth and color space) from the
effective lazy-edited duration, FPS and frame count. Rational video facts retain
their exact numerator/denominator representation. Missing facts say **Not
reported**; missing alpha metadata is not interpreted as opaque pixels.
Inspector summaries, statuses, fact labels, metadata labels and Boolean alpha
values use the shared application catalog. An open inspector follows mounted
locale changes without another descriptor or rendition request. Runtime and
output IDs, type IDs, fingerprints, metadata values, refusal reasons and errors
remain untranslated.

Image output thumbnails, the output viewer, canvas previews and App View use a
checkerboard behind transparent pixels. The background is presentation-only and
does not bake into the image or affect downstream mirror inputs.

When a server rendition includes `X-Dinkster-Color-Transform`, canvas and App View
captions show its conversion label as **Preview color**. App View calls that
download **Download preview**, not the original output. The frontend does not
infer a conversion from HDR metadata or apply another transform to the returned
bytes. Source descriptors, fingerprints and graph values remain unchanged.

Unexpected alpha loss (`alpha_dropped`) and incompatible mask polarity
(`mask_polarity_mismatch`) appear as node badges and a Media diagnostics section
in Outputs. The section names the runtime node and affected output or input.
Asset-coercion loss preserves its singular input ID; node-output loss preserves
all contributing input IDs. Distinct receipts share one badge per affected port.
These warnings do not fail execution or change values. They remain separate
from execution errors and log messages. Their heading and fact labels follow the
active locale in place without changing diagnostic row identity or requesting
new schema, diagnostic or backend data. Diagnostic codes, node/output/input IDs
and expected or actual polarity remain exact backend values.

Schema wire 39 preserves ordinary inputs that accept storage-backed values.
Schema wire 40 preserves declared alpha policies, mask polarity and mask
semantics on typed ports and in registry identity. Older schema versions do
not accept their respective declarations. The inspector reports value metadata
rather than inferring pixel properties from a port policy.

Schema wire 41 adds recursive `stream<element>` types, ordinary-input
`acceptsStream`, and scoped `chunkSafe` declarations while retaining wire 39
storage/descriptors and wire 40 media policies. Stream acceptance is Boolean:
false normalizes to omission; non-Booleans and any field presence below wire
41 are refused. Stream acceptance declares a range-aware consumer, not a
separate cardinality. Chunk safety declares frame/sample-range preservation,
names existing inputs/outputs and may be scoped to DynamicCombo options.
Uncovered options lose chunk-safety and stream-acceptance claims; materialization
is backend-owned. These declarations survive catalog loading and registry identity;
they do not invent a browser stream endpoint, polling ticket, chunk events,
or a full-source download fallback.

STRING presentation fields introduced at wire 19 remain valid on later wires
without an explicit multiline flag, including native video path placeholders.
Malformed descriptors and unknown alias metadata remain refused.

The values client accepts frame indices or second timestamps, thumbnail counts,
waveform dimensions, audio windows and nested element selectors for advertised
rendition kinds. Selectors and server ETags distinguish cached bytes. Both
descriptor and rendition reads accept an AbortSignal; cancellation and transport
failures return structured refusals, and incomplete reads are never cached.
Each connection retains at most 64 rendition entries and 64 MiB of encoded bytes;
larger individual responses are returned without caching or evicting previews.

# Implementation selection

Node cards describe workflow intent, not runtime plumbing. They do not show
execution-arm tabs such as `NATIVE` or `COMFYUI`, and they do not show pack
chips such as `DN`.

Vision nodes omit the internal `provider` input from the canvas, App View,
palette previews, type filters, and automatic connection targets. Existing
workflows that stored a provider value keep that value when loaded, edited,
compiled, and saved. New workflows leave the compatibility input unset so the
backend can choose a compatible installed implementation.

When different model families change the result, the node exposes a normal
human-labelled model choice with `Automatic` as its default. This is user
intent; a package identifier is not. Text generation runs natively by default.
Its optional `Service` choice appears inside a collapsed `Advanced` section and
shows `Built-in` until the user explicitly selects a configured
OpenAI-compatible service labelled by purpose rather than package name.

Implementation facts remain available where they explain a run. Live progress,
local execution history, and durable run receipts retain the selected arm,
provider, pack, and machine when the backend reports them. Later progress or
error events that omit those facts do not erase an earlier attribution.

Provider-declared model assets are checked during submission preflight after
the backend resolves the implementation. Missing assets use the existing
digest-specific acquisition consent flow; node execution never downloads them
implicitly. If no compatible implementation is available, submission returns
an actionable capability error instead of presenting an empty selector. The
error names and highlights the responsible node, explains the missing
human-facing capability, and tells the user how to make it available.

Schema wire 38 carries the hidden compatibility marker. Advertised older wire
versions remain frozen and reject that marker.

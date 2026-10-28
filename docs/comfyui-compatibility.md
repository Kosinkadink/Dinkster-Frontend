# ComfyUI workflow import

Dinkster imports ComfyUI workflow JSON into its native document model. It does
not connect to a stock ComfyUI server: backend connections, schema discovery,
execution events, submission, and artifact previews use the native Dinkster API.
Persisted stock backend entries are not restored as native connections.

The workflow importer is the single conversion entry point. It preserves authored
node and port identities and resolves links against native type names. Positional
`widgets_values` account for `control_after_generate`, including its legacy boolean
form. Per-node upgrades are keyed by node class and source version; importing does
not insert helper nodes, rewrite node types, or bridge filename prefixes.

SaveImage and SaveVideo expose mount selection beside `filename_prefix` on the
same node. Their native schemas supply the controls; importing a workflow does
not synthesize a mount helper node. Preview and history media use native assets
and renditions rather than stock file-descriptor URLs.

Structural boundaries that can be represented without changing workflow meaning
are imported as native graph boundaries. Ambiguous structural drivers are refused
with diagnostics, without replacing the active document. Missing native node
families remain unresolved nodes and acceptance blockers, not evidence of runtime
compatibility.

Importer fixture and browser tests check conversion, persistence, diagnostics,
and native submission. Synthetic catalogs in those tests are contract fixtures,
not runtime parity evidence for a particular backend or model family.

## Removed-layer acceptance exceptions

The source search for removed compatibility layers in
[issue 511, criterion 6](https://github.com/Kosinkadink/comfy-vibe-station/issues/511)
permits references in layer index documents, the importer upgrade-rule table,
and exactly these unchanged historical audit files:

- `docs/archive/feature-coverage-audit.md`
- `docs/archive/frontend-extension-rfc.md`
- `docs/archive/widget-inventory-audit.md`
- `docs/archive/wire15-proposal.md`

No other archive path is exempt. Active documents and package source must not
retain removed-layer references. Acceptance publishes the full raw search output
at the frozen head on the issue, classifying every retained historical line and
every removed active match; a filtered zero-match result is insufficient.

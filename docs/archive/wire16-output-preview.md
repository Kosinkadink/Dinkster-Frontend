# Wire 16 output preview metadata

Schema wire 16 may put `preview` beside a top-level ordinary `output` or
`outputFamily` interface entry. The frontend accepts an exact Boolean. Missing
and false normalize to omission; true becomes `OutputSpec.preview?: true`.
Malformed values reject the node through the normal schema parse policy. Wire
15 and older decoders continue to ignore the field as unknown metadata.

The marker is presentation and discovery metadata only. It says that a final
output is offered as a generic run-and-show candidate. It does not say that the
value is renderable, retained, cached, live, editable, pure, preferred, or
supported by any runtime preview capability. In particular, it is separate
from runtime `report_preview` behavior.

An output-family marker applies to its elaborated members; there is no nested
output template in the backend contract. Elaboration and subgraph boundary
derivation preserve the marker. Compile, semantic hashes, scope closure,
topology, output indexes, layout, and rendering do not interpret it. This slice
adds no renderer selection, product UI, actions, routes, events, scheduling,
cache access, or runtime reporting behavior.

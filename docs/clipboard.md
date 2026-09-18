# Graph Clipboard

Dinkster supports copying and pasting graph selections with Ctrl+C and Ctrl+V on Windows/Linux or Cmd+C and Cmd+V on macOS. Ctrl+Shift+V or Cmd+Shift+V performs connected paste: valid links feeding the copied targets from unselected upstream nodes are recreated when those sources still exist in the current graph. Clipboard shortcuts are ignored while an input, textarea, select, content-editable editor, or native-text sidebar has focus, so text editing and Problems content keep the browser's native clipboard behavior.

When the OS clipboard holds an image, paste inserts it as a Load Image node
through the canvas file pipeline instead of reading the graph envelope; see
`canvas-file-drop.md`. The graph paste described here applies when no clipboard
image is present.

The node context menu also offers Copy for the clicked node or current node selection. The empty-canvas context menu offers Paste and anchors the pasted content at the menu invocation position. These entries use the same clipboard and paste command paths as the keyboard shortcuts.

## Envelope

The system clipboard receives JSON with this versioned outer shape:

```json
{
  "format": "dinkster-clipboard",
  "version": 2,
  "nodes": [],
  "links": [],
  "reroutes": [],
  "groups": [],
  "scope": { "lineage": "workflow-lineage", "graph": "g0", "token": "clipboard-1" },
  "externalIncoming": []
}
```

Node entries contain semantic node data, including values, controllers, dynamic state, mode, title, and extension data, plus their view state. Position, manual size, minimized state, sections, and selected views therefore survive paste. Reroutes include topology and position. A link is included only when both endpoints are included, which prevents references to nodes in the source document from leaking into another document. Unknown node types remain ordinary document nodes and use Dinkster's existing missing-schema placeholder presentation.

Version 2 preserves that self-contained `links` invariant. `scope` records the source document lineage and graph plus an app-issued provenance token used to prove that the original source-node incarnation is still owned locally. Incoming boundary links are separate stubs. An ordinary port source uses `{"source":{"graph":"g0","lineage":"workflow-lineage","node":"n0","nodeType":"Producer","port":"out","members":["m1"]},"target":{"node":"n1","nodeType":"Consumer","port":"in","members":["m1"]}}`. A widget-tap source uses the same shape with `"tap":"widgetInput"` instead of `port` and never has `members`. `members` is omitted for static port endpoints. This additive source variant stays inside version 2; existing port stubs retain their exact shape. Version 1 envelopes remain readable and behave as before; they have no external stubs.

Boundary input/output pseudo-nodes are derived UI objects and are never copied. Value sources, selectors, boundary bindings, and links to unselected items are not part of the clipboard. A group is copied only when the group itself is the copy target; spatially contained nodes alone do not imply group selection.

Version 3 adds `occurrenceTopologies`: closed occurrence-owner topology subtrees for copied drilled-instance owners.

Version 4 adds `nets`: named-net membership riding along with the copied nodes. A record carries the net name, its source endpoint plus the source node's type, and the copied sink endpoints. It is emitted when the selection contains the net's source node or at least one sink node, with sinks restricted to copied nodes. Envelopes without net membership keep emitting version 2 or 3, and version 1-3 payloads remain readable unchanged.

Version 5 adds `definitions`: the exact transitive graph and view closure required by copied subgraph instances, including nested subgraphs and authored named-net tag placement. This makes subgraph copy work across workflow tabs and documents. Paste reuses identical definitions, or assigns deterministic fresh definition IDs when the destination already uses an ID for different graph or view content. Same-document paste uses the current definitions and omits copied occurrence overlays that became stale after copying. The payload is rejected when a required definition is missing, recursive, malformed, or accompanied by unrelated definitions.

## Paste behavior

Paste accepts only versions 1 through 5 of the envelope above. Random text, foreign JSON, unsupported versions, and empty payloads are no-ops. Every pasted node, link, reroute, and group receives a fresh document-local id. Imported subgraph definitions and pasted topology land before unused dynamic members are compacted, all within the same command, so one Undo removes the entire paste and its cleanup. Compaction preserves referenced members and each family's high-water identity sequence. The pasted nodes and reroutes become the new selection.

Named-net membership pastes per `docs/architecture.md` section 5's collision policy, always within the destination graph definition (nets never cross graph or subgraph boundaries):

- A sink-only copy whose net name matches an existing net with a compatible source (same source node type, port, and member path) merges the pasted sinks into that net without duplicating a source.
- A copy that includes the net's source node always creates a net; on a name collision it takes the first free deterministic suffix (`name_2`, `name_3`, ..., case-insensitive).
- A sink-only copy with an incompatible or independently sourced same-name net is recreated under a suffixed name, wired to its recorded source when that node still exists in the destination graph; otherwise the membership is dropped and the nodes paste unconnected.
- An input driven by a pasted link never also receives a net sink.

Ordinary paste ignores `externalIncoming` and remains detached at selection boundaries. Connected paste validates each stub independently against the exact current graph, source and target node types, endpoint paths, and persisted dynamic member paths. Widget-tap stubs additionally require the source schema to still expose that exact static, memberless widget tap. Missing, stale, reused-id, ambiguous, or cross-graph endpoints are skipped without blocking pasted content or other valid stubs. It never reconnects outgoing selected-to-unselected links and never creates or recycles dynamic member ids. Internal links and valid incoming links land before automatic Autogrow compaction runs against the final linked snapshot, all within the same undoable batch.

When the pointer is over the canvas, the copied selection's top-left position is anchored to the pointer in world coordinates. When the pointer is outside the canvas, every copied position moves by +20, +20 from its original position. The JSON system clipboard enables paste across tabs and documents. If browser clipboard permission is denied, Dinkster retains the latest in-page copy in memory as a fallback.

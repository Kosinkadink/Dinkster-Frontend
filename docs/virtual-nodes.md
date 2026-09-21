# Virtual nodes and notes

Virtual nodes are frontend-owned document nodes. They save, load, copy, paste,
undo, and synchronize like ordinary nodes, but have no canvas ports and are
excluded from compilation, run planning, and the execution-semantic hash.
Registered kinds do not produce missing-backend Problems. They are for durable
workflow content that has no backend behavior.
Reroutes remain topology-bearing document constructs rather than virtual nodes.

Dinkster includes two virtual node kinds in the Add Node palette under Notes:

- **Note** displays plain text.
- **Markdown Note** displays headings, lists, emphasis, code labels, and link
  labels as formatted read-only content.

Both kinds use the normal multiline text editor, node title, color, move,
resize, clipboard, undo, and shared-document paths. Their text, title, position,
size, and color persist in the native workflow document.

ComfyUI `Note` and `MarkdownNote` nodes import as these visible nodes with their
text and view geometry preserved. The core LiteGraph translation API emits the
corresponding ComfyUI node records for export callers. The app's ordinary
workflow download remains the native Dinkster format. Other non-node document
constructs continue through their dedicated translation paths.

Packs declare a `virtualNode` manifest contribution and register the same id
through `PackActivationApi.virtualNode`. A `VirtualNodeKind` supplies its id,
title, optional description, widget schema, default values, and a pure render
callback. Registration requires the `graph-editor-canvas` privilege, follows
normal contribution gates and transaction rollback, and never grants direct
canvas or document access. A node is virtual only when its stored node data has
`virtual: true` and its registered schema declares `virtual: true`. An
unregistered kind retains its data and uses missing-schema presentation; a
virtual marker on an executable schema does not suppress execution.

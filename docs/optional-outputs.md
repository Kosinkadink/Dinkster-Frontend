# Optional outputs

An output socket with a hollow center may produce no value. Its type color
still shows what it produces when present, and hovering the socket names the
absence behavior. Connections from these outputs are dashed because absence
can propagate through the workflow.

Optional input sockets keep their hollow center after connection, so their
absence policy remains visible while reading a wired graph. Stored group
members use the same connected hollow treatment, even when their value is
required; a member the node shows but does not store yet remains a dim hollow
growth affordance (see [Node body](node-body.md)).
Optional outputs remain hollow because the producer may still omit a value
after connection.

# Recorded store events

`recorded-store-events.json` contains normalized events from the success,
cached, runtime-error, interrupted and validation-rejection recordings under
`packages/core/fixtures/events` at commit
`d76569d6840c06567e468977b7a40ce5ae143148`.

The records were normalized once with connection `c0` and each message's
recorded `t` as the normalizer clock. Event order, submission identities,
output payloads and error details are retained. JSON round-trip equality was
checked before writing the fixture.

These are inputs to the protocol-independent ExecutionStore, not current
native wire captures, a protocol decoder or runtime parity evidence. Native
normalization and transport tests remain separate from these store regressions.

## While / Until execution graph

`loop-while-until.json` retains the graph from Dinkster's preserved
`draft-nodes-before-first-party-packs-638` branch at
`728f58b22ccf6bb64c7e2b8ee38f35c69fbf4a75`, from
`packages/dinkster-nodes-foundation/src/dinkster_nodes_foundation/loop_while_until_template.json`.
Integer primitives, addition, comparison and preview use the current utilities
contracts. Primitive Int nodes provide typed boundaries for Math Expression
input families. The loop still has a limit of four and gathers its four steps.
This is execution test data, not a served template or a product starter.

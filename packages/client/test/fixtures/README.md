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

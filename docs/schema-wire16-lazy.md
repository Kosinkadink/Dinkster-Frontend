# Schema wire 16 lazy input metadata

Schema wire 16 extends the recursive wire-15 interface grammar with one field
on every ordinary input entry:

```json
{"role":"input","id":"value","type":{"kind":"concrete","types":["core.int"]},"lazy":true}
```

`lazy` is computation-semantic backend metadata. Under wire 16 it must be a
Boolean. Missing and `false` normalize to omission; `true` is preserved as
`InputSpec.lazy?: true`. The rule applies to top-level ordinary inputs and to
ordinary inputs nested in Autogrow templates, DynamicCombo branches, and both
DynamicSlot dependent forms. A non-Boolean value refuses the whole node schema
through the existing loud decoder policy.

Wire 15 is frozen: a field named `lazy`, like any other unknown additive input
field, is ignored and has no frontend meaning. The client advertises both 15
and 16. A wire-15-only backend can therefore select 15, while a backend that
publishes 16 can select 16. No common version remains the existing
machine-readable HTTP 406 refusal; the frontend never performs a lossy
downgrade.

## Frontend behavior boundary

The frontend preserves `lazy: true` through elaboration and boundary-derived
schemas because the backend needs it for canonical computation identity. The
frontend does not compute that identity. Lazy ordinary inputs remain ordinary
sockets with the same rows, pins, layout, topology, prompt bytes, and editing
behavior as absent/false inputs. Lazy is not a widget, `forceInput`, `advanced`,
`onAbsent`, selector, or dynamic-family discriminator.

This milestone does not add demand prediction, selector synthesis, cone
projection, client-side pruning, cache certainty, preview metadata or UI,
runtime preview behavior, widget changes, backend routes, or dynamic interface implementation-extension API implementation UI.

The cross-language fixture is
`packages/core/fixtures/dinkster-nodes-wire16.json`. The backend can consume the
same payload as a contract vector when wire 16 is published; frontend tests do
not require backend publication.

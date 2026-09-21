# Stock ComfyUI V1 compatibility

The stock ComfyUI protocol is an optional connection kind. Native Dinkster
startup, schema decoding, execution, and feature tests do not load its protocol
implementation. The compatibility entry is `packages/app/src/v1-connection-kind.ts`,
which exposes `@dinkster/client/comfy-v1`; the protocol decoder is exposed from
`@dinkster/core/comfy-v1`.

## Supported matrix

The pull-request matrix runs against stock ComfyUI commit
`15eb748b3ec5f8a0a2d470b7fb280e2d7579f916` on CPU. Its
`v1-compatibility` project runs the default workflows through the real HTTP and
WebSocket endpoints. The `native-without-v1` project replaces the V1 connection
entry with throwing exports and runs every native live E2E spec.

| Surface                                                                     | Stock ComfyUI V1 | Evidence                                                                                                |
| --------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| `/object_info` schema decode                                                | Supported        | Live schema load plus `object_info.json` parser tests                                                   |
| `/prompt` queue and validation errors                                       | Supported        | Basic and subgraph workflow queue tests                                                                 |
| execution and progress events                                               | Supported        | Live completion plus recorded success, cached, interrupted, runtime-error, and validation-error streams |
| binary image previews                                                       | Supported        | Default workflow output and recorded preview frames                                                     |
| `/history` reconnect reconciliation                                         | Supported        | Recorded stream replay and client reconciliation tests                                                  |
| `/interrupt`, `/queue`, and `/view`                                         | Supported        | V1 client unit tests and live output retrieval                                                          |
| native pack composition, extension events, collaboration, and schema epochs | Not available    | Native-only capabilities remain on the Dinkster connection kind                                         |

The recorded fixtures under `packages/core/fixtures/object_info.json` and
`packages/core/fixtures/events/` are deterministic decoder and replay
regressions. The live matrix is the compatibility claim for the pinned ComfyUI
commit; a fixture passing by itself is not a live compatibility claim.

## Dependency boundary

`pnpm check:v1-boundary` parses every workspace manifest and the static import
graph. It fails closed on malformed manifests, missing workspaces, syntax
errors, unresolved local imports, and non-literal dynamic imports other than
explicit Vite external-runtime imports. No native entry in `packages/core` or
`packages/app` may reach `connection.ts`,
`events/comfy-v1.ts`, `schema/object-info.ts`, or `schema/compat.ts`. The only
allowed app edge is the explicit V1 connection-kind entry.

The initial native edges and their dispositions are:

| Previous edge                                                   | Disposition                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `core/index.ts -> schema/object-info.ts`                        | Removed; exported only by `@dinkster/core/comfy-v1`                |
| `core/index.ts -> events/comfy-v1.ts`                           | Removed; exported only by `@dinkster/core/comfy-v1`                |
| `core/index.ts -> schema/compat.ts`                             | Native type compatibility moved to `schema/type-compatibility.ts`  |
| `compile/bypass.ts -> schema/compat.ts`                         | Uses native type compatibility                                     |
| `replace/plan.ts -> schema/compat.ts`                           | Uses native type compatibility                                     |
| `schema/derive-boundary.ts -> schema/compat.ts`                 | Uses native type compatibility                                     |
| `schema/solve.ts -> schema/compat.ts`                           | Uses native type compatibility                                     |
| `search-filters.ts -> schema/compat.ts`                         | Uses native type compatibility                                     |
| `value-source.ts -> schema/compat.ts`                           | Uses native type compatibility                                     |
| `format/import-litegraph-subgraphs.ts -> schema/object-info.ts` | Decodes imported boundary slot types without the V1 schema decoder |
| `client/index.ts -> connection.ts`                              | Removed; exported only by `@dinkster/client/comfy-v1`              |
| `client/index.ts -> reconcile.ts`                               | Removed; exported only by `@dinkster/client/comfy-v1`              |
| `client/collab-connection.ts -> connection.ts`                  | Shared fetch contract moved to `connection-contract.ts`            |
| `client/credentials.ts -> connection.ts`                        | Shared fetch contract moved to `connection-contract.ts`            |
| `client/dinkster-connection.ts -> connection.ts`                | Shared connection contracts moved to `connection-contract.ts`      |
| `client/discovery.ts -> connection.ts`                          | Shared fetch contract moved to `connection-contract.ts`            |
| `client/supervisor.ts -> connection.ts`                         | Shared fetch contract moved to `connection-contract.ts`            |
| `client/values.ts -> connection.ts`                             | Shared fetch contract moved to `connection-contract.ts`            |
| `app/app-state.ts -> client index -> connection/reconcile`      | Replaced by the explicit `v1-connection-kind.ts` edge              |

`packages/client/src/connection.ts` is the optional V1 implementation and is
intentionally reachable only through `@dinkster/client/comfy-v1`. No native
feature depends on that entry.

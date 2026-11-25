# Remote execution

The Dinkster engine supports execution placement on named machines connected to
the active backend. The browser talks only to that coordinating backend; it does
not connect to worker daemons or handle their credentials.

## Run on machine

The **Run on machine** entry is withdrawn from node and region context menus
pending the [workflow execution design decision](https://github.com/Kosinkadink/comfy-vibe-station/issues/1146).
The engine's placement support and the client's worker catalog remain available;
this withdrawal does not change execution attribution in finished runs.

## Execution location in history

Node events retain the worker name through progress and terminal updates.
Library **Runs** rows summarize receipt counts by machine and list each node's
disposition, execution arm, and machine. Local **History** lists the same known
facts for every observed node. Older servers remain readable and simply omit
machine attribution.

## Configuration and data movement

Workers are configured on the coordinating Dinkster server through its
`remotes.toml`; a remote daemon serves the node pack on the execution machine.
The server reports the implicit `local` machine and configured remotes through
`GET /api/workers`. Browser connection profiles are unrelated and never expose
remote-worker token contents.

Remote assets and values use the backend's existing digest-addressed staging
and persistent value transport. Operators configure the coordinator's
advertised asset endpoint when a worker must fetch missing job assets. Worker
authentication tokens stay in server-side files. Use certificate-pinned TLS or
an authenticated tunnel outside a trusted network; the token authenticates a
plaintext connection but does not encrypt it.

Losing a remote session fails affected in-flight nodes, and new placements to
that machine remain disabled until it reconnects. Runs are not resumed or
automatically repartitioned.

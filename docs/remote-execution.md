# Remote execution

Dinkster can execute selected root nodes on a named machine already connected to
the active Dinkster backend. The browser talks only to that coordinating backend;
it does not connect to worker daemons or handle their credentials.

## Run on machine

Right-click an ordinary node or region in the root graph and open **Run on
machine**. Right-clicking one node in a multi-node selection applies the action
to every eligible selected node. Connected machines are available when they
route every selected ordinary node type. Disconnected machines and machines
missing a selected node type remain visible but disabled. Regions remain
selectable because the backend validates their bodies recursively. Plain
subgraph occurrences and drilled subgraph views do not offer the action.

![Run on machine menu with connected and disconnected machines](https://raw.githubusercontent.com/Kosinkadink/dinkster-evidence/main/frontend/issue-298/run-on-machine-menu.png)

Choosing a machine submits the complete workflow and adds placement only for
the selected nodes or regions. Placement is transient job input: it does not
modify the workflow document or node fingerprints. The backend validates every
hint before queueing and never falls back to another machine. A selected node
removed by active-branch lowering stops submission instead of silently running
the rest of the workflow.

The menu appears only when the native backend advertises placement support.
Its machine list refreshes with the backend schema/composition catalog and is
invalidated immediately on reconnect, so an open menu cannot submit a stale
machine choice. Legacy ComfyUI backends do not expose this action.

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

# Headless collaboration demo

This example directory holds a Node 22+ participant for shared Dinkster
workflow sessions. It is not part of the pnpm workspace; it links the
`@dinkster/core` and `@dinkster/client` packages from this checkout through
relative `link:` dependencies. It can join a named session, discover the first
session in the app's `shared` scope, or create a session from a minimal empty
document.

After joining, it copies two nodes and their link when the workflow contains a
usable node-to-node link. Otherwise, it copies one node. The client marks the
first copy and moves it in four steps so a browser participant can watch the
update.

Node 22 or newer is required. The client uses Node's built-in `fetch` and
`WebSocket` implementations.

## Run against a local stack

Start a Dinkster backend and the frontend app, share a workflow from the browser,
then install and run from this directory:

```sh
cd docs/examples/headless-collaboration
pnpm install --ignore-workspace
pnpm start -- \
  --base-url http://127.0.0.1:8791 \
  --list
```

The client joins the first session in the app's `shared` scope, performs the
edits with short pauses, waits for acknowledgements, and leaves. Leaving does
not end the server session.

## Flags

- `--base-url URL` is required and names the Dinkster backend.
- `--session ID` joins a specific session.
- `--list` joins the first session in the `shared` scope.
- `--create` creates and joins a session containing an empty workflow.
- `--actor-id ID` selects the participant id. The default is `headless-demo`.
- `--owner NAME` identifies the person running the agent. The default is the
  operating system username.
- `--type TYPE` supplies a node type when the workflow is empty. It is normally
  needed with `--create`.
- `--end-session` ends a session created by this invocation after the demo.
  It is only valid with `--create`. Without it, the created session remains
  available.

Exactly one of `--session`, `--list`, or `--create` is required.

While connected, the client announces itself every two seconds as the
`headless-demo` agent using the `cli` harness so browser participants can
identify it.

## Local checks

From this directory, after the `pnpm install` above:

```sh
pnpm test        # runs the unit test in test/
pnpm typecheck   # type-checks src/ and test/
```

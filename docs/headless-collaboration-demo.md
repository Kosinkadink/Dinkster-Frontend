# Headless collaboration demo

The headless collaboration example under `docs/examples/headless-collaboration/`
is a Node 22+ participant for shared workflow sessions. It can join a named
session, discover the first session in the app's `shared` scope, or create a
session from a minimal empty document.

After joining, it copies a linked pair of nodes when possible, recreates their
link, marks the first copy, and moves it in four visible steps. A workflow
without a usable link gets one copied node instead. The client waits for the
server to acknowledge its edits and then leaves without ending the session.

While connected, the client announces itself as the `headless-demo` agent
using the `cli` harness. Its `--owner NAME` flag identifies who runs it and
defaults to the operating system username. The announcement is refreshed
every two seconds so it remains visible in the Participants section.

See `docs/examples/headless-collaboration/README.md` for commands and flags.

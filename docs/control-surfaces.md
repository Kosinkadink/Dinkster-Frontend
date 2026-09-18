# Control surfaces

Control surfaces are document-owned panels that dispatch commands without
participating in graph topology or compilation. The current Mode Panel binds
nodes or groups and applies Active, Mute, or Bypass as one undoable command.
Group membership is resolved from current canvas geometry when the command is
invoked.

The panel title, actions, picker prompt, binding-state copy, mode labels,
fallbacks, and accessible action names follow the active application locale.
A mounted panel and open group picker relabel in place without changing focus,
document revision, surface or binding identity, selection, or dispatch.

Surface titles and types, node titles and types, group titles, identifiers, and
broken-binding diagnostics are document or runtime facts and remain raw. New
Mode Panels persist the canonical `Mode Panel` title rather than locale-specific
document data.

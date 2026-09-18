# Memory and Aimdo telemetry

Open **Memory** from the activity bar to inspect each native Dinkster backend.
Every backend has a separate labelled section with its own telemetry, device
identities, consumer disclosures, history, and runtime settings.

The section status distinguishes initial loading, live data, stale retained
data, and a disconnected backend. A failed refresh leaves previous facts
visible and labels them retained instead of presenting them as current.

## Device overview

Queue depth, running capacity, pause state, and execution occupancy are shown
as server-reported facts. Each device separately names budget, consumer
footprint, reservation pressure, availability, raw capacity, and
Aimdo-corrected free memory. The stacked bar has an exact byte legend. A device
without a budget uses measured used/free values when measurements exist and
otherwise reports unavailable telemetry; missing values are never displayed
as zero. Over-budget availability remains a prominent error fact.

The history graph records at most one sample per second in a bounded
1,200-sample in-memory ring. It presents footprint, reservations, and capacity.
Hovering adds a crosshair with sample time and byte values. An expandable,
keyboard-focusable table exposes every graph sample as text. The graph is
labelled RETAINED whenever its source is stale or disconnected. Reloading
clears this local history.

## Consumers, pages, and leases

Consumer cards show the server-owned name and total footprint. Their disclosure
state is persisted by backend, device, and consumer identity so equal labels
cannot collide. Expanding a consumer loads item details and residency byte
facts. Detail failure remains local and keeps previously loaded details visible
as retained.

When page flags are available, a canvas heatmap draws compact cells and wraps
them to the card width. Flag bit 0 means resident. Transition cues distinguish
page-in and page-out activity without replacing the server flag. A textual
summary reports resident pages and bytes. An expandable, keyboard-focusable
range table exposes every raw flag, its resident interpretation, and page-in
or page-out transition, so the heatmap is never the only source of meaning.

Active leases retain reservation id, device, byte count, and countdown.
Unsupported lease telemetry and a supported empty lease list are distinct.

Pushed `memory_status` updates take precedence. Polling `/memory/status` every
five seconds is the fallback. Expanded details use
`/memory/status?details=1` every ten seconds and stop polling when no consumer
is expanded. Superseded base and detail responses are ignored.

## Controls

Controls are always visible below telemetry. Budget and headroom provide
paired MiB number inputs and sliders and apply live. Aimdo policy applies to
workers started after the change. This composes the shared runtime settings
surface: loading and refresh errors, grants, read-only state, dirty drafts,
saving, returned-section replacement, validation or permission rejection,
rejected flags, and persistence retain their existing behavior.

Fault and offload activity counters are absent because the backend does not
define them. They must not be inferred from other telemetry.

# Memory and Aimdo telemetry

Open **Memory** from the activity bar to inspect each native Dinkster backend.
Every backend has a separate labelled section with its own telemetry, device
identities, consumer disclosures, history, and runtime settings.

The section status distinguishes initial loading, live data, stale retained
data, and a disconnected backend. A failed refresh leaves previous facts
visible and labels them retained instead of presenting them as current.

## Device overview

Queue depth, running capacity, pause state, and execution occupancy are shown
as server-reported facts. Each device starts with a compact stacked bar and its
exact byte legend, followed by budget, consumer footprint, reservation pressure,
availability, raw capacity, and Aimdo-corrected free memory. A device without a
budget uses measured used/free values when measurements exist and otherwise
reports unavailable telemetry; missing values are never displayed as zero.
Over-budget availability remains a prominent error fact. Budget and headroom
controls follow the device overview so they remain adjacent without displacing
the live bars and model residency visuals.

Worker measurements show torch allocated/reserved, device total/used/free,
observed peak, process RSS and pinned host memory separately from governor
accounting. NVIDIA telemetry supplies GPU name, utilization, temperature and
power when available. Reset peak sets the peak to current device usage.
Unavailable metrics remain labelled as not reported.

The history graph records at most one sample per second in a bounded
120-sample in-memory window labelled **last 120 s**. Older samples are dropped,
not accumulated in hidden scrollback. It presents
footprint, reservations, and capacity. Hovering adds a crosshair with sample
time and byte values. An expandable, keyboard-focusable table exposes the
visible samples as text. Stale and disconnected state belongs to the panel,
not the graph; no history sample is appended while the connection is not live.
Reloading clears this local history.

Device names, consumer ids and item ids keep their cards stable while telemetry
refreshes. Open history and page-flag disclosures, keyboard focus and table
scroll positions remain in place through updates.

## Consumers, pages, and leases

Consumer cards show the server-owned name and total footprint before model
residency details. Their disclosure state is persisted by backend, device, and
consumer identity so equal labels cannot collide. A newly active consumer opens
once unless a saved user choice exists. Expanding a consumer loads item details
and residency byte facts. Visible details refresh after every accepted base
sample and superseded requests are ignored. Detail failure remains local and
keeps previously loaded details visible as retained.

When page flags are available, a canvas heatmap draws compact cells and wraps
them row by row to the card width, without moving or scrolling cells between
updates. It matches the reference's 6 px cells and 1 px gaps. Resident cells
are orange and unloaded cells gray; six-update RGB transitions fade yellow
to resident for page-in and red to gray for page-out. Flag bit 0 means
resident. Transition cues distinguish
page-in and page-out activity without replacing the server flag. A textual
summary reports resident pages and bytes. An expandable, keyboard-focusable
range table exposes every raw flag, its resident interpretation, and page-in
or page-out transition, so the heatmap is never the only source of meaning.

Active leases retain reservation id, device, byte count, and countdown.
Unsupported lease telemetry and a supported empty lease list are distinct.

Pushed `memory_status` updates take precedence. Polling `/memory/status` every
five seconds is the fallback. Expanded details use
`/memory/status?details=1` every ten seconds and also refresh after an accepted
base update; detail polling stops when no consumer is expanded. Superseded base
and detail responses are ignored.

## Controls

Controls are visible below the device overview. Budget and headroom provide
paired MiB number inputs and sliders and apply live. Aimdo policy applies to
workers started after the change. This composes the shared runtime settings
surface: loading and refresh errors, grants, read-only state, dirty drafts,
saving, returned-section replacement, validation or permission rejection,
rejected flags, and persistence retain their existing behavior.
Current settings display readable MiB values rather than raw JSON. Effective
budget/headroom values come from live telemetry, while Aimdo lists the policy
applied to each existing worker. A changed next-start policy does not claim
that running workers changed; missing applied telemetry remains not reported.

Unload all requests all sheddable device memory from the governor. Each model
has an unload action scoped to its consumer and item id. The result reports
actual freed bytes; active memory can remain. Unload and peak-reset actions
are disabled while telemetry is retained or another action is pending.

Fault and offload activity counters are absent because the backend does not
define them. They must not be inferred from other telemetry.

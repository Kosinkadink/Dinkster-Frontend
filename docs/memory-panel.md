# Resources

Open **Resources** from the left bar to inspect the connected backends. The stored panel identifier remains `memory`, so existing layouts and backend links still open the same panel. The open workflow's backend starts expanded. Other backends are compact rows with their total card usage; disconnected backends remain listed without numbers or controls.

Each graphics card has its own memory bar, two-minute usage graph and loaded-model list. The list uses the bytes resident on that card, not a model's combined host and device footprint. When model details or allocator measurements are absent, the bar shows measured usage only. Missing figures are omitted rather than displayed as zero.

Graphs use elapsed timestamps in a bounded two-minute, 120-sample in-memory window. They do not invent history before the panel was opened. Closing the panel or reloading clears the local history. A dashed line shows the card's memory limit when reported.

**Details** holds peak usage, free memory, allocator-held memory and reported system memory. Reset sits immediately before the peak value. **Limits** holds per-card memory limits, backend headroom and Aimdo policy. Writable settings follow the backend's granted runtime categories. Aimdo policy applies to subsequently started workers; existing workers retain their applied policy.

The panel prefers pushed telemetry and falls back to polling when updates stop. A stale connection disables actions, and a disconnected backend hides retained numbers. Unload requests use stable consumer and item identities, require confirmation and report failures without replacing missing values with estimates.

The backend does not yet report authoritative live-run model use. Resources does not infer that relationship from running job counts or claim to protect active models from unloading. That engine contract is tracked separately from the panel.

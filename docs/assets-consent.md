# Missing asset consent

Native job preflight can reject a submission before anything is queued or downloaded. Dinkster then opens the queue-blocking Acquire missing assets decision. The plan is not derived from visible asset widgets: backend preflight may report node-triggered requirements in any graph.

The summary separates required, available, and selected counts. Each row shows the exact name and digest plus optional kind, binary size, status, and source. Packaged assets say `Ships with pack <id>` without implying a network download. Fetchable remote assets say `Download from <host>`. Assets without a downloadable source are marked unresolvable and cannot be selected. Backend detail remains visible on its asset.

Dialog chrome follows the active application locale while mounted, including source-provenance wrappers and selection or progress announcements. Asset names, digests, kinds, statuses, sizes, backend details, source hosts, pack IDs, selected digests, and retry request bodies remain untranslated authoritative values. Changing locale does not replace rows or controls, move focus, reset staged selection, dismiss the dialog, or submit another request.

Fetchable rows start selected. `Acquire selected and retry` resubmits the exact rejected job body with `acquireAssets` containing exactly the selected digests. Cancel submits nothing. A repeated preflight rejection replaces the plan in the same dialog; success closes it and enters the normal execution flow. Other failures use the normal Problems path.

Each row uses the product checkbox. Clicking the row label or the control stages its digest without changing the queued request. The control is keyboard reachable, exposes checked state through `aria-checked`, and is disabled when the asset is unresolvable or a retry is busy. A polite status announces selection and retry progress.

Acquisition runs inside the retry request and may take a while. While it is busy, selection, the close button, Escape, and backdrop dismissal are blocked. The explicit Dismiss action hides the decision without cancelling the in-flight retry; a later failure appears in Problems. There is no mid-flight cancellation because the backend does not provide one.

The host-owned native modal provides focus containment, background inertness, and opener-focus restoration. Outside a busy retry, Escape, backdrop, close, and Cancel all take the same no-submit path. The decision list scrolls independently so long facts, the footer, and actions remain reachable on narrow screens and at 200 percent CSS zoom. Reduced motion follows the host preference.

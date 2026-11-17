# Missing asset consent

## Model-job client transport

The native connection exposes metadata-only `planModelDownload`, explicit
`startModelDownload`, owned-job list/status and `cancelModelDownload` operations.
Planning sends only the model name, kind and connection's captured project.
Starting sends only the opaque plan id and `consent: true`; it does not accept
client-supplied provider URLs, hashes or destinations. These methods do not
submit a workflow or retry a failed side effect automatically.

Plans keep local, disabled-folder, picker-required, destination-required and
consent-required states distinct. Immutable consent metadata includes the
provider revision, SHA-256, size, reported license and full destination, without
inventing an asset digest. Job progress retains received/total bytes and phase.
Completed results retain verified BLAKE3 identity, actual physical path, reuse,
rename and indexing-pending fields. Malformed counts, mutable revisions and
incomplete verified results are rejected. The engine instance id on the job
list distinguishes restart from reconnect; an unavailable job returns no status
rather than implicitly starting another transfer. Cancelling an HTTP read does
not cancel a transfer; cancellation is a separate explicit job operation.

## Captured-submission asset consent

Native job preflight can reject a submission before anything is queued or downloaded. Dinkster then opens the queue-blocking Acquire missing assets decision. The plan is not derived from visible asset widgets: backend preflight may report node-triggered requirements in any graph.

The summary separates required, available, and selected counts. Each row shows the exact name and digest plus optional kind, binary size, status, and source. Packaged assets say `Ships with pack <id>` without implying a network download. Fetchable remote assets say `Download from <host>`. Assets without a downloadable source are marked unresolvable and cannot be selected. Backend detail remains visible on its asset.

Dialog chrome follows the active application locale while mounted, including source-provenance wrappers and selection or progress announcements. Asset names, digests, kinds, statuses, sizes, backend details, source hosts, pack IDs, selected digests, and retry request bodies remain untranslated authoritative values. Changing locale does not replace rows or controls, move focus, reset staged selection, dismiss the dialog, or submit another request.

Fetchable rows start selected. `Acquire selected and retry` resubmits the exact rejected job body with `acquireAssets` containing exactly the selected digests. Cancel submits nothing. A repeated preflight rejection replaces the plan in the same dialog; success closes it and enters the normal execution flow. Other failures use the normal Problems path.

An unavailable model source name stays a name/kind requirement, not a fabricated asset digest. Its diagnostic retains the original node/input location. In the same owned dialog, `Review source` discovers an existing job for the captured project or requests a metadata-only plan. Review shows provider, project, source, repository/model ID, fixed revision/version, file, expected SHA-256, size, reported license and full destination before `Download`. A source can be a Hugging Face resolve URL or a Civitai model/download URL without tokens. Civitai model URLs may include `modelVersionId`; if several versions contain the needed filename, choose one of the returned file sources and review again. Civitai refusals explain that Hugging Face sign-in does not grant Civitai access. A local plan needs no transfer; disabled folders, missing destinations and ambiguous sources explain the required settings or file-selection action.

Model plans and job operations use the local scope and the captured project. `Download` starts only the reviewed opaque plan. The dialog reports phase and received/total bytes; it never queues a graph when a transfer finishes. `Cancel transfer` explicitly cancels a cancellable job. `Dismiss` stops observation without cancelling the transfer; queue again and review to reconnect to the owned job. Transport errors require explicit reconnect. A job lost across restart is marked interrupted; reviewing again discovers any surviving job or offers a fresh plan and requires fresh Download consent. No read or retry restarts a transfer automatically.

Completion shows the verified actual path, including existing-file reuse, filename changes and pending background indexing. `Run once` becomes available only after every model requirement is local or verified complete. It retries the captured job body once, not a recompilation, and refuses after its project, document or backend ownership changes. Downloads, status reads and late completions cannot replace another submission's dialog. Ordinary exact-digest assets keep their separate staged selection and acquisition behavior.

Each row uses the product checkbox. Clicking the row label or the control stages its digest without changing the queued request. The control is keyboard reachable, exposes checked state through `aria-checked`, and is disabled when the asset is unresolvable or a retry is busy. A polite status announces selection and retry progress.

Acquisition runs inside the retry request and may take a while. While it is busy, selection, the close button, Escape, and backdrop dismissal are blocked. The explicit Dismiss action hides the decision without cancelling the in-flight retry; a later failure appears in Problems. There is no mid-flight cancellation because the backend does not provide one.

The host-owned native modal provides focus containment, background inertness, and opener-focus restoration. Outside a busy retry, Escape, backdrop, close, and Cancel all take the same no-submit path. The decision list scrolls independently so long facts, the footer, and actions remain reachable on narrow screens and at 200 percent CSS zoom. Reduced motion follows the host preference.

# P2P transfers

P2P is off on a fresh installation and does not show a first-run prompt. The
P2P panel has one sharing toggle for downloads and background seeding, shows
the current seeding state, and retains controls for limits and live activity.
Saved downloads-on, seeding-off settings appear as mixed; turning the mixed
sharing control on enables both capabilities.
Turning the toggle off stops the P2P runtime.

The P2P transfers dock panel controls native Dinkster peer-to-peer model transfers. Saved server choices are preserved. Its chrome uses the shared application catalog and follows explicit or Automatic browser and desktop locale selection. Mounted controls update when the active locale changes without resetting draft settings or refetching settings and activity. Backend-provided identifiers and errors remain untranslated data.

Controls include one download-and-seeding switch, LAN/internet scope, transfer caps in MiB/s, metered-network behavior, and ratio/time or continuous seed budgets. The staging budget uses GiB and maps to `stagingBudgetBytes`, a nonnegative safe integer at most `Number.MAX_SAFE_INTEGER`. Its default is 64 GiB. It caps aggregate temporary P2P download reservations, not existing no-copy seed files. Zero denies new P2P disk growth; unlike a rate cap of zero, it is not unlimited.

Runtime activity uses the backend's canonical host-managed sidecar status, durable totals, peer rates, partial storage, and remaining seed budgets. `network.paused` means all P2P, including LAN, is paused. `sidecar.global.active` and `closureReason` separately report internet activity or closure. Internet-only metered, unknown-cost, or budget closure does not claim LAN is paused. Per-digest activity continues to use the host's canonical transfer rows, not a separate internet activity model.

Global download leases may report `verifiedBytes` for native piece-verification progress. This is distinct from `durableBytes` and does not imply that the file has passed vault publication.

Each digest shows canonical seed grants with source, license metadata, and evidence. Empty, custom, or restrictive license text is not an authorization filter; an empty license displays "Not specified (metadata only)". Provider license/gated metadata does not confer or remove seed authority. The official subscription is trusted; arbitrary subscriptions remain untrusted. No provider-name special cases are applied. Revocation remains visible by grant ID. Applicable actions allow pausing, resuming, stopping, clearing partial data, resetting a budget, or switching a digest to continuous seeding.

Without a granted, writable `p2p` category the panel shows settings as read-only and hides mutations. Read-only guidance points server operators to the `--disable-p2p` startup override, which disables P2P without granting settings-write access. No P2P status request is made when saved settings explicitly disable both downloads and seeding. The backend contract landed in [Dinkster PR 1188](https://github.com/Kosinkadink/Dinkster/pull/1188), and [issue 1195 closure evidence](https://github.com/Kosinkadink/Dinkster/issues/1195#issuecomment-5569882241) records successful live private-provider validation. The frontend consumes the backend's provider endpoint and stable ID without fabricating either value. Route-mocked browser fixtures demonstrate frontend behavior; live provider readiness is established by the linked validation evidence.

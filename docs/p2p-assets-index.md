# Preserved P2P asset code

This branch preserves the host and browser code before removal from main.
The external dinkster-p2p repository is not changed. Digest identity, vault
storage, consent and verified HTTP acquisition belong to the surviving core.

The index includes dedicated transfer files and shared files with transfer
references. A shared file's count is its whole-file size, not a deletion size.
Incidental encoded-fixture matches are identified separately. Binary assets
have no meaningful physical line count. Counts use newline bytes.

Source main: [a345a663ee84](https://github.com/Kosinkadink/Dinkster-Frontend/commit/a345a663ee84ba53676cd3cd994a031be040fc27).

## Two-host transfer requirements

Both hosts need compatible plugin/runtime dependencies, reachable peer
endpoints, discovery or explicitly configured peers, authorization grants,
and a source file whose digest is available from a mount or vault. The
receiving host needs writable staging/storage, transfer activity reporting,
and final digest verification before publishing the bytes to the catalog.
Tests and workflow lanes are references, not evidence that this preserved
code works between real hosts. Restore components only after testing them.

| File | Physical lines | Purpose | Two-host responsibility |
| --- | ---: | --- | --- |
| `docs/archive/feature-coverage-audit.md` | 1326 | Document transfer behavior or shared host configuration | Recover the documented setup and security expectations |
| `docs/design-system.md` | 360 | Document transfer behavior or shared host configuration | Recover the documented setup and security expectations |
| `docs/internationalization.md` | 79 | Document transfer behavior or shared host configuration | Recover the documented setup and security expectations |
| `docs/memory-panel.md` | 98 | Document transfer behavior or shared host configuration | Recover the documented setup and security expectations |
| `docs/p2p-transfers.md` | 27 | Document transfer behavior or shared host configuration | Recover the documented setup and security expectations |
| `docs/testing.md` | 124 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/app/src/App.tsx` | 3156 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |
| `packages/app/src/P2PPanel.tsx` | 560 | Render transfer status, peer activity and controls | Restore only the transfer integration after proving the digest core still works |
| `packages/app/src/RuntimeSettingsPanel.tsx` | 360 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |
| `packages/app/src/app-state.ts` | 8709 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |
| `packages/app/src/locales/en.json` | 1597 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |
| `packages/app/src/locales/zh.json` | 1597 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |
| `packages/app/src/styles.css` | 8313 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |
| `packages/app/test/P2PPanel.dom.test.tsx` | 463 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/app/test/RuntimeSettingsPanel.dom.test.tsx` | 411 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/app/test/disabled-features.dom.test.tsx` | 42 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/app/test/p2p-catalog.test.ts` | 70 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/app/vitest.component.config.ts` | 23 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/app/vitest.config.ts` | 16 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/client/src/dinkster-connection.ts` | 3706 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |
| `packages/client/test/dinkster-connection.test.ts` | 4423 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/core/fixtures/object_info.json` | 0 | Existing model fixture with an incidental lexical match | No transfer responsibility; preserve fixture bytes unchanged |
| `packages/e2e/playwright.audit-assets.config.ts` | 65 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |
| `packages/e2e/playwright.config.ts` | 207 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |
| `packages/e2e/playwright.extension-contract.config.ts` | 90 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |
| `packages/e2e/playwright.hosted.config.ts` | 146 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |
| `packages/e2e/tests/disabled-features.spec.ts` | 66 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/e2e/tests/guide-browsing.spec.ts` | 113 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/e2e/tests/library-panel.spec.ts` | 356 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/e2e/tests/p2p-onboarding.spec.ts` | 484 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/e2e/tests/product-surface-visuals.spec.ts` | 393 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/e2e/tests/product-surface-visuals.spec.ts-snapshots/15-p2p-parallel-safe-linux.png` | binary | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/e2e/tests/shell-dock.spec.ts` | 838 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/e2e/tests/shell-tabs.spec.ts` | 445 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/e2e/tests/template-gallery.spec.ts` | 302 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `packages/e2e/tests/templates.spec.ts` | 117 | Test transfer behavior or a shared host integration | Recheck applicable assertions with two independent hosts and shared content |
| `scripts/raw-control-allowlist.json` | 544 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |
| `scripts/ui-string-allowlist.json` | 1019 | Connect peer transfer behavior to the shared application surface | Restore only the transfer integration after proving the digest core still works |

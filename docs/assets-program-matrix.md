# Assets program matrix

Canonical issue: [#5](https://github.com/Kosinkadink/Dinkster-Frontend/issues/5)

Whole-feature owner: frontend generation 6,
`T-019ff64b-02a5-7501-9a67-9022b39db96c`.

Frontend generation 6 is the 270K-Plus2 machine and service owner. The
Assets owner retains its historical artifacts and backend-boundary records.
Backend contracts are owned by engine and are never inferred here.

## Closure rule

Surface A is the Widget, node-input picker, and node preview. Surface B is the
global Assets side panel and library. Evidence for one surface never closes a
row on the other. A row closes only with reviewed source, deployment evidence,
and original/baseline/post-fix human visual comparison, or with an exact
blocked owner and revival trigger.

## Historical complaint assignment

Each historical complaint is assigned once. The binding correction contains
one complaint about each surface, so those two statements have separate rows.

| Report | Surface | Complaint | State |
|---|---|---|---|
| `52ab260e-ca87-47d4-9bf1-df874a653079` | A | Original asset-drop failures and rejected Widget/input presentation | OPEN: fixed subparts require current acceptance; picker quality remains open |
| `dc116bdf-695a-4fde-afd2-cc572219756e` | A | Import committed a partial AssetRef and produced `widget.ASSET.badValue` | COMPLETE: A5 proved an exact five-field AssetRef through upload, export, reopen, and execution with byte-identical storage |
| `cfeb1728-b4a7-41bc-b98d-a92162277a4e` | B | Federated mount-aware global library and left-rail direction | COMPLETE: the curated rail, federated All assets, provenance, and per-mount browsing survived the live CollectionPanel acceptance |
| `c41910cc-f30f-4482-bd47-703bc2f85449` | A | ComfyUI-grade picker, selected-asset preview, and output preview references | OPEN |
| `e536a696-5ef4-4e2f-9d42-2c4343b24312` | A | Logical-model rows and local/downloadable variant state | PARTIAL: read-only CandidateV1 grouping is source-ready; download/acquisition is BLOCKED on engine ROADMAP audit A2 |
| `f6da4e5e-1504-4c5b-be32-bcabe296d5c6` | A | Auto/explicit variant UX with exact AssetRef binding | PARTIAL: explicit local binding rules are frozen; authoritative auto/recommendation and non-local acquisition remain BLOCKED on joint policy and transfer wires |
| `6efaf8dc-881a-4852-9e05-385a3d467c3e` | A | Immediate in-node input preview and ComfyUI-grade output display/paging | COMPLETE: A3 selected-input preview and A4 executed-output inventory/viewer/paging were deployed and accepted at both target viewports |
| `716df5dd-6aaf-4c8e-9b6f-95cd5f958da8` | B | Served global Assets interface remained materially wrong | COMPLETE for the reproduced no-scroll/clipping defect: live headed Chromium proved the bounded scroller and reachable tail at both target viewports |
| `28572e7d-64e6-4d4e-9b6f-95cd5f958da8` | B | Restart and served-browser proof for the side panel | COMPLETE: the dedicated 2026-08-12 restart and real-backend browser receipt supersede prior evidence-only runs |
| `380b5794-2373-4734-9079-fd9e16c09a65` A complaint | A | Widget complaints were wrongly treated as closed by side-panel work | OPEN until every A row is accepted or exactly blocked |
| `380b5794-2373-4734-9079-fd9e16c09a65` B complaint | B | Side panel has no visible scrollbar and clips its tail | COMPLETE: headed Chromium showed the real scrollbar thumb and fully reachable final row at 1920x1080 and 1366x768 |

## Delivery matrix

| ID | Surface | Outcome | Current evidence | Closure gate |
|---|---|---|---|---|
| A1 | Widget picker | Contained populated, empty, error, loading, and overflow layouts; aligned footer; no dead space or overlap | COMPLETE: public commit `322a8c7` was deployed by frontend generation 5 through a bounded :5199 restart. Real `dinkster.load_image` pickers at 1920x1080 and 1366x768 showed 31-entry 4:3 grids with readable titles, collection-owned scrolling, a fully reachable final card with positive footer/action separation, compact one-entry sparse geometry, and unchanged list mode. A supplemental real-app regression proved the global Assets scroller and complete final row at both viewports. Fresh screenshots passed human comparison with the short-strip and dead-space baselines; no page error occurred. Frontend generation 6 repeated the full grid, sparse, list, and global-panel regression after the power outage with the same PASS verdict. | ACCEPTED 2026-08-12. Frontend MainPID/Vite changed 655868/655882 -> 733562/733577 during the original bounded deployment; backend PID 457937 remained unchanged. Post-reboot immutable artifacts and exact current service identity are recorded in issue #5 and `/tmp/audit-post-reboot-proof/`. |
| A2 | Widget picker | All/Imported/Generated or a contract-faithful cross-source equivalent; acquisition only when a backend contract exists | COMPLETE for the read-only frontend contract. Real served-app proof at both viewports showed exactly All assets, Imported, and Generated; All included input and output, Imported contained only the one input asset, and Generated contained only output assets. Folder navigation, recursive search, two-page paging, keyboard commit, and the exact five-field `example.png` AssetRef all passed without a job, resolve, acquire, or upload request. | ACCEPTED 2026-08-12 after post-reboot re-proof. Download/Acquire remains correctly absent and blocked until engine ROADMAP audit A2 publishes and proves transfer, integrity, atomic publication, progress, and policy semantics. |
| A3 | Node input preview | Selected image AssetRef previews immediately within the node | COMPLETE: reviewed source `f01cc526fc70cb098489d386147233485e8ad166` was deployed by frontend generation 5 through the bounded :5199 restart. Against the real backend and `dinkster.load_image`, selecting `example.png` painted a bounded 768x768 preview immediately and reload preserved it pixel-for-pixel; clear removed both pixels and passive accessibility state; an intercepted uncached real asset rendered the unavailable placeholder without stale pixels. Fresh 1920x1080 and 1366x768 screenshots were visually compared with `06-widget-after-pick-1920.png` and the isolated zoom/lifecycle set. Served source markers, direct/proxied node byte equality, LAN health, zero page errors, and unchanged :8765 identity were recorded. | ACCEPTED 2026-08-12. Immutable selected, reload, clear, and unavailable artifacts are recorded in issue #5; output paging remains exclusively A4. |
| A4 | Node output preview | One ordered executed-image inventory feeds an accessible Outputs thumbnail grid/viewer and a pageable canvas execution preview | COMPLETE: public commits `eaf9021` and `e83685d` were deployed by frontend generation 5 through a bounded :5199 restart. Real `dinkster.load_image` -> `dinkster.save_image` execution produced a bounded 768x768 single-image node/rail preview; deterministic served-app proof covered the three-image rail, grid/single viewer, 100%/125% zoom, 1/3 and 2/3 paging with true dimensions, real-404 unavailable states, low-zoom simplification, focus restoration, new-execution reset, and same-key shrink to 1/1. Fifteen fresh 1920x1080 and 1366x768 screenshots passed human comparison with originals `17845030...` and `b748ca92...`; document revision stayed unchanged and no page error occurred. | ACCEPTED 2026-08-12. Frontend restarted to MainPID/Vite 655868/655882; backend PID 457937 was unchanged. Immutable artifacts are recorded in issue #5. |
| A5 | Import integrity | Complete five-field AssetRef survives import and remains executable | COMPLETE: backend EOF-draining fix `6a5a1c23` and verified-read hardening `0313abfe` are ancestors of the unchanged live-backend pin `e78b3988`. The non-skipped current-stack single-Widget proof uploaded a deterministic 787127-byte PNG, then read back all 787127 bytes with identical SHA-256 `49c869125c51b82d6b6c141c4b4a9098451ff027ab8be79a289d85581c0a8082` under server digest `blake3:6a9a4075b9b71a9e7093f7d079ff19aa9bedf4a275c0bb57b836d8f4bdf9d6d3`. The exact five-field AssetRef survived export, JSON round-trip, and reopen; `dinkster.load_image` -> `comfy.PreviewImage` completed. | ACCEPTED 2026-08-12. Focused Playwright passed 1/1; frontend PIDs 655868/655882 and backend PID 457937 were unchanged. The immutable proof object remains in the same backend vault. |
| A6 | Logical model/variant | Grouped identity, explicit variant facts, and exact AssetRef execution binding | COMPLETE for the read-only frontend contract. The real `dinkster.load_checkpoint` editor sent the authoritative Candidate V1 context, grouped the returned exact local compatible variant by logical identity, showed dtype/quantization/format/size/digest/source facts, omitted Auto/Recommended, and committed the exact five-field checkpoint AssetRef without loading a model. | ACCEPTED 2026-08-12 after post-reboot re-proof. The real response had no non-local row, so noncommittability was vacuously satisfied. Auto recommendation and non-local acquisition remain exactly blocked. |
| A7 | Original provenance | Recover and inspect every authenticated audit/audit original | COMPLETE: all 15 supplied attachment IDs were recovered and inspected; audit had no attachments and no concrete missing ID exists | ACCEPTED 2026-08-12; exact IDs remain in the Evidence inventory below |
| B1 | Global side panel | Height-contained entry viewport with a visible scrollbar and footer outside it | COMPLETE: deployed commit `38553b7261278e06d0468fa31aed4de7f2851fe7` was restarted on :5199. Headed real-backend Chromium proved `scrollHeight 2176 > clientHeight 706`, pointer scrolling, a painted scrollbar thumb, keyboard-reachable final row/path, and no footer overlap at both target viewports. | ACCEPTED 2026-08-12; immutable before/after artifacts are recorded in issue #5 |
| B2 | Global side panel | `Load more` never obscures list content; empty/error/loading remain legible | COMPLETE: fresh unpaginated real-app proof places Load more below the final row in list flow with zero overlap at 1920x1080 and 1366x768; fixture E2E retains deterministic empty/loading/error coverage. | ACCEPTED 2026-08-12 |
| B3 | Global side panel | Preserve curated rail, human titles, provenance, per-mount browsing, and federated-only behavior | COMPLETE: live proof retained federated All assets, human source grouping, provenance badges, per-mount navigation, and real 31-row catalog paging after the bounded restart. | ACCEPTED 2026-08-12 against `01`, `03`, and `04` baselines |

## Post-reboot recovery and regression receipt

After the 2026-08-12 power outage, frontend generation 6 restored the local
270K-Plus2 stack as persistent enabled systemd user units with `Linger=yes`.
The frontend proof ran from exact clean source `b012fe5` and backend source
`e78b3988`; the later `2290f24` frontend commit changes only this delegation
ledger's orchestrator pointer. During acceptance, backend PID 18594 had zero
restarts and frontend MainPID/node 20013/20031 remained stable. Direct and
proxied health, wire-22 nodes, catalog, and candidates responses were
byte-identical. Resolve remained intentionally absent with matching 404
responses.

Headed Chromium against the real :5199/:8765 stack re-proved A1, A2, A6, and
the global Assets panel at 1920x1080 and 1366x768 with no mocks, page errors,
API failures, document mutation from browsing, job submission, model load,
resolve, acquire, or upload. Facts are preserved at
`/tmp/audit-post-reboot-proof/facts.json` (SHA-256
`1470b6d90491c65bfda9b2cd54f960d69ec3a6197100b8558dcece257b8d79bc`),
and every fresh screenshot was inspected and published in issue #5.

## Confirmed open defects

These rows preserve the two findings confirmed by the post-reboot proof. They
do not narrow issue #5: frontend generation 6 owns reconciliation and closure
of the complete audit contract.

| ID | Defect | Current evidence | Closure gate |
|---|---|---|---|
| D1 | Reopening a media picker after committing a selected image squeezes the Generated grid at 1366x768. | SOURCE FIX IMPLEMENTED: short viewports cap the selected preview at 150px. Isolated Chromium now retains the checkerboard preview, at least one complete 4:3 card, collection-owned overflow, and separated footers at 1366x768. The confirmed pre-fix screenshot remains [here](https://ampcode.com/user-content/artifacts/f63cafcdc758d1547488563ea0087044e85ff144396df7229f254f56b70c3a44-file.png). | OPEN only for reviewed source merge, deployment, and equivalent real served-app proof at 1366x768. Focused test: `assets-collection-layout.spec.ts` "selected preview leaves one complete Generated grid card visible at 1366x768". |
| D2 | One pointer action aimed at another exposed ASSET widget while a picker is open dismisses the old picker but does not leave the intended new editor open. | SOURCE FIX IMPLEMENTED: after an accepted primary backdrop close, CanvasHost directly hit-tests the current scene at the trusted coordinate and opens only an exposed ASSET row. It does not replay an untrusted pointer event. Isolated Chromium passes at both target viewports with the exact intended editor open and zero document/revision change. Pre-fix [before](https://ampcode.com/user-content/artifacts/7717432641af1c8a0a557550e0436a5d318794c5dbb414475182530d4d645d1f-file.png) and [after](https://ampcode.com/user-content/artifacts/8a34fb6052a9a4e5c0c583b74d08e7d2abcc7a3cc9ad8b1ef5f3177408a9ea4c-file.png). | OPEN only for reviewed source merge, deployment, and equivalent real served-app proof at 1920x1080 and 1366x768. Focused test: `assets-collection-layout.spec.ts` "one ASSET backdrop press opens the intended second node". |

## Evidence inventory

All 15 originals were re-inspected on 2026-08-12.

Surface A:

- `0e490cd0-23d8-4910-9790-585a6267cfd2`
- `29642187-8cc1-4fab-a5f9-fd2e48acd3d1`
- `6f95f2d2-19cd-4e4c-8c64-05e8db1b2d35`
- `193a6d85-587b-466a-b3af-2f09737b8782`
- `518937ff-87d8-45b2-b907-7f7eff0ed973`
- `17845030-9ab8-4f52-bf7d-0596972ca9b5`
- `b748ca92-1a22-4c25-ac5f-cbc38ce01e68`
- `606f9efd-0b1f-4e8d-96f4-a2ee2c3e21b9`
- `b6af123a-8ed7-4e6e-aa60-235bc7d93092`
- `25ae1969-fa7d-474b-b840-d5b5df3f9f91`
- `448ce3b4-501f-4ff9-8d8d-f5b8e8712aec`
- `80fa2c05-6d9d-4c5c-8ac0-fe9069f93cd1`
- `4a142092-da5a-4908-a125-c89f2085ea72`

Surface B:

- `d66b7893-396f-4da8-9547-255284306e9c`
- `027933d0-a779-4fdd-9f30-c4064f5f966a`

The handed-off current screenshots remain under
`/tmp/audit-handoff-proof/`:

- `01-panel-1920-all-assets.png`
- `02-panel-1920-scrolled-bottom.png`
- `03-panel-1920-per-mount.png`
- `04-panel-1366-all-assets.png`
- `05-widget-picker-1920.png`
- `06-widget-after-pick-1920.png`

## Active dependencies

- Engine contract action `bc8ea77f-2f87-47d1-ba9d-cc05acdc15d8` returned as
  broker result `0d2f605a-1b4c-447c-b417-965181d9775c`:
  - `POST /api/catalog/resolve` has frozen request/response/error DTOs but is
    not registered by `dinkster-serve`. Catalog and candidates are read-only.
    The frontend exposes availability status only and no Download/Acquire
    action. Revival trigger: engine ROADMAP audit A2 publishes and proves
    provider policy, durable transfer, size/MIME integrity, atomic
    publication, progress, retry, and credential semantics.
  - CandidateV1 is sufficient for a separate read-only frontend grouping
    lane. Group by `logicalId`, retain concrete `(variantId,digest)` rows,
    and bind only a local candidate's exact five-field `assetRef`. There is
    no backend recommendation field; any authoritative default requires a
    separately accepted joint policy and DTO amendment.
  - Catalog-only digest thumbnail support is absent. `GET /api/assets/{digest}`
    serves verified local bytes only and must not be used as an S3 or remote
    thumbnail workaround. Revival trigger: A2 materialization plus a
    separately accepted thumbnail route/auth/cache/error contract.
- Frontend generation 6 owns every bounded :5199 deployment/restart under
  standing policy `0189d60d-c2b2-42d6-a07c-6761be7b15d9`.
- Node-preview reconciliation, the global CollectionPanel layout, and Widget
  picker grid-card/sparse geometry are deployed and accepted on :5199.
  OUTPUT-PREVIEW A4 and A2/A6 facets/logical-model grouping are deployed and
  accepted. D1 and D2 source fixes are isolated-Chromium proven and remain
  open only for review, merge, deployment, and real served-app acceptance.

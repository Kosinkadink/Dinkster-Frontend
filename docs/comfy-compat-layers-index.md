# ComfyUI compatibility layers

This branch preserves the alias, group, replacement, translation and carrier implementation.
The native-node contract uses one registry and one type namespace instead of these bridges.

Indexed source: `71691964cf9c40c47926d4ed441e9cc3948b84a2`. Counts are physical lines of tracked files at that source.
Dedicated layer files may be removed; shared callers retain their unrelated responsibilities.
Test and fixture entries identify the layer contract, not permission to delete surviving behavior.
The importer remains responsible for positional workflow inputs and versioned per-node upgrades.

| File | Lines | Purpose |
| --- | ---: | --- |
| `.github/workflows/full-validation.yml` | 281 | Implements full validation in the layer or its shared caller. |
| `docs/archive/feature-coverage-audit.md` | 1325 | Documents feature coverage audit; shared documentation is edited rather than wholly removed. |
| `docs/archive/frontend-extension-rfc.md` | 1527 | Documents frontend extension rfc; shared documentation is edited rather than wholly removed. |
| `docs/archive/widget-inventory-audit.md` | 289 | Documents widget inventory audit; shared documentation is edited rather than wholly removed. |
| `docs/archive/wire15-proposal.md` | 672 | Documents wire15 proposal; shared documentation is edited rather than wholly removed. |
| `docs/comfyui-compatibility.md` | 68 | Documents comfyui compatibility; shared documentation is edited rather than wholly removed. |
| `docs/comfyui-workflow-translation.md` | 213 | Documents comfyui workflow translation; shared documentation is edited rather than wholly removed. |
| `docs/rework-queue.md` | 132 | Documents rework queue; shared documentation is edited rather than wholly removed. |
| `packages/app/src/app-state.ts` | 8726 | Implements app state in the layer or its shared caller. |
| `packages/app/src/editors/SaveTargetWidgetEditor.tsx` | 96 | Presents the combined prefix and mount target replaced by separate native inputs. |
| `packages/app/test/replacement-upgrade.test.ts` | 1545 | Tests replacement upgrade.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/client/src/connection-contract.ts` | 83 | Implements connection contract in the layer or its shared caller. |
| `packages/client/src/dinkster-connection.ts` | 3383 | Implements dinkster connection in the layer or its shared caller. |
| `packages/core/fixtures/replacements/chain.json` | 204 | Reference input/output data for chain.json; retain unrelated fixture bytes. |
| `packages/core/fixtures/replacements/combo.json` | 180 | Reference input/output data for combo.json; retain unrelated fixture bytes. |
| `packages/core/fixtures/replacements/dynamic-target.json` | 489 | Reference input/output data for dynamic-target.json; retain unrelated fixture bytes. |
| `packages/core/fixtures/replacements/same-type-migration.json` | 663 | Reference input/output data for same-type-migration.json; retain unrelated fixture bytes. |
| `packages/core/fixtures/replacements/save-video-alias-native.json` | 521 | Reference input/output data for save-video-alias-native.json; retain unrelated fixture bytes. |
| `packages/core/fixtures/replacements/save-video-comfy-alias-candidate.json` | 4516 | Reference input/output data for save-video-comfy-alias-candidate.json; retain unrelated fixture bytes. |
| `packages/core/fixtures/replacements/save-video-comfy-workflow.json` | 34 | Reference input/output data for save-video-comfy-workflow.json; retain unrelated fixture bytes. |
| `packages/core/fixtures/replacements/save-video-v3-wire38.json` | 312 | Reference input/output data for save-video-v3-wire38.json; retain unrelated fixture bytes. |
| `packages/core/fixtures/replacements/vocabulary.json` | 352 | Reference input/output data for vocabulary.json; retain unrelated fixture bytes. |
| `packages/core/fixtures/workflows/minimax-h3/catalog-wire40.json` | 1 | Reference input/output data for catalog-wire40.json; retain unrelated fixture bytes. |
| `packages/core/src/comfy-v1.ts` | 3 | Implements comfy v1 in the layer or its shared caller. |
| `packages/core/src/commands/core-commands.ts` | 3403 | Implements core commands in the layer or its shared caller. |
| `packages/core/src/commands/replace-commands.ts` | 832 | Implements replace commands in the layer or its shared caller. |
| `packages/core/src/compile/bypass.ts` | 68 | Implements bypass in the layer or its shared caller. |
| `packages/core/src/format/import-litegraph-loops.ts` | 1592 | Implements import litegraph loops in the layer or its shared caller. |
| `packages/core/src/format/import-litegraph-subgraphs.ts` | 542 | Implements import litegraph subgraphs in the layer or its shared caller. |
| `packages/core/src/format/import-litegraph.ts` | 2420 | Implements import litegraph in the layer or its shared caller. |
| `packages/core/src/index.ts` | 118 | Implements index in the layer or its shared caller. |
| `packages/core/src/replace/alias-rules.ts` | 73 | Implements alias rules in the layer or its shared caller. |
| `packages/core/src/replace/model.ts` | 496 | Implements model in the layer or its shared caller. |
| `packages/core/src/replace/plan.ts` | 2228 | Implements plan in the layer or its shared caller. |
| `packages/core/src/replace/registry.ts` | 64 | Implements registry in the layer or its shared caller. |
| `packages/core/src/replace/scan.ts` | 292 | Implements scan in the layer or its shared caller. |
| `packages/core/src/schema/comfy-alias.ts` | 212 | Implements comfy alias in the layer or its shared caller. |
| `packages/core/src/schema/comfy-group.ts` | 534 | Implements comfy group in the layer or its shared caller. |
| `packages/core/src/schema/comfy-registry-codec.ts` | 346 | Implements comfy registry codec in the layer or its shared caller. |
| `packages/core/src/schema/compat.ts` | 1 | Implements compat in the layer or its shared caller. |
| `packages/core/src/schema/derive-boundary.ts` | 1327 | Implements derive boundary in the layer or its shared caller. |
| `packages/core/src/schema/model.ts` | 1155 | Implements model in the layer or its shared caller. |
| `packages/core/src/schema/object-info.ts` | 596 | Implements object info in the layer or its shared caller. |
| `packages/core/src/schema/solve.ts` | 833 | Implements solve in the layer or its shared caller. |
| `packages/core/src/schema/type-compatibility.ts` | 186 | Implements type compatibility in the layer or its shared caller. |
| `packages/core/src/search-filters.ts` | 415 | Implements search filters in the layer or its shared caller. |
| `packages/core/src/value-source.ts` | 344 | Implements value source in the layer or its shared caller. |
| `packages/core/test/alias-rules.test.ts` | 220 | Tests alias rules.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/comfy-alias.test.ts` | 313 | Tests comfy alias.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/comfy-group.test.ts` | 337 | Tests comfy group.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/compile.test.ts` | 2753 | Tests compile.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/import-comfy-group.test.ts` | 525 | Tests import comfy group.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/import-litegraph-combo.test.ts` | 70 | Tests import litegraph combo.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/import-litegraph-loops.test.ts` | 2051 | Tests import litegraph loops.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/import-litegraph-subgraphs.test.ts` | 320 | Tests import litegraph subgraphs.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/import-litegraph.test.ts` | 2991 | Tests import litegraph.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/import-minimax-h3-official.test.ts` | 413 | Tests import minimax h3 official.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/import-save-video-alias.test.ts` | 248 | Tests import save video alias.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/object-info.golden.test.ts` | 75 | Tests object info.golden.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/object-info.test.ts` | 529 | Tests object info.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/perf.test.ts` | 391 | Tests perf.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/prompts.golden.test.ts` | 108 | Tests prompts.golden.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/replacement.dynamic.test.ts` | 678 | Tests replacement.dynamic.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/replacement.golden.test.ts` | 401 | Tests replacement.golden.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/replacement.migration.test.ts` | 1197 | Tests replacement.migration.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/replacement.test.ts` | 3338 | Tests replacement.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/reroute.test.ts` | 664 | Tests reroute.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/selector.test.ts` | 1088 | Tests selector.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/solve-lists.test.ts` | 398 | Tests solve lists.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/type-compatibility.test.ts` | 98 | Tests type compatibility.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/typed-assets.test.ts` | 864 | Tests typed assets.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/value-source.test.ts` | 836 | Tests value source.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/core/test/widget-tap.test.ts` | 567 | Tests widget tap.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/e2e/fixtures/video-edit-contract.json` | 711 | Historical video editor schema fixture including SaveVideo migration rules; retain unrelated editor contracts. |
| `packages/e2e/test/ci-workflow.test.ts` | 560 | Tests ci workflow.ts; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `packages/e2e/tests/import-legacy.spec.ts` | 723 | Implements import legacy.spec in the layer or its shared caller. |
| `packages/e2e/tests/product-surface-visuals.spec.ts-snapshots/badge-replacement-empty-1440.png` | 363 | Implements badge replacement empty 1440 in the layer or its shared caller. |
| `packages/e2e/tests/product-surface-visuals.spec.ts-snapshots/badge-replacement-empty-900.png` | 417 | Implements badge replacement empty 900 in the layer or its shared caller. |
| `packages/e2e/tests/save-target.spec.ts` | 209 | Tests the removed combined target editor; separate prefix and mount controls retain their own coverage. |
| `packages/e2e/tests/save-video-dynamic-native.spec.ts` | 368 | Tests historical SaveVideo schema-rule migration, helper insertion and link rewriting. |
| `packages/e2e/tests/trellis2-official-workflow-live.spec.ts` | 173 | Implements trellis2 official workflow live.spec in the layer or its shared caller. |
| `packages/e2e/tests/video-edit.spec.ts` | 733 | Tests video editors and historical SaveVideo migration; preserve ordinary editor and execution coverage. |
| `scripts/check-v1-boundary.mjs` | 354 | Generates or checks check v1 boundary. |
| `scripts/check-v1-boundary.test.mjs` | 177 | Tests check v1 boundary.mjs; preserve assertions for surviving behavior when removing exclusive layer tests. |
| `scripts/ci-fast.mjs` | 80 | Generates or checks ci fast. |
| `scripts/comfy-subgraph-coverage.mjs` | 82 | Generates or checks comfy subgraph coverage. |
| `scripts/extension-literal-allowlist.json` | 748 | Committed schema, alias or group data consumed by the layer registry. |

Total: 87 tracked files; whole-file counts include shared integrations.

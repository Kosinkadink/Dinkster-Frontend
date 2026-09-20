Refs #

## Extension contract

- [ ] Behavior keyed on a node id, family id, widget type, or pack id goes through the same registry door available to packs.
- [ ] Scanner allowlist additions link the issue that removes the entry.
- [ ] After merging main, run `node scripts/check-extension-literals.mjs --write`, review the diff, confirm no ceiling rose, and run `pnpm ci:fast`.
- [ ] A new extension kind or capability has a runtime consumer, doctor check, core dogfooding test, and synthetic-pack coverage in this PR.

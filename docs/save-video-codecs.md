# Save video controls

Video inputs and codec choices come from the selected backend's ordinary
registered schema. DynamicCombo controls show the selected branch and retain
stored branch data through selection changes, save and reopen. The frontend
does not invent an encoder, codec range or bit-depth conversion.

Historical flat or nested SaveVideo carrier documents are not automatically
migrated. Opening them preserves authored classes, values, DynamicCombo state
and links; invalid ports or absent classes prevent compilation rather than
inserting an assembly helper or rewriting output links. Embedded historical
replacement metadata does not authorize a graph edit.

Save nodes with separate filename prefix and MOUNT inputs use independent
controls. Mount selection does not rewrite the prefix or insert a helper node.
See [workflow translation](comfyui-workflow-translation.md) for positional widget
decoding and [video editing](video-edit-widget.md) for VIDEO_EDIT authoring.

The route-mocked `packages/e2e/tests/video-edit.spec.ts` tests retain ordinary
video editing and historical graph-preservation coverage. They are not evidence
of native SaveVideo registration, encoder availability or runtime parity.

# Graph-native compositor

`Add Layer` appends an image batch and optional transparency mask to an ordered
`LAYERS` value. `Layers From Bounding Boxes` creates placements from an image
batch and matching regions or detections. `Create Layered Image` renders at
most 50 expanded layers. Its compact `COMPOSITOR` row reports the saved command
count or a run-first prompt; it opens no editor.

The backend remains authoritative for all 27 blend modes, transforms, masks,
output pixels and the transparency mask. Stored recipes still run. A saved
delta is replayed only when its document digest matches the current layer
document. If sources change, execution uses native graph placements instead,
marks the result stale and leaves the saved delta untouched.

The schema retains the exact fieldless `COMPOSITOR` widget descriptor on
concrete `COMPOSITOR`. Its empty default is
`{"version":2,"documentDigest":null,"commands":[]}`. A configured delta binds
canvas, layer, transform, mask-transform and reorder commands to the runtime
document digest. Pixel content remains in digest-owned ImageDocument resources
and never enters the workflow value. See [Image documents](image-documents.md)
for the retained format and [the rework queue](rework-queue.md#compositor-editor)
for the parked editing surface.

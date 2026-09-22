# Starter templates

An empty workflow opens the starter gallery automatically. Templates are grouped by model family and show a thumbnail, source, description, and exact missing-model requirements. Choose **Start blank** to dismiss it. Run **Open template gallery** from universal search to return at any time. When no model folders are mounted, the gallery explains where models are read from. If the server allows mount changes, browser users can add a read-only folder by typing its server filesystem path in the gallery.

The Library sidebar and starter gallery search template identity, names, descriptions, families, and tags. Search lowercases the query and each searchable field, removes spaces and punctuation, and then performs a substring match. Thus `SD 1.5`, `sd1.5`, and `SD15` all match the `sd15` template id. `SDXL` matches the `sdxl` id, while `Stable Diffusion XL` matches the template name. Searches such as `stable`, `diffusion`, and `diffusion 1.5` continue to match the full template name. The Library pack selector applies the backend's exact pack filter.

Each row shows the template name, pack, description, tags, and declared asset requirements. Asset ids are pack-local and are resolved against the pack table from `/api/nodes`; a missing descriptor is displayed as its raw id instead of hiding the requirement.

Select a row and choose **Open template** to fetch its immutable body and load it through the normal native-document pipeline as a new, unsaved tab targeted at the serving backend. Opening does not acquire assets. Missing assets remain behind the existing submit-time consent flow. The selected row also exposes the exact template id, pack, backend, digest, tags, and declared requirements in the Library detail presentation.

Opening a template fits and centers its graph. When the complete graph fits at the canvas detail threshold, the fitted view keeps that threshold so node content remains readable even if the usual outer margin must shrink. Larger graphs still fit completely at overview scale, where node titles remain visible when their full text fits the node header.

## Remote catalog

Set **Template registry URL** in Settings to combine templates from a registry with the installed templates. The frontend consumes catalog version 1:

- `GET /index/templates` - descriptors from each pack's latest release. Descriptors carry `pack`, `version`, workflow digest, family, models, and optional thumbnail metadata.
- `GET /index/packs/{pack}/versions/{version}/templates/{id}` - template body verified against the descriptor's SHA-256 digest before it is opened.
- `GET /index/packs/{pack}/versions/{version}/templates/{id}/thumbnail` - immutable thumbnail bytes.

The latest successful descriptor list is cached for offline browsing. Opening still requires the immutable body to be reachable, and the body is rejected when its SHA-256 digest differs from the descriptor. Refreshing the gallery fetches the catalog again, so newly published templates appear without rebuilding the frontend.

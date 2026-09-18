# Guide browsing

The Learn dock panel searches and pages the active Dinkster backend's guide
descriptors. Selecting a guide fetches its immutable Markdown page by pack and
digest. The host chooses the active application locale when available and
shows an explicit notice when it falls back to the guide's default locale.
Pack names, tags, and guide body content remain backend-owned data.

Guide Markdown uses the constrained renderer described in [node help](node-help.md).
A valid `dinkster-example` block may offer one pack-owned template:

````text
```dinkster-example
template = "map-and-gather"
caption = "Start from the maintained example."
```
````

`template` is required and must be a simple pack-local identifier. `caption`
is optional. The action fetches the exact template from the backend that served
the guide and opens it as a new unlinked workflow. Invalid blocks, blueprint
examples, and blocks rendered outside the Learn host remain ordinary code.

Guide index searches do not depend on the host locale. Locale changes relabel
the mounted Learn panel and select another advertised immutable page without
refreshing node schemas or guide indexes. Guide-authored tours and tour
lifecycle are outside this panel's browsing contract.

# Node help

Schema wire 42 adds the present-only `hasDocs: true` marker to documented
nodes. The marker lets the canvas expose Help synchronously without putting
documentation descriptors in the node catalog. Older wires omit the marker.

Help is available from a documented node's context menu, palette preview, and
the F1 command when exactly one documented node is selected. The full page
opens in the Help panel; the node schema description remains the short search
and palette summary.

The panel queries `/api/docs` by pack and node type, selects an exact locale,
language match, or the descriptor's default locale, and fetches the immutable
Markdown body by digest. Bodies are cached in memory by pack and digest, and
asset URLs use pack-scoped digest routes. Falling back to the default locale
shows a notice. A page whose optional schema version is older than the loaded
node schema shows a warning.

## Markdown subset

The host renderer accepts headings, paragraphs, emphasis, strong text, inline
code, fenced code, ordered and unordered lists, block quotes, tables, links,
and pack-relative images. Raw HTML is removed. Links are limited to `https:`,
`mailto:`, and `dinkster:`. Image sources must be paths under `assets/` and must
resolve through the page descriptor's asset map.

Linked video uses a fenced `dinkster-media` block:

````text
```dinkster-media
asset = "assets/demo.mp4"
poster = "assets/poster.webp"
caption = "Map over a list"
```
````

`asset` is required. `poster` and `caption` are optional. Videos expose native
controls and never autoplay. Invalid media blocks render as ordinary code.

The shared parser also recognizes valid template-only `dinkster-example` blocks.
They remain ordinary code in node help because only the Learn panel supplies a
template-opening action. See [guide browsing](guide-browsing.md).

Parser tests cover raw HTML, unsafe links and assets, nested lists,
unterminated fences, tables, media blocks, and escaped inline syntax. DOM tests
cover safe links, unresolved assets, images, videos, captions, and renderer
semantics. Wire, client decoder, panel loading, locale fallback, stale-version,
menu, palette, tooltip, and F1 behavior have focused coverage.

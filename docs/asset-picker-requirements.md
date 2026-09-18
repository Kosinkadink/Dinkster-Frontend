# Asset picker standing requirements

This is the durable checklist of user-directed requirements for the asset
picker surfaces (ASSET widget dialog for media, latent, and model kinds, and
the shared collection browser). Every future rework issue for these surfaces
must copy this checklist and mark each item shipped / already-satisfied /
deferred; deferring an item requires the user's explicit OK on the issue.
Rework scope is written against this checklist, not against fresh screenshots
alone. Acceptance criteria must name the kinds they bind to (media, model,
latent, multi-select) or the components, because one shared shell still has
kind-specific data adapters and capabilities.

Each requirement keeps the user's verbatim words and its origin issue.

| # | Requirement | User's words (verbatim) | Origin |
| --- | --- | --- | --- |
| 1 | One primary navigation mechanism; breadcrumbs show only real path segments | "the path breadcrumb stuff should be just ONE way to intereact with assets" | #166 |
| 2 | Compact rows; demote digests and debug metadata behind a details affordance | "shows so much information the user does not give a shit about (like the digets and crap)" | #166 |
| 3 | Browse list stays primary; selection must not displace it; wider modal allowed | "why does after selecting a thing, it now takes up 70% of the image assets thing and the list becomes so small? ... Maybe have the selected seciton on the right? And the modals can become wider if needed." | #166 |
| 4 | Path display must read as a real path, not disconnected pills | "It is just clickable pills, it looks NOTHING like a path so would be extremely confusing to users" | #179 |
| 5 | One selection panel; clicking an item immediately shows it in the selection section | "If you click on a thing, it should immedaitely show up in the slection section. This means we dont need that second one." | #179 |
| 6 | Fewer buttons; the selected row must carry visible highlight | "too many bvuttons. We hav a 'choose' in the inner list (which doenst even have the highlight behavior ofr it ...), then a 'clear' and 'cancel' button" | #179 |
| 7 | Sane per-kind upload limits (no 1 GiB for single images) | "why is image allowing 1 GiB per file?" | #179 |
| 8 | Single images show their resolution; resolution/selection indicators render below the image, not overlaid | "Single images dont show the resolution, and that reoslution/selection thing should be underneath the images instead of rendered on top" | #179 |
| 9 | Model-asset picker has a search bar (applies to every picker kind) | "AND MODEL ASSETS dont have a goddamn search bar." | #179 |
| 10 | No redundant "compatible only" copy; compatibility is implied by the dialog | "We also have like 2 mentions per modal about 'compatible only' No shit, if it wasnt compatible with the restrictions of the modal, it wouldn't be displayed." | #179 |
| 11 | Model item details live in the right-side selection panel, not inline in the list | "we can leave showing deatils on the right side preview instead of rendering everything in the search" | #179 |

Where the current behavior for each item is specified: navigation and staging
in `docs/asset-browser-design.md`; dialog anatomy, selection staging, footer
actions, and upload limits in `docs/widget-editors.md`; model rows, search,
and details demotion in `docs/logical-model-variants.md`. All ASSET kinds use
one CollectionPanel browse shell; media and logical-model adapters supply its
items. Model upload is disabled, while media upload remains available.

# Internationalization

Dinkster uses a dependency-free catalog runtime from `@dinkster/core`. Host messages
use flat dotted keys. English is the source catalog and the fallback when an
active catalog or key is missing. Messages support `{name}` interpolation and
one non-nested plural block selected with `Intl.PluralRules`. Number, date,
and relative-time formatting use the active locale through the shared Intl
wrappers.

The global `dinkster.locale` setting controls the interface language. `Automatic`
uses the desktop default when provided, then the browser language, then
English. An explicit setting wins over those defaults. The active locale is a
framework-neutral signal. The application keeps the root HTML `lang` and `dir`
attributes synchronized with the canonical locale and its resolved writing
script. Explicit script subtags take precedence over language defaults.

The Electron preload bridge reads the operating-system application locale once
through trusted IPC. Bootstrap supplies that value to both the pre-engine setup
screen and the full application, so Automatic keeps the same desktop-first
selection across the transition. Explicit English or Chinese settings remain
authoritative.

English and Chinese are the explicit catalog choices. Automatic browser or
desktop locale selection follows the same host catalog and base-language
fallback path. The initial Chinese catalog was machine translated and requires
human language review. The host shell, command and
setting registries, App View, runtime-settings editor, and P2P surfaces resolve
their frontend-authored text from the active catalog. Backend labels, workflow
content, diagnostics, and other user-authored values remain data rather than
catalog messages. English and Chinese are left-to-right, but Automatic also
publishes right-to-left direction when the operating-system or browser locale
resolves to an RTL script. Browser acceptance uses an expanded, test-only RTL
catalog to cover mounted state, narrow layout, raw values, and request
boundaries without shipping another catalog or Settings choice.

Delegated-agent permission controls and activity labels use the app catalog.
Agent names, scopes, tool names, status values and pending questions remain
data. Changing locale does not replace an agent name already entered in the form.

The Settings editor also resolves its search, categories, result counts,
validation, reset and clear actions, and keybinding capture status from the
active catalog. A mounted locale change preserves its search and category,
draft and saved values, focused controls, and in-progress shortcut capture.
Setting and command identifiers, key combinations, entered values, and unknown
extension category identifiers remain unchanged data.

Solid components use a locale-tracked message accessor so mounted controls
update immediately. Long-lived registry descriptors expose localized labels as
getters, avoiding stale text captured at startup. Tests register partial,
asymmetric catalogs to prove active-locale updates and English fallback without
shipping a placeholder locale. Complete pseudo-locale acceptance also derives a
marked, expanded test catalog from every English key. It verifies the full
catalog through the production runtime and exercises mounted shell, command,
Settings, palette, App View, and dock chrome at wide and constrained sizes. The
pseudo catalog remains test-only and is not a supported locale or Settings
choice.

Wire 44 pack catalogs localize pack-owned node names and descriptions, input
and output labels and help, combo labels, search terms, and blueprint text. The
frontend fetches only immutable catalogs advertised by digest in the selected
pack record. Each field falls back independently through the active locale,
its base language, another advertised regional variant, and English before
retaining the schema text. Locale changes update the active registry overlay
without refetching schemas or changing node types, combo values, blueprint IDs,
digests, registry hashes, or workflow data. Unavailable or malformed catalogs
are ignored independently, and an older response cannot replace a newer locale.
Browser acceptance covers the supported English-to-Chinese setting flow and
independent English field fallback.

`pnpm check:ui-strings` compares direct JSX text and quoted JSX attributes with
the checked-in baseline. A new or changed matching literal fails the check,
including in a file that already contains allowed literals. Helper-call
arguments, expression children and attributes, and template literals are not
covered. String migration removes the corresponding baseline entries instead
of replacing them with new English literals.

# Dynamic input families

Dynamic input families let a node expose a variable number of related inputs.
They can use positional prefixes, fixed names such as `a` through `z`, grouped
rows with multiple inputs per member, or families nested inside a selected
mode.

Fresh nodes persist every required minimum member when they are placed. While
another member is available, the canvas shows one ghost member as the growth
target. Prefix families place it last, while named families offer the next
declared name after their latest retained member. Required minimum members use
later names first and wrap only when the remaining vocabulary is exhausted.
Connecting, editing, or dropping a link onto that ghost materializes it
atomically before the interaction is stored, and the next ghost appears. A
nested family whose ghost has no visible socket uses a clickable growth row
instead.

Member identity is stored independently from its current position. Saving,
reopening, removing, or growing other members does not rename an existing
member or move its values and links to another member. Named families keep
their declared semantic order without re-offering a retired earlier name as the
ghost. Positional API names continue to follow the visible member order.

## Named routing

A combo can source its choices from a sibling input family. Each choice keeps
the family's stable member id as its stored value, while the combo shows an
editable branch label. Open the combo, edit labels under **Branch labels**, and
apply them together. Labels must be non-empty and unique within the family;
the stable ids shown beside them are not editable or translated.

Route Switch by Name uses this source to select one family member. Renaming or
reordering branches does not change the selected id, links, cache identity, or
submitted graph. A forwarded family keeps labels on the owning subgraph
occurrence, so sibling instances can name the same stable members differently.

Wire-15 named numeric and boolean family members include an inline literal
editor unless their schema sets `forceInput`. Forced members render as
connection-only socket rows, so generic canvas layout can pair them with output
sockets on the same line. For editable families, editing a trailing ghost
materializes it before storing the value, while connecting the socket makes the
link authoritative without discarding the saved literal. Numeric unions use a
decimal editor and retain their full socket type for integer, float, and boolean
connections.

Materialized Autogrow members retain a hollow socket center when connected, so
their family-growth identity remains visually related to the trailing ghost,
independently of whether the member's value is required. Pasting a dynamic
node runs unused-member compaction in the same undo step as placement.
Referenced members survive with their existing ids, and removed ids remain
above the family's high-water sequence instead of being recycled.

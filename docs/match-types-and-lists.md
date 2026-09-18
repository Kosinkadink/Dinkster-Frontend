# Match types and lists

Dinkster distinguishes fixed types, match types, and `Any` directly on canvas:

| Pin | Meaning |
| --- | --- |
| Circle | Definite scalar value |
| Diamond | Definite list value |
| Square with an inscribed circle | Unresolved match input that accepts either a scalar or a whole list |
| Multi-color wedges | Every accepted member of a finite union or constrained match type |
| Solid dark ring | Standard border for fixed and match-type ports |
| Dashed dark ring | `Any`; the port accepts independently and never determines another port |

Finite unions paint one wedge for every member. Constrained match types use
the same member colors and standard dark border. Hovering a match pin,
or focusing it in the canvas scene navigator, enlarges every visible pin on
that node that shares its identity.

The circle is tangent to the square at all four side midpoints, so the combined
shape cannot be confused with a list diamond. Match-type outputs never use the
combined input shape. An unresolved output
shows its match identity; after inference it uses one definite circle or
diamond. Their tooltips name both the resolved type and the original accepted
set. A bare
match type stays neutral and is labelled by its identity; only true `Any`
uses the dashed wildcard ring.

Create List, Repeat Item, Select Value, Route Switch, and Route Gate use an
unconstrained match type for their generic value inputs. Connecting any port
can infer the shared type in either direction, including values connected from
widget output sockets. Disconnecting the determining link returns the ports to
their unresolved presentation. An unresolved graph remains editable;
incompatible connected constraints are reported instead of being coerced.

## List operations

- **Create List** collects each supplied item as one element. A list item stays
  nested: creating a list from `list<T>` values produces `list<list<T>>`.
- **Append to List** takes `list<T>` plus an ordered variadic family of `T`
  items and appends every supplied item as one element. List-valued items stay
  nested.
- **Concat Lists** explicitly concatenates lists by one level.

There is no implicit scalar-to-list promotion, list-to-scalar extraction, or
flattening. Use Create List, List Element, Append to List, or Concat Lists to
make the intended cardinality change visible in the graph.

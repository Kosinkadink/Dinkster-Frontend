# Match types and lists

## Built-in type vocabulary

Primitive socket ids are `INT`, `FLOAT`, `STRING`, `BOOLEAN`, and `COMBO`.
They are exact, case-sensitive identities, not aliases for `core.*` names.
NUMBER widgets bind to `INT` or `FLOAT`; STRING and COLOR widgets bind to
`STRING`; BOOLEAN and COMBO widgets bind to their respective socket ids.
MULTI_COMBO binds to `list<COMBO>`. Widget descriptors configure presentation
without changing the socket identity. Integer sockets preserve exact decimal
constraints outside JavaScript's safe-integer range; float constraints remain
JSON numbers. A widget on the wrong socket type is refused during registry
decoding rather than silently dropping the node's editor.

Other built-in socket ids also use bare uppercase names, including `ASSET`,
`SAVE_TARGET`, `REGION`, `CURVE`, `DETECTION`, `RESOURCE`, `VIDEO_DOCUMENT`,
`LAYERS`, `COMPOSITOR`, `MODEL3D`, and `SPLAT`. The backend's canonical
`builtin_types.py` module defines their spelling. Old `dinkster.*` type ids
are not aliases. Node ids retain their existing pack namespaces.

## Pin shapes

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

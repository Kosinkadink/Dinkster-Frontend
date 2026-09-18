"""Generate a golden /api/nodes payload through the REAL backend encoder.

Covers every TypeExpr kind (concrete, union, wildcard, variable free and
constrained, list incl. nested and element-polymorphic), input/output
families, defaults, onAbsent policies, optional outputs, docs, and the
admission hints (occupies/ioBound) - all emitted by dinkster_schema.schema_to_wire
at SCHEMA_WIRE_VERSION 3.

Usage (requires a Dinkster checkout at /tmp/dinkster-src, kept at origin/main):
    python3 scripts/gen-dinkster-nodes-fixture.py > packages/core/fixtures/dinkster-nodes.json

Regenerate whenever the backend event/schema wire changes so goldens stay
recorded through the REAL encoder, never hand-written.
"""

import json
import sys

sys.path.insert(0, "/tmp/dinkster-src/packages/dinkster-values/src")
sys.path.insert(0, "/tmp/dinkster-src/packages/dinkster-schema/src")

from dinkster_schema import (  # noqa: E402
    SCHEMA_WIRE_VERSION,
    InputFamilySpec,
    InputSpec,
    NodeSchema,
    OutputFamilySpec,
    OutputSpec,
    TypeExpr,
    schema_to_wire,
)

INT = TypeExpr.concrete("core.int")
FLOAT = TypeExpr.concrete("core.float")
STRING = TypeExpr.concrete("core.string")
BOOLEAN = TypeExpr.concrete("core.boolean")
IMAGE = TypeExpr.concrete("std.image")

schemas = [
    # Plain primitives with defaults (widget derivation targets).
    NodeSchema(
        node_type="std.math.add_ints",
        display_name="Add Ints",
        category="math",
        inputs=(InputSpec("a", INT), InputSpec("b", INT, default=1)),
        outputs=(OutputSpec("sum", INT),),
    ),
    NodeSchema(
        node_type="test.primitives",
        display_name="Primitives",
        category="test",
        description="every widget-derivable primitive",
        inputs=(
            InputSpec("count", INT, default=4, doc="how many"),
            InputSpec("scale", FLOAT, default=0.5),
            InputSpec("label", STRING, default="hi"),
            InputSpec("enabled", BOOLEAN, default=True),
            InputSpec("image", IMAGE, required=False),
        ),
        outputs=(OutputSpec("out", STRING),),
    ),
    # Absence: onAbsent policies + optional outputs.
    NodeSchema(
        node_type="test.absence",
        display_name="Absence",
        category="test",
        inputs=(
            InputSpec("must", IMAGE, on_absent="fail"),
            InputSpec("tolerant", IMAGE, on_absent="accept"),
            InputSpec("maybe", IMAGE, required=False),
        ),
        outputs=(
            OutputSpec("image", IMAGE),
            OutputSpec("mask", IMAGE, optional=True, doc="present when detected"),
        ),
    ),
    # Type expressions: union, wildcard, variables, lists (nested + polymorphic).
    NodeSchema(
        node_type="test.types",
        display_name="Types",
        category="test",
        inputs=(
            InputSpec("either", TypeExpr.union("core.int", "core.float")),
            InputSpec("anything", TypeExpr.wildcard()),
            InputSpec("t_in", TypeExpr.variable("T")),
            InputSpec("c_in", TypeExpr.variable("C", allowed=("core.int", "core.float"))),
            InputSpec("ints", TypeExpr.list_of(INT)),
            InputSpec("matrix", TypeExpr.list_of(TypeExpr.list_of(INT))),
            InputSpec("items", TypeExpr.list_of(TypeExpr.variable("T"))),
        ),
        outputs=(OutputSpec("t_out", TypeExpr.variable("T")),),
        idempotent=False,
    ),
    # Families, both sides; bounded and unbounded.
    NodeSchema(
        node_type="test.families",
        display_name="Families",
        category="test",
        inputs=(InputSpec("bias", INT, default=0),),
        input_families=(
            InputFamilySpec("operands", INT, min_members=2, max_members=8, doc="grows"),
            InputFamilySpec("extras", IMAGE),
        ),
        outputs=(OutputSpec("out", INT),),
        output_families=(OutputFamilySpec("parts", STRING, min_members=1, max_members=4),),
    ),
    # Admission hints ride the wire but must not affect editor semantics.
    NodeSchema(
        node_type="test.hints",
        display_name="Hints",
        category="test",
        inputs=(InputSpec("image", IMAGE),),
        outputs=(OutputSpec("out", IMAGE),),
        occupies=("gpu",),
    ),
]

payload = {
    "schemaVersion": SCHEMA_WIRE_VERSION,
    "nodes": {s.node_type: schema_to_wire(s) for s in schemas},
}
print(json.dumps(payload, indent=2, sort_keys=True))

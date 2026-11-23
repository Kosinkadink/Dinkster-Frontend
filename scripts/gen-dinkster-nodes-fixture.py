"""Generate a golden /api/nodes payload through the REAL backend encoder.

Every node declares its rows as a schema wire 2 body tree. Covers every
TypeExpr kind (concrete, union, wildcard, variable free and constrained,
list incl. nested and element-polymorphic), growing Group rows of inputs
and of outputs (grows on link, numbered member keys, bounded and
unbounded), defaults, onAbsent policies, optional outputs, tooltips,
widgets, editor roles, and the admission hint occupies - all emitted by
dinkster_schema.schema_to_wire.

Usage (requires a Dinkster checkout at /tmp/dinkster-src unless
DINKSTER_SOURCE_ROOT is set):
    python3 scripts/gen-dinkster-nodes-fixture.py > packages/core/fixtures/dinkster-nodes.json

Regenerate whenever the backend event/schema wire changes so goldens stay
recorded through the REAL encoder, never hand-written.
"""

import json
import os
import sys

SOURCE_ROOT = os.environ.get("DINKSTER_SOURCE_ROOT", "/tmp/dinkster-src")
sys.path.insert(0, f"{SOURCE_ROOT}/packages/dinkster-values/src")
sys.path.insert(0, f"{SOURCE_ROOT}/packages/dinkster-schema/src")

from dinkster_schema import (  # noqa: E402
    SCHEMA_WIRE_VERSION,
    AssetWidget,
    Group,
    Input,
    NodeSchema,
    Numbered,
    NumberWidget,
    Output,
    TypeExpr,
    schema_to_wire,
)
from dinkster_values import VIDEO_EDIT_TYPE, CustomWidgetDescriptor  # noqa: E402

INT = TypeExpr.concrete("INT")
FLOAT = TypeExpr.concrete("FLOAT")
STRING = TypeExpr.concrete("STRING")
BOOLEAN = TypeExpr.concrete("BOOLEAN")
IMAGE = TypeExpr.concrete("std.image")

schemas = [
    # Plain primitives with defaults (widget derivation targets).
    NodeSchema(
        node_type="std.math.add_ints",
        display_name="Add Ints",
        category="math",
        body=(Input("a", INT), Input("b", INT, default=1), Output("sum", INT)),
    ),
    NodeSchema(
        node_type="test.primitives",
        display_name="Primitives",
        category="test",
        description="every widget-derivable primitive",
        body=(
            Input("count", INT, default=4, tooltip="how many"),
            Input("scale", FLOAT, default=0.5),
            Input("label", STRING, default="hi"),
            Input("enabled", BOOLEAN, default=True),
            Input("image", IMAGE, required=False),
            Output("out", STRING),
        ),
    ),
    NodeSchema(
        node_type="test.editor_metadata",
        display_name="Editor Metadata",
        category="test",
        editor_role="video-edit",
        body=(
            Input(
                "edit",
                TypeExpr.concrete(VIDEO_EDIT_TYPE),
                required=False,
                widget=CustomWidgetDescriptor("VIDEO_EDIT", {"features": ["trim", "crop"]}),
            ),
        ),
    ),
    # Absence: onAbsent policies + optional outputs.
    NodeSchema(
        node_type="test.absence",
        display_name="Absence",
        category="test",
        body=(
            Input("must", IMAGE, on_absent="fail"),
            Input("tolerant", IMAGE, on_absent="accept"),
            Input("maybe", IMAGE, required=False),
            Output("image", IMAGE),
            Output("mask", IMAGE, optional=True, tooltip="present when detected"),
        ),
    ),
    NodeSchema(
        node_type="test.numeric_union",
        display_name="Frame rate",
        category="test",
        body=(
            Input(
                "frame_rate",
                TypeExpr.union("FLOAT", "INT"),
                default=25.0,
                widget=NumberWidget(min=1.0, max=1000.0, step=0.01, display="number"),
            ),
        ),
        output_node=True,
    ),
    # Type expressions: union, wildcard, variables, lists (nested + polymorphic).
    NodeSchema(
        node_type="test.types",
        display_name="Types",
        category="test",
        body=(
            Input("either", TypeExpr.union("INT", "FLOAT")),
            Input("anything", TypeExpr.wildcard()),
            Input("t_in", TypeExpr.variable("T")),
            Input("c_in", TypeExpr.variable("C", allowed=("INT", "FLOAT"))),
            Input("ints", TypeExpr.list_of(INT)),
            Input("matrix", TypeExpr.list_of(TypeExpr.list_of(INT))),
            Input("items", TypeExpr.list_of(TypeExpr.variable("T"))),
            Output("t_out", TypeExpr.variable("T")),
        ),
        idempotent=False,
    ),
    # Growing groups of inputs and of outputs; bounded and unbounded.
    NodeSchema(
        node_type="test.families",
        display_name="Families",
        category="test",
        body=(
            Input("bias", INT, default=0),
            Group(
                "operands",
                value=Input("value", INT),
                keys=Numbered("value", start=0),
                min_members=2,
                max_members=8,
                tooltip="grows",
            ),
            Group("extras", value=Input("value", IMAGE), keys=Numbered("value", start=0)),
            Output("out", INT),
            Group(
                "parts",
                value=Output("part", STRING),
                keys=Numbered("part", start=0),
                min_members=1,
                max_members=4,
            ),
        ),
    ),
    # Admission hints ride the wire but must not affect editor semantics.
    NodeSchema(
        node_type="test.hints",
        display_name="Hints",
        category="test",
        body=(Input("image", IMAGE), Output("out", IMAGE)),
        occupies=("gpu",),
    ),
]

for kind, default in (
    ("model/vae", "pixel_space"),
    ("model/diffusers", "vendor/model"),
    ("directory/input", "train/set"),
    ("directory/dataset", "dataset"),
):
    schemas.append(NodeSchema(
        node_type=f"test.selection_{kind.replace('/', '_')}",
        body=(Input(
            "name",
            TypeExpr.union("COMBO", "ASSET") if kind == "model/vae" else TypeExpr.concrete("COMBO"),
            default=default,
            widget=AssetWidget(kind=kind, selection=True),
        ),),
        output_node=True,
    ))

payload = {
    "schemaVersion": SCHEMA_WIRE_VERSION,
    "nodes": {s.node_type: schema_to_wire(s) for s in schemas},
}
print(json.dumps(payload, indent=2, sort_keys=True))

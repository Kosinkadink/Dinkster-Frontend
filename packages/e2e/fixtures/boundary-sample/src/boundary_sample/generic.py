"""Generic CPU receivers with full scalar and array receipts."""

import json

import numpy as np
from dinkster_api.v1 import (
    ABSENT,
    Group,
    Input,
    Members,
    Node,
    NodeSchema,
    Numbered,
    Output,
    Record,
    TypeExpr,
)


def generic_receipt(value):
    if isinstance(value, np.ndarray):
        return {
            "shape": list(value.shape),
            "dtype": str(value.dtype),
            "values": value.tolist(),
        }
    return value


class GenericReceiver(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        generic = TypeExpr.variable("T", ("FLOAT", "IMAGE", "MASK"))
        return NodeSchema(
            "boundary-sample.generic",
            output_node=True,
            body=(
                Input("value", generic, required=False),
                Output("result", generic, optional=True),
                Output("receipt", TypeExpr.concrete("STRING")),
            ),
        )

    @classmethod
    def execute(cls, *, value=None):
        return cls.outputs(
            result=ABSENT if value is None else value,
            receipt=json.dumps({"value": generic_receipt(value)}, sort_keys=True),
        )


class GenericMembers(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        generic = TypeExpr.variable("T", ("FLOAT", "IMAGE", "MASK"))
        return NodeSchema(
            "boundary-sample.generic-members",
            output_node=True,
            body=(
                Group(
                    "items",
                    member=(
                        Input("value", generic, required=False),
                        Output("result", generic, optional=True),
                    ),
                    keys=Numbered("item", start=0),
                    grows="button",
                    max_members=4,
                    reorderable=True,
                    independent_types=True,
                ),
                Output("receipt", TypeExpr.concrete("STRING")),
            ),
        )

    @classmethod
    def execute(cls, *, items: Members[Record]):
        return {
            "items": {
                member.key: {
                    "result": ABSENT if member.get("value") is None else member["value"]
                }
                for member in items
            },
            "receipt": json.dumps(
                {
                    "items": [
                        {
                            "key": member.key,
                            "value": generic_receipt(member.get("value")),
                        }
                        for member in items
                    ]
                },
                sort_keys=True,
            ),
        }

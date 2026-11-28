"""CPU-only boundary oracles, executed by the ordinary pack worker."""

from __future__ import annotations

import json
from collections.abc import Mapping

import numpy as np
from dinkster_api.v1 import (
    ASSET_TYPE,
    AssetRef,
    AssetWidget,
    Button,
    Choice,
    ComboWidget,
    Count,
    Described,
    Formula,
    Group,
    Input,
    Item,
    Lookup,
    Members,
    Named,
    Node,
    NodeSchema,
    Numbered,
    NumberWidget,
    Option,
    Output,
    Record,
    Set,
    StringWidget,
    TypeChoice,
    TypeExpr,
    TypeRegistry,
    Use,
    Variant,
    decode_image_array,
    digest_bytes,
    encode_image_array,
    image_array_fingerprint,
    image_array_meta,
    lookup,
    mask_array_meta,
    register_asset_type,
    resolver_from_env,
    validate_image_encoded,
)

from .generic import GenericMembers, GenericReceiver

FLOAT = TypeExpr.concrete("FLOAT")
INT = TypeExpr.concrete("INT")
STRING = TypeExpr.concrete("STRING")
IMAGE = TypeExpr.concrete("IMAGE")
MASK = TypeExpr.concrete("MASK")
ASSET = TypeExpr.concrete(ASSET_TYPE)


def register_types(registry: TypeRegistry) -> None:
    if ASSET_TYPE not in registry:
        register_asset_type(registry, resolver_from_env())
    for name, meta in (("IMAGE", image_array_meta), ("MASK", mask_array_meta)):
        registry.register(
            name,
            encode=encode_image_array,
            decode=decode_image_array,
            fingerprint=image_array_fingerprint(name),
            meta=meta,
            validate_encoded=validate_image_encoded,
            validate_encoded_buffer=validate_image_encoded,
            asset_references_complete=True,
        )


def field(id: str, default: float = 0.3) -> Input:
    return Input(id, FLOAT, default=default, widget=NumberWidget(min=0, max=1))


def pin(id: str, type: TypeExpr) -> Input:
    return Input(id, type, required=False)


class BoundarySample(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            "boundary-sample.sample",
            display_name="Boundary sample",
            category="test",
            output_node=True,
            body=(
                pin("image", IMAGE),
                pin("mask", MASK),
                Input(
                    "strength",
                    FLOAT,
                    default=0.3,
                    widget=NumberWidget(min=0, max=1),
                    tooltip="Mix strength",
                    visible=Formula("True"),
                ),
                field("radius", 0.1),
                field("feather", 0.4),
                field("balance", 0.7),
                Group(
                    "layers",
                    member=(
                        pin("image", IMAGE),
                        field("strength"),
                        Output("result", FLOAT),
                    ),
                    keys=Numbered("layer", start=0),
                    grows="button",
                    max_members=8,
                    reorderable=True,
                ),
                Group(
                    "nested",
                    member=(
                        Group(
                            "weights",
                            value=field("weight"),
                            keys=Numbered("w", start=0),
                            grows="button",
                            max_members=4,
                        ),
                    ),
                    keys=Numbered("n", start=0),
                    grows="button",
                    max_members=4,
                ),
                Choice(
                    "mode",
                    options=(
                        Option("image", rows=(pin("picture", IMAGE), Use("mix"))),
                        Option(
                            "text",
                            rows=(
                                Input(
                                    "text",
                                    STRING,
                                    default="inner text",
                                    widget=StringWidget(multiline=False),
                                ),
                                Use("mix"),
                            ),
                        ),
                    ),
                    shared=(field("mix"),),
                    default="image",
                ),
                TypeChoice(
                    "source",
                    variants=(
                        Variant("image", IMAGE, rows=(field("gain", 0.1),)),
                        Variant("mask", MASK, rows=(field("gain", 0.7),)),
                    ),
                    required=False,
                ),
                Described(
                    "description",
                    kinds=(
                        Input(
                            "text",
                            STRING,
                            default="description default",
                            widget=StringWidget(multiline=False),
                        ),
                        Output("number", FLOAT),
                    ),
                    min_entries=0,
                    max_entries=4,
                    fixed_ids=True,
                ),
                Input(
                    "count",
                    INT,
                    default=3,
                    pin=False,
                    widget=NumberWidget(min=1, max=4),
                ),
                Group(
                    "outputs",
                    value=Output("number", FLOAT),
                    keys=Numbered("o", start=0),
                    grows=Count(Formula("count")),
                    max_members=4,
                ),
                Output("result", FLOAT),
                Output("output91", FLOAT),
                Output("receipt", STRING),
            ),
        )

    @classmethod
    def execute(
        cls,
        *,
        strength: float,
        layers: Members[Record],
        nested: Members[Record],
        mode: Record,
        outputs: Members[Item],
        description: Mapping[str, object],
        image=None,
        mask=None,
        source=None,
        **fields,
    ) -> Mapping[str, object]:
        def pixels(value):
            return None if value is None else np.asarray(value).reshape(-1).tolist()

        receipt = {
            "strength": strength,
            "image": pixels(image),
            "mask": pixels(mask),
            "layers": [
                {
                    "key": member.key,
                    "strength": member["strength"],
                    "image": pixels(member.get("image")),
                }
                for member in layers
            ],
            "nested": [
                {
                    "key": member.key,
                    "weights": [
                        {"key": item.key, "value": item.value}
                        for item in member["weights"]
                    ],
                }
                for member in nested
            ],
            "mode": {
                "key": mode.key,
                "mix": mode["mix"],
                "text": mode.get("text"),
                "picture": pixels(mode.get("picture")),
            },
            "source": None
            if source is None
            else {
                "variant": source.variant,
                "pixels": pixels(source.value),
                "gain": source.options["gain"],
            },
            "description": dict(description),
        }
        return {
            "layers": {member.key: {"result": member["strength"]} for member in layers},
            "outputs": {
                member.key: (index + 1) * 10.0 for index, member in enumerate(outputs)
            },
            "description": {
                key: 47.0 for key, value in description.items() if value is None
            },
            "result": strength,
            "output91": 91.0,
            "receipt": json.dumps(receipt, sort_keys=True),
        }


class ImageSource(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema("boundary-sample.image", body=(Output("image", IMAGE),))

    @classmethod
    def execute(cls):
        return cls.outputs(image=np.array([[[[0.125, 0.25, 0.5]]]], dtype=np.float32))


class MaskSource(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema("boundary-sample.mask", body=(Output("mask", MASK),))

    @classmethod
    def execute(cls):
        return cls.outputs(mask=np.array([[[0.75]]], dtype=np.float32))


class NumberSink(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            "boundary-sample.sink",
            output_node=True,
            body=(pin("number", FLOAT), Output("received", STRING)),
        )

    @classmethod
    def execute(cls, *, number=None):
        return cls.outputs(received=json.dumps(number))


class FloatSource(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema("boundary-sample.float", body=(Output("number", FLOAT),))

    @classmethod
    def execute(cls):
        return cls.outputs(number=0.9)


class IntSource(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema("boundary-sample.int", body=(Output("number", INT),))

    @classmethod
    def execute(cls):
        return cls.outputs(number=2)


class ButtonCounter(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            "boundary-sample.button-counter",
            output_node=True,
            body=(
                Input("amount", FLOAT, default=3.0, widget=NumberWidget(step=1)),
                Input("delta", FLOAT, default=7.0, widget=NumberWidget(step=1)),
                Button(
                    "increase", "Increase", (Set("amount", Formula("amount + delta")),)
                ),
                Output("result", FLOAT),
                Output("private_delta", FLOAT),
            ),
        )

    @classmethod
    def execute(cls, *, amount, delta):
        return cls.outputs(result=amount, private_delta=delta)


@lookup
def calculate_total(seed: int, bias: int) -> int:
    return seed * 2 + bias


class FormulaCalculation(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            "boundary-sample.formula",
            output_node=True,
            body=(
                Input("seed", INT, default=3, widget=NumberWidget(step=1)),
                Input("bias", INT, default=7, widget=NumberWidget(step=1)),
                Input("text", STRING, default="", widget=StringWidget()),
                Input(
                    "total",
                    INT,
                    default=5,
                    widget=NumberWidget(step=1),
                    automatic=Formula("seed * 2 + bias"),
                ),
                Output("result", INT),
                Output("receipt", STRING),
            ),
        )

    @classmethod
    def execute(cls, *, seed, bias, text, total):
        return cls.outputs(
            result=total,
            receipt=json.dumps({"seed": seed, "bias": bias, "total": total}),
        )


class LookupCalculation(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            "boundary-sample.lookup",
            output_node=True,
            body=(
                Input("seed", INT, default=3, widget=NumberWidget(step=1)),
                Input("bias", INT, default=7, widget=NumberWidget(step=1)),
                Input("text", STRING, default="", widget=StringWidget()),
                Input(
                    "total",
                    INT,
                    default=5,
                    widget=NumberWidget(step=1),
                    automatic=Lookup(calculate_total, args=("seed", "bias")),
                ),
                Output("result", INT),
                Output("receipt", STRING),
            ),
        )

    @classmethod
    def execute(cls, *, seed, bias, text, total):
        return cls.outputs(
            result=total,
            receipt=json.dumps({"seed": seed, "bias": bias, "total": total}),
        )


class GroupPicker(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            "boundary-sample.group-picker",
            output_node=True,
            body=(
                Group(
                    "layers",
                    value=Input("weight", INT, default=1, widget=NumberWidget(step=1)),
                    keys=Named(("red", "blue", "gold")),
                    grows="button",
                    reorderable=True,
                ),
                Input(
                    "pick",
                    TypeExpr.concrete("COMBO"),
                    default="red",
                    widget=ComboWidget(options=Formula("keys(layers)")),
                    label="Selected layer",
                    tooltip="Choose an existing member",
                ),
                Input(
                    "order",
                    STRING,
                    default="unknown",
                    automatic=Formula('join(",", keys(layers))'),
                ),
                Output("result", INT),
                Output("receipt", STRING),
            ),
        )

    @classmethod
    def execute(cls, *, layers: Members[Item], pick: str, order: str):
        values = layers.as_dict()
        return cls.outputs(
            result=values.get(pick, -1),
            receipt=json.dumps(
                {
                    "layers": [
                        {"key": member.key, "value": member.value} for member in layers
                    ],
                    "pick": pick,
                    "order": order,
                },
            ),
        )


class GroupChoiceSource(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            "boundary-sample.group-choice",
            body=(Output("value", TypeExpr.concrete("COMBO")),),
        )

    @classmethod
    def execute(cls):
        return cls.outputs(value="gold")


def asset_value(digit: int) -> AssetRef:
    data = str(digit).encode() * (digit * 10)
    return AssetRef(
        digest=digest_bytes(data),
        name=f"{digit}.bin",
        size=len(data),
        media_type="application/octet-stream",
        virtual_path=f"assets/{digit}.bin",
    )


def asset_field(id: str) -> Input:
    return Input(
        id,
        ASSET,
        default=asset_value(9).to_wire(),
        widget=AssetWidget(accept=("application/octet-stream",)),
        label="Source asset",
        tooltip="Choose the source asset",
    )


class AssetConsumer(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            "boundary-sample.asset-consumer",
            output_node=True,
            body=(asset_field("asset"), Output("receipt", STRING)),
        )

    @classmethod
    def execute(cls, *, asset: AssetRef):
        return cls.outputs(
            receipt=json.dumps(
                {"asset": asset.to_wire(), "bytes": asset.read_bytes().decode("ascii")}
            )
        )


class AssetLiteral(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            "boundary-sample.asset-literal",
            body=(asset_field("asset"), Output("value", ASSET)),
        )

    @classmethod
    def execute(cls, *, asset: AssetRef):
        return cls.outputs(value=asset)


class AssetSource(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            "boundary-sample.asset-source", body=(Output("value", ASSET),)
        )

    @classmethod
    def execute(cls):
        return cls.outputs(value=asset_value(7))


NODES = [
    BoundarySample,
    ImageSource,
    MaskSource,
    NumberSink,
    FloatSource,
    IntSource,
    ButtonCounter,
    FormulaCalculation,
    LookupCalculation,
    GroupPicker,
    GroupChoiceSource,
    AssetConsumer,
    AssetLiteral,
    AssetSource,
    GenericReceiver,
    GenericMembers,
]

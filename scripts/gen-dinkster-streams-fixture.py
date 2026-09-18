"""Record golden Dinkster WS event streams through the REAL engine + encoder.

Runs four scenarios on dinkster_engine with an event recorder, converts every
EngineEvent through the real dinkster_server engine_event_to_wire (loaded by
file path - the server package __init__ pulls aiohttp, which we don't need),
and appends the job_state transitions the server's queue would emit. Also
records the node-state map a completed job status would carry (the
_NODE_STATE_FOR_KIND mapping from app.py, replicated here as data since
app.py itself needs aiohttp).

Scenarios:
- success: linear m -> a -> b with progress + preview reports
- skip-cascade: optional producer yields nothing; a, b skip with root origin
- failure: strict on_absent='fail' consumer -> node_failed + job failed
- cached: second run of success replays from cache

Usage (requires a Dinkster checkout at /tmp/dinkster-src, kept at origin/main):
    python3 scripts/gen-dinkster-streams-fixture.py > packages/core/fixtures/events/dinkster-streams.json

Regenerate whenever the backend event/schema wire changes so goldens stay
recorded through the REAL encoder, never hand-written.
"""

import asyncio
import importlib.util
import json
import sys

P = "/tmp/dinkster-src/packages"
for pkg in ("dinkster-values", "dinkster-schema", "dinkster-graph", "dinkster-caches",
            "dinkster-assets", "dinkster-memory", "dinkster-workers", "dinkster-engine"):
    sys.path.insert(0, f"{P}/{pkg}/src")

from collections.abc import Mapping  # noqa: E402

from dinkster_caches import MemoryLRUCache  # noqa: E402
from dinkster_engine import Engine, ExecutionError  # noqa: E402
from dinkster_graph import Graph, GraphNode, Link  # noqa: E402
from dinkster_schema import (  # noqa: E402
    ABSENT,
    InputSpec,
    Node,
    NodeSchema,
    OutputSpec,
    TypeExpr,
    build_node_types,
    build_schemas,
    report_preview,
    report_progress,
)
from dinkster_values import TypeRegistry, register_core_types  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "server_events", f"{P}/dinkster-server/src/dinkster_server/events.py"
)
server_events = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_events)
engine_event_to_wire = server_events.engine_event_to_wire
BINARY_BLOB_KEY = server_events.BINARY_BLOB_KEY

# Mirrors dinkster_server.app._NODE_STATE_FOR_KIND (app.py needs aiohttp).
NODE_STATE_FOR_KIND = {
    "node_started": "running",
    "node_cached": "cached",
    "node_finished": "completed",
    "node_failed": "failed",
    "node_skipped": "skipped",
}

INT = TypeExpr.concrete("core.int")


class MaybeProduce(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            node_type="test.maybe_produce",
            inputs=(InputSpec("produce", TypeExpr.concrete("core.boolean")),),
            outputs=(OutputSpec("value", INT, optional=True),),
        )

    @classmethod
    def execute(cls, produce: bool) -> Mapping[str, object]:
        return cls.outputs(value=7 if produce else ABSENT)


class AddOne(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            node_type="test.add_one",
            inputs=(InputSpec("value", INT),),
            outputs=(OutputSpec("out", INT),),
        )

    @classmethod
    def execute(cls, value: int) -> Mapping[str, object]:
        report_progress(1, 2, text="adding")
        report_progress(2, 2)
        return cls.outputs(out=value + 1)


class Previewer(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            node_type="test.previewer",
            inputs=(InputSpec("value", INT),),
            outputs=(OutputSpec("out", INT),),
        )

    @classmethod
    def execute(cls, value: int) -> Mapping[str, object]:
        report_preview(b"\xff\xd8fakejpeg", mime="image/jpeg", width=8, height=8)
        return cls.outputs(out=value)


class Repeat(Node):
    """Produces a list<core.int> so recorded streams carry a real per-output
    summary WITH a length field (node_finished/node_cached detail.outputs)."""

    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            node_type="test.repeat",
            inputs=(InputSpec("value", INT),),
            outputs=(OutputSpec("items", TypeExpr.list_of(INT)),),
        )

    @classmethod
    def execute(cls, value: int) -> Mapping[str, object]:
        return cls.outputs(items=[value, value, value])


class Strict(Node):
    @classmethod
    def define_schema(cls) -> NodeSchema:
        return NodeSchema(
            node_type="test.strict",
            inputs=(InputSpec("value", INT, on_absent="fail"),),
            outputs=(OutputSpec("out", INT),),
        )

    @classmethod
    def execute(cls, value: int) -> Mapping[str, object]:
        return cls.outputs(out=value)


NODES = (MaybeProduce, AddOne, Previewer, Repeat, Strict)


def make_engine(events):
    registry = TypeRegistry()
    register_core_types(registry)
    return Engine(
        schemas=build_schemas(NODES),
        registry=registry,
        worker=InProcessWorker(build_node_types(NODES), registry),
        cache=MemoryLRUCache(),
        on_event=events.append,
    )


from dinkster_workers import InProcessWorker  # noqa: E402


def record(scenario, client_id, job_id, graph, targets, engine=None, events=None):
    """Run one job the way the server would: engine events with client/job
    correlation, bracketed by job_state transitions."""
    recorded = []
    own_events = events if events is not None else []
    eng = engine or make_engine(own_events)
    start = len(own_events)
    run_id = f"run-{scenario}"

    recorded.append({"type": "job_state", "clientId": client_id, "jobId": job_id,
                     "state": "running", "runId": run_id})
    error = None
    result = None
    try:
        result = asyncio.run(eng.run(graph, targets, run_id=run_id))
        final_state = "completed"
    except ExecutionError as exc:
        final_state = "failed"
        error = {
            "kind": "execution",
            "nodeId": exc.error.node_id,
            "nodeType": exc.error.node_type,
            "message": exc.error.message,
            "traceback": exc.error.traceback,
        }
    for ev in own_events[start:]:
        wire = engine_event_to_wire(ev, client_id=client_id, job_id=job_id)
        blob = wire.pop(BINARY_BLOB_KEY, None)
        if blob is not None:
            wire["_blobBase64"] = __import__("base64").b64encode(blob).decode()
            wire["_binary"] = True
        recorded.append(wire)
    job_state = {"type": "job_state", "clientId": client_id, "jobId": job_id,
                 "state": final_state, "runId": run_id}
    if error is not None:
        job_state["error"] = error
    recorded.append(job_state)

    node_states = {}
    for ev in own_events[start:]:
        st = NODE_STATE_FOR_KIND.get(ev.kind)
        if st is not None and ev.node_id is not None:
            node_states[ev.node_id] = st
    job_wire = {
        "clientId": client_id, "jobId": job_id, "state": final_state,
        "priority": 0, "runId": run_id, "submittedAt": 0.0, "startedAt": 0.0,
        "finishedAt": 0.0, "nodeStates": node_states,
    }
    if error is not None:
        job_wire["error"] = error
    if result is not None:
        job_wire["executed"] = list(result.executed)
        job_wire["cached"] = list(result.cached)
        job_wire["skipped"] = list(result.skipped)
        # Mirror the real server's value_descriptor (dinkster_server/app.py):
        # top-level "length" comes from list_children, never envelope attrs.
        from dinkster_values import list_children

        def descriptor(v):
            d = {"typeId": v.type_id, "fingerprint": v.fingerprint,
                 "meta": dict(v.meta.entries)}
            children = list_children(v)
            if children is not None:
                d["length"] = len(children)
            return d

        job_wire["outputs"] = {
            n: {o: descriptor(v) for o, v in outs.items()}
            for n, outs in result.outputs.items()
        }
    return {"scenario": scenario, "messages": recorded, "job": job_wire}, eng, own_events


success_graph = Graph(nodes={
    "m": GraphNode("test.maybe_produce", {"produce": True}),
    "a": GraphNode("test.add_one", {"value": Link("m", "value")}),
    "p": GraphNode("test.previewer", {"value": Link("a", "out")}),
    "r": GraphNode("test.repeat", {"value": Link("a", "out")}),
})
skip_graph = Graph(nodes={
    "m": GraphNode("test.maybe_produce", {"produce": False}),
    "a": GraphNode("test.add_one", {"value": Link("m", "value")}),
    "b": GraphNode("test.add_one", {"value": Link("a", "out")}),
})
fail_graph = Graph(nodes={
    "m": GraphNode("test.maybe_produce", {"produce": False}),
    "s": GraphNode("test.strict", {"value": Link("m", "value")}),
})

streams = []
s1, engine, events = record("success", "client-a", "job-1", success_graph, ["p", "r"])
streams.append(s1)
s2, _, _ = record("cached", "client-a", "job-2", success_graph, ["p", "r"], engine=engine, events=events)
streams.append(s2)
s3, _, _ = record("skip-cascade", "client-a", "job-3", skip_graph, ["b"])
streams.append(s3)
s4, _, _ = record("failure", "client-b", "job-4", fail_graph, ["s"])
streams.append(s4)

print(json.dumps({"streams": streams}, indent=1, sort_keys=True))

import { describe, expect, it } from "vitest";
import {
  asConnectionId,
  compile,
  loadDocument,
  type WorkflowDocument,
} from "@dinkster/core";
import { DinksterConnection } from "../src/index.js";

const LIVE_URL = process.env["DINKSTER_LIVE_URL"];
const TEMPLATE_IDS = [
  "loop-map-images",
  "loop-gather-image-batch",
  "loop-fold-scan-images",
  "loop-while-until",
  "loop-per-item-image-spawn",
] as const;

describe.skipIf(!LIVE_URL)("live production loop templates", () => {
  it("discovers, loads, round-trips, compiles, executes, and replays every loop template", async () => {
    const clientId = `loop-templates-${process.pid}`;
    const connection = new DinksterConnection({
      id: asConnectionId("loop-templates-live"),
      baseUrl: LIVE_URL!,
      clientId,
    });
    const registry = await connection.fetchSchemas();
    expect(registry.graphFeatures).toContain("regions");

    const catalogResponse = await fetch(`${LIVE_URL}/api/templates`);
    expect(catalogResponse.ok).toBe(true);
    const catalog = (await catalogResponse.json()) as {
      readonly templates: readonly {
        readonly pack: string;
        readonly id: string;
      }[];
    };
    const available = new Set(
      catalog.templates
        .filter((row) => row.pack === "dinkster-nodes-foundation")
        .map((row) => row.id),
    );
    for (const templateId of TEMPLATE_IDS)
      expect(available.has(templateId)).toBe(true);

    for (const templateId of TEMPLATE_IDS) {
      const response = await fetch(
        `${LIVE_URL}/api/packs/dinkster-nodes-foundation/templates/${templateId}`,
      );
      expect(response.ok).toBe(true);
      const source = await response.json();
      const loaded = loadDocument(source);
      expect(loaded.document, JSON.stringify(loaded.diagnostics)).toBeDefined();
      expect(
        loaded.diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error",
        ),
      ).toEqual([]);

      const exported = JSON.stringify(loaded.document);
      const reopened = loadDocument(JSON.parse(exported));
      expect(reopened.document).toEqual(loaded.document);
      const compiled = compile({
        document: reopened.document as WorkflowDocument,
        revision: 1,
        resolve: registry.resolve,
        scope: { kind: "full" },
        connection: registry.connection,
        schemaHash: registry.hash,
        ...(registry.graphFeatures === undefined
          ? {}
          : { graphFeatures: registry.graphFeatures }),
      });
      expect(
        compiled.ok,
        JSON.stringify(!compiled.ok && compiled.diagnostics),
      ).toBe(true);
      if (!compiled.ok) continue;
      expect(compiled.artifact.dinksterGraph).toBeDefined();

      const submitted = await connection.submit(compiled.artifact);
      expect(
        submitted.ok,
        JSON.stringify(!submitted.ok && submitted.diagnostics),
      ).toBe(true);
      if (!submitted.ok) continue;
      const job = await waitForJob(connection, submitted.execution.prompt);
      expect(job["state"], JSON.stringify(job["error"])).toBe("completed");
      assertExpectedOutput(templateId, job);

      const jobRef = job["jobRef"];
      expect(typeof jobRef).toBe("string");
      const replayResponse = await fetch(
        `${LIVE_URL}/api/jobs/by-ref/${jobRef}/events`,
      );
      expect(replayResponse.ok).toBe(true);
      const replay = (await replayResponse.json()) as {
        readonly events: readonly {
          readonly type: string;
          readonly nodeId?: string;
          readonly detail?: {
            readonly iteration?: number;
            readonly outputs?: Record<string, { readonly value?: unknown }>;
          };
        }[];
      };
      const started = replay.events.filter(
        (event) => event.type === "region_iteration_started",
      );
      const finished = replay.events.filter(
        (event) => event.type === "region_iteration_finished",
      );
      expect(started.length).toBe(expectedIterations(templateId));
      expect(finished.length).toBe(expectedIterations(templateId));
      expect(started.map((event) => event.detail?.iteration).sort()).toEqual(
        Array.from(
          { length: expectedIterations(templateId) },
          (_, index) => index,
        ),
      );
      await assertDistinctIterationOutputs(
        templateId,
        clientId,
        submitted.execution.prompt,
        replay.events,
      );
    }
  }, 120_000);
});

const expectedIterations = (
  templateId: (typeof TEMPLATE_IDS)[number],
): number => (templateId === "loop-while-until" ? 4 : 3);

function assertExpectedOutput(
  templateId: (typeof TEMPLATE_IDS)[number],
  job: Readonly<Record<string, unknown>>,
): void {
  const outputs = job["outputs"] as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  if (templateId === "loop-while-until") {
    expect(outputs["output"]?.["text"]?.["value"]).toBe("4");
    return;
  }
  expect(outputs["output"]?.["image_a"]?.["typeId"]).toBe("dinkster.image");
  const expectedShape =
    templateId === "loop-fold-scan-images"
      ? [1, 48, 96, 3]
      : templateId === "loop-per-item-image-spawn"
        ? [3, 512, 48, 3]
        : templateId === "loop-map-images"
          ? [3, 64, 96, 3]
          : [3, 64, 64, 3];
  expect(outputs["output"]?.["image_a"]?.["meta"]).toMatchObject({
    shape: expectedShape,
  });
}

async function assertDistinctIterationOutputs(
  templateId: (typeof TEMPLATE_IDS)[number],
  clientId: string,
  jobId: string,
  events: readonly {
    readonly type: string;
    readonly nodeId?: string;
    readonly detail?: {
      readonly outputs?: Record<string, { readonly value?: unknown }>;
    };
  }[],
): Promise<void> {
  if (templateId === "loop-while-until") {
    const values = events.flatMap((event) => {
      const value = event.detail?.outputs?.["sum"]?.value;
      return /loop\[\d+\]\/add$/.test(event.nodeId ?? "") &&
        typeof value === "number"
        ? [value]
        : [];
    });
    expect(values).toEqual([1, 2, 3, 4]);
    return;
  }

  const location = {
    "loop-map-images": ["map", "composite"],
    "loop-gather-image-batch": ["map", "image"],
    "loop-fold-scan-images": ["fold", "composite"],
    "loop-per-item-image-spawn": ["spawn", "image"],
  }[templateId];
  if (location === undefined)
    throw new Error(`missing iteration output location for '${templateId}'`);
  const [regionId, nodeId] = location;
  const renditions: string[] = [];
  for (
    let iteration = 0;
    iteration < expectedIterations(templateId);
    iteration += 1
  ) {
    const query = new URLSearchParams({
      clientId,
      jobId,
      nodeId: `${regionId}[${iteration}]/${nodeId}`,
      outputId: "image",
    });
    const response = await fetch(`${LIVE_URL}/api/values?${query}`);
    if (!response.ok) throw new Error(await response.text());
    renditions.push(
      Buffer.from(await response.arrayBuffer()).toString("base64"),
    );
  }
  expect(new Set(renditions).size).toBe(renditions.length);
}

async function waitForJob(
  connection: DinksterConnection,
  jobId: string,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    const job = await connection.fetchJob(jobId);
    if (
      job?.state === "completed" ||
      job?.state === "failed" ||
      job?.state === "cancelled"
    ) {
      return job as unknown as Record<string, unknown>;
    }
    if (Date.now() - started > 60_000)
      throw new Error(`timeout waiting for '${jobId}'`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

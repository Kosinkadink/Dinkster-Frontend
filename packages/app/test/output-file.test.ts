import { describe, expect, it } from "vitest";
import { outputHostPath } from "../src/output-file.js";

describe("saved output host paths", () => {
  it("joins mounted virtual paths for Unix and Windows roots", () => {
    expect(
      outputHostPath(
        {
          outputMount: "output",
          mounts: [
            {
              id: "output",
              mode: "readwrite",
              state: "ready",
              path: "/library/output",
            },
          ],
        },
        "mounts/output/ComfyUI_00001.png",
      ),
    ).toBe("/library/output/ComfyUI_00001.png");
    expect(
      outputHostPath(
        {
          outputMount: "renders",
          mounts: [
            {
              id: "renders",
              mode: "readwrite",
              state: "ready",
              path: "D:\\Renders",
            },
          ],
        },
        "mounts/renders/jobs/scene.png",
      ),
    ).toBe("D:\\Renders\\jobs\\scene.png");
  });

  it("refuses unmounted and traversing virtual paths", () => {
    const settings = {
      mounts: [
        {
          id: "output",
          mode: "readwrite" as const,
          state: "ready",
          path: "/library/output",
        },
      ],
    };
    expect(outputHostPath(settings, "mounts/other/image.png")).toBeUndefined();
    expect(outputHostPath(settings, "mounts/output/../secret")).toBeUndefined();
    expect(outputHostPath(settings, "mounts/output/jobs\\..\\secret")).toBeUndefined();
  });
});

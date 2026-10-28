// @vitest-environment happy-dom

import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputMountSettings } from "../src/OutputMountSettings.js";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("OutputMountSettings", () => {
  it("lists only writable mounts and persists an explicit selection", async () => {
    const fetchMountSettings = vi.fn(async () => ({
      outputMount: "output",
      mountChangesAllowed: true,
      mounts: [
        { id: "models", mode: "read" as const, state: "ready" },
        { id: "output", mode: "readwrite" as const, state: "ready" },
        { id: "renders", mode: "readwrite" as const, state: "ready" },
      ],
    }));
    const selectOutputMount = vi.fn(async () => {});
    const root = document.createElement("div");
    document.body.append(root);
    render(
      () => (
        <OutputMountSettings
          connection={{ fetchMountSettings, selectOutputMount }}
        />
      ),
      root,
    );
    await flush();

    const select = root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    select.click();
    expect(
      [...document.querySelectorAll('[role="option"]')].map(
        (option) => option.textContent,
      ),
    ).toEqual(["output", "renders"]);
    document.querySelector<HTMLElement>('[data-option-id="renders"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-testid="output-mount-apply"]')!.click();
    await flush();

    expect(selectOutputMount).toHaveBeenCalledWith("renders");
    expect(fetchMountSettings).toHaveBeenCalledTimes(2);
  });

  it("replaces failed loading with an enabled retry and recovers the mount selector", async () => {
    const fetchMountSettings = vi.fn()
      .mockRejectedValueOnce(new Error("GET /api/mounts failed: 503"))
      .mockResolvedValue({ outputMount: "output", mountChangesAllowed: false, mounts: [{ id: "output", mode: "readwrite", state: "ready" }] });
    const root = document.createElement("div");
    document.body.append(root);
    const dispose = render(() => <OutputMountSettings connection={{ fetchMountSettings, selectOutputMount: async () => {} }} />, root);
    await flush();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("GET /api/mounts failed: 503");
    expect(root.textContent).not.toContain("Loading output mount");
    const retry = root.querySelector<HTMLButtonElement>('[data-testid="output-mount-retry"]')!;
    expect(retry.disabled).toBe(false);
    retry.click();
    await flush();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('[data-testid="default-output-mount"]')?.textContent).toContain("output");
    dispose();
  });
});

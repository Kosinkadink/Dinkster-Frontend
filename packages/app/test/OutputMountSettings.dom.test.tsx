// @vitest-environment happy-dom

import { render } from "solid-js/web";
import { createSignal, type ComponentProps } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputMountSettings } from "../src/OutputMountSettings.js";
import { DinksterConnection } from "@dinkster/client";
import { asConnectionId } from "@dinkster/core";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("OutputMountSettings", () => {
  it.each([false, true])("resolves null output into configuration guidance (writable: %s)", async (writable) => {
    const connection = new DinksterConnection({
      id: asConnectionId("native"), baseUrl: "http://native", clientId: "test",
      fetchFn: async () => new Response(JSON.stringify({
        mounts: [{ id: "renders", mode: writable ? "readwrite" : "read", state: "ready" }],
        outputMount: null, activeOutputMount: null, mountChangesAllowed: true,
      })),
    });
    const root = document.createElement("div");
    document.body.append(root);
    const dispose = render(() => <OutputMountSettings connection={connection} />, root);
    try {
      await vi.waitFor(() => expect(root.textContent).toContain("No output mount configured"));
      expect(root.textContent).not.toContain("Loading output mount");
      expect(root.textContent).not.toContain("Unsaved changes");
      const select = root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      expect(select.disabled).toBe(!writable);
      if (writable) {
        select.click();
        document.querySelector<HTMLElement>('[data-option-id="renders"]')!.click();
        expect(root.querySelector<HTMLButtonElement>('[data-testid="output-mount-apply"]')?.disabled).toBe(false);
      } else {
        expect(root.textContent).toContain("Add a read-write folder in Project folders");
      }
    } finally { dispose(); }
  });

  it("lists only writable mounts and persists an explicit selection", async () => {
    const fetchMountSettings = vi.fn(async () => ({
      outputMount: "output",
      activeOutputMount: "legacy",
      restartRequired: true,
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
          connection={{ fetchMountSettings, selectOutputMount, onMountsChanged: () => () => {} }}
        />
      ),
      root,
    );
    await flush();

    const select = root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(root.textContent).toContain("Active output: legacy");
    expect(select.textContent).toContain("output");
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

  it.each([false, true])("keeps a new connection selection isolated from a pending old save (reject: %s)", async (rejectOld) => {
    type Connection = ComponentProps<typeof OutputMountSettings>["connection"];
    let settleOld!: () => void;
    const oldSave = new Promise<void>((resolve, reject) => { settleOld = () => rejectOld ? reject(new Error("Old output save failed")) : resolve(); });
    let finishNew!: () => void;
    const newSave = new Promise<void>((resolve) => { finishNew = resolve; });
    let nextOutput = "new-output";
    let ping!: () => void;
    const first: Connection = {
      onMountsChanged: () => () => {}, selectOutputMount: () => oldSave,
      fetchMountSettings: async () => ({ mountChangesAllowed: true, outputMount: "old-output", mounts: [
        { id: "old-output", mode: "readwrite", state: "ready" }, { id: "old-next", mode: "readwrite", state: "ready" },
      ] }),
    };
    const second: Connection = {
      onMountsChanged: (callback) => { ping = callback; return () => {}; },
      selectOutputMount: async (id) => { await newSave; nextOutput = id; },
      fetchMountSettings: async () => ({ mountChangesAllowed: true, outputMount: nextOutput, mounts: [
        { id: "new-output", mode: "readwrite", state: "ready" }, { id: "new-next", mode: "readwrite", state: "ready" },
      ] }),
    };
    const [connection, setConnection] = createSignal(first);
    const root = document.createElement("div");
    document.body.append(root);
    const dispose = render(() => <OutputMountSettings connection={connection()} />, root);
    const select = () => root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    const apply = () => root.querySelector<HTMLButtonElement>('[data-testid="output-mount-apply"]')!;
    const choose = (id: string) => {
      select().click();
      document.querySelector<HTMLElement>(`[data-option-id="${id}"]`)!.click();
    };
    try {
      await vi.waitFor(() => expect(select()?.textContent).toContain("old-output"));
      choose("old-next"); apply().click();
      setConnection(second);
      await vi.waitFor(() => expect(select()?.textContent).toContain("new-output"));
      choose("new-next"); apply().click();
      settleOld();
      await oldSave.catch(() => {});
      await flush();
      expect(root.textContent).not.toContain("Old output save failed");
      expect(select().textContent).toContain("new-next");
      expect(apply().disabled).toBe(true);
      finishNew();
      await vi.waitFor(() => expect(root.textContent).not.toContain("Saving"));
      nextOutput = "new-output"; ping();
      await vi.waitFor(() => expect(select().textContent).toContain("new-output"));
    } finally { finishNew(); dispose(); }
  });

  it("replaces failed loading with an enabled retry and recovers the mount selector", async () => {
    const fetchMountSettings = vi.fn()
      .mockRejectedValueOnce(new Error("GET /api/mounts failed: 503"))
      .mockResolvedValue({ outputMount: "output", mountChangesAllowed: false, mounts: [{ id: "output", mode: "readwrite", state: "ready" }] });
    const root = document.createElement("div");
    document.body.append(root);
    const dispose = render(() => <OutputMountSettings connection={{ fetchMountSettings, selectOutputMount: async () => {}, onMountsChanged: () => () => {} }} />, root);
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

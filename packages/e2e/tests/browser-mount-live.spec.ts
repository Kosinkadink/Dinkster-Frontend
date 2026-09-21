import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { evidencePath } from "./evidence-output.js";

const backend = process.env["DINKSTER_NATIVE_BACKEND"];
if (!backend)
  throw new Error(
    "DINKSTER_NATIVE_BACKEND must identify the hosted native backend",
  );
const nativeFrontend = process.env["DINKSTER_E2E_NATIVE_FRONTEND"];
if (!nativeFrontend)
  throw new Error(
    "DINKSTER_E2E_NATIVE_FRONTEND must identify the native-only frontend",
  );
test.use({ baseURL: nativeFrontend, viewport: { width: 1600, height: 900 } });

const frontendRoot = resolve(import.meta.dirname, "../../..");
const modelsRoot = resolve(frontendRoot, ".ci/browser-mount-live/models");
const fixtureName = "issue-269-fixture.safetensors";
const fixturePath = resolve(modelsRoot, fixtureName);
const mountId = "issue-269-browser-mount";

interface MountRow {
  readonly id: string;
  readonly mode: "read" | "readwrite";
  readonly state: string;
  readonly path?: string;
}

interface MountsResponse {
  readonly mounts: readonly MountRow[];
  readonly outputMount?: string;
}

/**
 * Minimal but structurally valid safetensors: 8-byte little-endian header
 * length, JSON header, then the tensor bytes the header declares.
 */
function tinySafetensors(): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      weight: { dtype: "F32", shape: [1], data_offsets: [0, 4] },
    }),
    "utf8",
  );
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(header.length, 0);
  return Buffer.concat([prefix, header, Buffer.alloc(4)]);
}

const mounts = async (
  request: APIRequestContext,
): Promise<MountsResponse> => {
  const response = await request.get(`${backend}/api/mounts`);
  return (await response.json()) as MountsResponse;
};

const findMount = (
  body: MountsResponse,
  id: string,
): MountRow | undefined => body.mounts.find((mount) => mount.id === id);

async function openAssetEditor(page: Page): Promise<void> {
  await expect(page.getByTestId("widget-modal-surface")).toHaveCount(0);
  await page.getByTestId("graph-canvas").focus();
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!
      .getScene()
      .nodes.find((item) => item.id === "asset")!;
    const row = node.layout.rows.find(
      (item) => item.kind === "widget" && item.inputId === "model",
    )!;
    const rect = document.querySelector(
      "[data-testid=graph-canvas]",
    )!.getBoundingClientRect();
    return {
      x: rect.left + node.x + node.layout.width / 2,
      y: rect.top + node.y + row.y + row.height / 2,
    };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("asset-editor")).toBeVisible();
}

test(
  "the browser template gallery grants a read-only model mount and the asset picker browses it",
  async ({ page, request }) => {
    test.setTimeout(120_000);

    // Isolated fixture folder under the frontend .ci test area, written
    // before any browser interaction so the server can index it in place.
    await rm(modelsRoot, { recursive: true, force: true });
    await mkdir(modelsRoot, { recursive: true });
    await writeFile(fixturePath, tinySafetensors());

    const settings = await mounts(request);
    const outputMountId = settings.outputMount;
    const hostedOutput = outputMountId
      ? findMount(settings, outputMountId)
      : undefined;
    expect(hostedOutput).toBeTruthy();
    expect(hostedOutput!.path).toBeTruthy();

    try {
      // Remove the hosted output mount through the real API so the backend
      // starts with zero mounts; the saved descriptor restores it below.
      await request.delete(
        `${backend}/api/mounts/${encodeURIComponent(hostedOutput!.id)}`,
      );
      await expect
        .poll(async () => (await mounts(request)).mounts.length)
        .toBe(0);

      await page.goto("/");
      await expect(page.getByTestId("status-bar")).toContainText(
        /\d+ node schemas/,
        { timeout: 15_000 },
      );
      await expect(page.getByTestId("status-bar")).toContainText("connected");

      // An empty workflow shows the template gallery on its own, and with
      // zero mounts it explains folder granting and offers the typed form.
      const gallery = page.getByTestId("template-gallery");
      await expect(gallery).toBeVisible({ timeout: 15_000 });
      const mountsSection = gallery.locator(".template-gallery-mounts");
      await expect(mountsSection).toContainText(
        "Grant read-only access to an existing folder. Dinkster indexes models in place without copying them.",
      );

      await page.locator("#desktop-mount-path").fill(modelsRoot);
      await page.locator("#desktop-mount-id").fill(mountId);
      // Submitting the form is proven by the server-side effect below: the
      // granted status line unmounts with the section once the settings
      // refetch observes the new mount, so it is not reliably assertable.
      await page.getByRole("button", { name: "Grant folder" }).click();

      // The server (not a mock) created the mount as read-only and scanned
      // the fixture folder to ready.
      let created: MountRow | undefined;
      await expect
        .poll(
          async () => {
            created = findMount(await mounts(request), mountId);
            return created?.state;
          },
          { timeout: 30_000 },
        )
        .toBe("ready");
      expect(created!.mode).toBe("read");
      expect(created!.path).toBe(modelsRoot);

      // An ASSET widget constrained to model/checkpoint browses the mounted
      // source: the fixture file appears as a pickable Browse row, and the
      // picker's source facet names the new mount.
      await page.evaluate(() => {
        window.__dinksterTest!.app.registerSchemas([
          {
            type: "BrowserMountLiveTest",
            displayName: "Browser Mount Live",
            category: "test",
            source: "v3",
            isOutputNode: false,
            items: [
              {
                kind: "input",
                id: "model",
                type: { kind: "concrete", name: "ASSET" },
                optional: false,
                widget: {
                  widgetType: "ASSET",
                  options: { accept: [] },
                  default: null,
                  kind: "model/checkpoint",
                },
              },
            ],
          },
        ]);
        window.__dinksterTest!.app.openDocument(
          {
            format: "dinkster-workflow",
            formatVersion: 1,
            lineage: "browser-mount-live",
            root: "g0",
            graphs: {
              g0: {
                id: "g0",
                name: "root",
                nodes: {
                  asset: {
                    id: "asset",
                    type: "BrowserMountLiveTest",
                    values: {},
                  },
                },
                links: {},
                nets: {},
                reroutes: {},
                nextOrdinal: 2,
              },
            },
            view: {
              graphs: {
                g0: { nodes: { asset: { position: { x: 100, y: 100 } } } },
              },
            },
          } as never,
          "Browser mount live",
        );
        window.__dinksterTest!.renderer!.setViewport({
          x: 0,
          y: 0,
          scale: 1,
        });
      });
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                window.__dinksterTest!.renderer!
                  .getScene()
                  .nodes.find((item) => item.id === "asset")
                  ?.layout.rows.some(
                    (item) =>
                      item.kind === "widget" && item.inputId === "model",
                  ) === true,
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      await openAssetEditor(page);

      const editor = page.getByTestId("asset-editor");
      await expect(editor).toContainText("model/checkpoint");
      const browse = editor.locator("section.asset-browser-section");
      await expect(browse).toContainText("Browse");
      await expect(
        browse.getByRole("option", { name: fixtureName }),
      ).toBeVisible({ timeout: 15_000 });
      await editor.getByTestId("collection-source-select").click();
      await expect(
        page
          .getByRole("listbox", { name: "Source" })
          .getByRole("option", { name: mountId }),
      ).toBeVisible();
      await page.keyboard.press("Escape");

      await page.screenshot({
        path: evidencePath("issue-269", "browser-mount-browse.png"),
        fullPage: true,
      });
    } finally {
      // Best effort, never masking the test's own failure: delete the test
      // mount, recreate the hosted output mount from the saved descriptor,
      // and re-select it as the default so later specs stay isolated.
      await request
        .delete(`${backend}/api/mounts/${encodeURIComponent(mountId)}`)
        .catch(() => undefined);
      if (hostedOutput !== undefined) {
        await request
          .post(`${backend}/api/mounts`, {
            data: {
              id: hostedOutput.id,
              path: hostedOutput.path,
              mode: hostedOutput.mode,
            },
          })
          .catch(() => undefined);
        if (outputMountId !== undefined) {
          await request
            .put(`${backend}/api/mounts/output`, {
              data: { id: outputMountId },
            })
            .catch(() => undefined);
        }
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const body = await mounts(request).catch(() => undefined);
          if (findMount(body ?? { mounts: [] }, hostedOutput.id)?.state === "ready")
            break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      await rm(modelsRoot, { recursive: true, force: true });
    }
  },
);

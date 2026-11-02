import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
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
const mountId = "issue-269-models";

interface MountRow {
  readonly id: string;
  readonly mode: "read" | "readwrite";
  readonly state: string;
  readonly path?: string;
}

interface MountsResponse {
  readonly mounts: readonly MountRow[];
  readonly outputMount?: string;
  readonly mountChangesAllowed: boolean;
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

const mounts = async (request: APIRequestContext): Promise<MountsResponse> => {
  const response = await request.get(`${backend}/api/mounts`);
  return (await response.json()) as MountsResponse;
};

const findMount = (body: MountsResponse, id: string): MountRow | undefined =>
  body.mounts.find((mount) => mount.id === id);

async function openAssetEditor(page: Page): Promise<void> {
  await expect(page.getByTestId("widget-modal-surface")).toHaveCount(0);
  await page.getByTestId("graph-canvas").focus();
  const point = await page.evaluate(() => {
    const node = window
      .__dinksterTest!.renderer!.getScene()
      .nodes.find((item) => item.id === "asset")!;
    const row = node.layout.rows.find(
      (item) => item.kind === "widget" && item.inputId === "model",
    )!;
    const rect = document
      .querySelector("[data-testid=graph-canvas]")!
      .getBoundingClientRect();
    return {
      x: rect.left + node.x + node.layout.width / 2,
      y: rect.top + node.y + row.y + row.height / 2,
    };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("asset-editor")).toBeVisible();
}

test("the browser template gallery grants a read-only model mount and the asset picker browses it", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  // Isolated fixture folder under the frontend .ci test area, written
  // before any browser interaction so the server can index it in place.
  await rm(modelsRoot, { recursive: true, force: true });
  await mkdir(modelsRoot, { recursive: true });
  await writeFile(fixturePath, tinySafetensors());

  const settings = await mounts(request);
  expect(settings.mountChangesAllowed).toBe(true);
  expect(findMount(settings, mountId)).toBeUndefined();

  // The hosted suite imports model mounts from its ComfyUI fixture. Present
  // the browser with the same zero-mount response as a fresh `dinkster`
  // launch while leaving the real backend available for the grant and scan.
  let hideHostedMounts = true;
  let zeroMountResponseSeen = false;
  await page.route("**/api/mounts", async (route) => {
    const url = new URL(route.request().url());
    if (
      hideHostedMounts &&
      route.request().method() === "GET" &&
      url.pathname === "/api/mounts"
    ) {
      const response = await route.fetch();
      const body = (await response.json()) as MountsResponse;
      zeroMountResponseSeen = true;
      await route.fulfill({
        response,
        json: { ...body, mounts: [], outputMount: undefined },
      });
      return;
    }
    await route.continue();
  });

  try {
    await page.goto("/");
    await expect(page.getByTestId("status-bar")).toContainText(
      /\d+ node schemas/,
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("status-bar")).toContainText("connected");

    await page
      .getByRole("button", { name: "Browse starter templates" })
      .click();
    // With zero mounts the gallery explains folder granting and offers the typed form.
    const gallery = page.getByTestId("template-gallery");
    await expect(gallery).toBeVisible({ timeout: 15_000 });
    const mountsSection = gallery.locator(".template-gallery-mounts");
    await expect(mountsSection).toContainText(
      "Grant read-only access to an existing folder. Dinkster indexes models in place without copying them.",
    );
    expect(zeroMountResponseSeen).toBe(true);

    await page.locator("#desktop-mount-path").fill(modelsRoot);
    await page.locator("#desktop-mount-id").fill(mountId);
    // Submitting the form is proven by the server-side effect below: the
    // granted status line unmounts with the section once the settings
    // refetch observes the new mount, so it is not reliably assertable.
    hideHostedMounts = false;
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

    // A generic ASSET widget browses the mounted source: the fixture file
    // appears as a pickable Browse row, and the source facet names the mount.
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
              window
                .__dinksterTest!.renderer!.getScene()
                .nodes.find((item) => item.id === "asset")
                ?.layout.rows.some(
                  (item) => item.kind === "widget" && item.inputId === "model",
                ) === true,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await openAssetEditor(page);

    const editor = page.getByTestId("asset-editor");
    const browse = editor.locator("section.asset-browser-section");
    await expect(browse).toContainText("Browse");
    await editor.getByTestId("collection-source-select").click();
    const mountSource = page
      .getByRole("listbox", { name: "Source" })
      .getByRole("option", { name: mountId });
    await expect(mountSource).toBeVisible();
    await mountSource.click();
    const fixture = browse.getByRole("option", { name: fixtureName });
    await expect(fixture).toBeVisible({ timeout: 15_000 });
    await fixture.click();

    await page.screenshot({
      path: evidencePath("issue-269", "browser-mount-browse.png"),
      fullPage: true,
    });
  } finally {
    // Best effort, never masking the test's own failure: delete the test
    // mount so later specs stay isolated.
    await request
      .delete(`${backend}/api/mounts/${encodeURIComponent(mountId)}`)
      .catch(() => undefined);
    await rm(modelsRoot, { recursive: true, force: true });
  }
});

test("a ComfyUI checkpoint filename binds through the real mount index on import", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const parent = resolve(frontendRoot, ".ci/browser-mount-live");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "checkpoint-"));
  const name = "v1-5-pruned-emaonly.safetensors";
  const id = "checkpoint-import";
  const bytes = tinySafetensors();
  bytes.writeFloatLE(37, bytes.length - 4);
  await writeFile(resolve(root, name), bytes);
  const workflow = {
    version: 0.4,
    nodes: [
      {
        id: 1,
        type: "CheckpointLoaderSimple",
        pos: [80, 80],
        widgets_values: [name],
        outputs: [{ name: "MODEL" }, { name: "CLIP" }, { name: "VAE" }],
      },
    ],
    links: [],
  };
  let granted = false;
  try {
    expect(findMount(await mounts(request), id)).toBeUndefined();
    const response = await request.post(`${backend}/api/mounts`, {
      data: { id, path: root, mode: "read", kind: "model/checkpoint" },
    });
    expect(response.ok(), await response.text()).toBe(true);
    granted = true;
    await expect
      .poll(async () => findMount(await mounts(request), id)?.state, {
        timeout: 30_000,
      })
      .toBe("ready");

    await page.goto("/");
    await expect(page.getByTestId("status-bar")).toContainText("connected");
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__dinksterTest?.app.backends
            .get()
            .some((backend) =>
              backend.registry.get()?.schemas.has("CheckpointLoaderSimple"),
            ),
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(
        async (source) =>
          window.__dinksterTest!.app.importWorkflowFile({
            name: "checkpoint.json",
            text: async () => JSON.stringify(source),
          }),
        workflow,
      ),
    ).toBe(true);

    const selection = () =>
      page.evaluate(
        () =>
          window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!
            .values.ckpt_name,
      );
    await expect.poll(selection).toMatchObject({
      name,
      size: bytes.length,
      virtualPath: `mounts/${id}/${name}`,
    });
    const asset = (await selection()) as { digest: string };
    expect(asset.digest).toMatch(/^blake3:[0-9a-f]{64}$/);
    const download = await request.get(
      `${backend}/api/assets/${encodeURIComponent(asset.digest)}`,
    );
    expect(download.ok()).toBe(true);
    expect(await download.body()).toEqual(bytes);
    await expect(
      page.getByTestId("import-asset-resolution-dialog"),
    ).toHaveCount(0);
    const document = await page.evaluate(
      () => window.__dinksterTest!.app.activeTab()!.store.doc,
    );
    expect(
      Object.values(document.graphs.g0!.nodes).map((node) => node.type),
    ).toEqual(["CheckpointLoaderSimple"]);
    expect(document.ext?.["importer.comfyWorkflow"]).toEqual(workflow);
  } finally {
    try {
      if (granted) {
        await request
          .delete(`${backend}/api/mounts/${id}`)
          .catch(() => undefined);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

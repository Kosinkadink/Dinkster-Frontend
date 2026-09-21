import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";

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
test.use({ baseURL: nativeFrontend });
const frontendRoot = resolve(import.meta.dirname, "../../..");
const library = resolve(frontendRoot, ".ci/native-library");
const alternateOutput = resolve(library, "renders");
const evidence = resolve(frontendRoot, "docs/evidence/issue-145");

function tinyPng(): Buffer {
  const crc = (buffer: Buffer): number => {
    let value = ~0;
    for (const byte of buffer) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++)
        value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    return ~value >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(16, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(16 * 3, 96)]);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk(
      "IDAT",
      deflateSync(Buffer.concat(Array.from({ length: 16 }, () => row))),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function openSaveImageWorkflow(
  page: Page,
  asset: Record<string, unknown>,
): Promise<void> {
  await page.evaluate((source) => {
    window.__dinksterTest!.app.openDocument(
      {
        format: "dinkster-workflow",
        formatVersion: 1,
        lineage: "output-mount-e2e",
        root: "g0",
        graphs: {
          g0: {
            id: "g0",
            name: "root",
            nodes: {
              load: {
                id: "load",
                type: "dinkster.load_image",
                values: { image: source },
              },
              save: { id: "save", type: "dinkster.save_image", values: {} },
            },
            links: {
              image: {
                id: "image",
                from: { node: "load", port: "image" },
                to: { node: "save", port: "images" },
              },
            },
            nets: {},
            reroutes: {},
            nextOrdinal: 3,
          },
        },
        view: {
          graphs: {
            g0: {
              nodes: {
                load: { position: { x: 80, y: 120 } },
                save: { position: { x: 420, y: 120 } },
              },
            },
          },
        },
      } as never,
      "Output mount proof",
    );
  }, asset);
}

async function queueAndWait(
  page: Page,
  completedBefore: number,
): Promise<void> {
  await expect(page.getByTestId("queue-button")).toBeEnabled({
    timeout: 15_000,
  });
  await page.getByTestId("queue-button").click();
  await expect(
    page.getByTestId("execution-row").filter({ hasText: "Completed" }),
  ).toHaveCount(completedBefore + 1, { timeout: 30_000 });
}

test("Save Image publishes its mounted path and follows the persisted output mount setting", async ({
  page,
  request,
}) => {
  await mkdir(evidence, { recursive: true });
  await mkdir(alternateOutput, { recursive: true });
  const added = await request.post(`${backend}/api/mounts`, {
    data: { id: "renders", path: alternateOutput, mode: "readwrite" },
  });
  expect(added.status()).toBe(201);
  await expect
    .poll(async () => {
      const response = await request.get(`${backend}/api/mounts`);
      const body = (await response.json()) as {
        mounts: Array<{ id: string; state: string }>;
      };
      return body.mounts.find((mount) => mount.id === "renders")?.state;
    })
    .toBe("ready");

  const uploaded = await request.post(
    `${backend}/api/assets/media?scope=local&kind=media%2Fimage&name=output-mount-source.png`,
    {
      headers: { "Content-Type": "image/png" },
      data: tinyPng(),
    },
  );
  expect([200, 201]).toContain(uploaded.status());
  const { asset } = (await uploaded.json()) as {
    asset: Record<string, unknown>;
  };

  await page.goto("/");
  await expect(page.getByTestId("status-bar")).toContainText(
    /\d+ node schemas/,
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("status-bar")).toContainText("connected");
  await openSaveImageWorkflow(page, asset);
  await page.getByTestId("assets-toggle").click();
  await expect(page.getByTestId("assets-overlay")).toBeVisible();
  await queueAndWait(page, 0);

  await expect(page.getByTestId("assets-overlay")).toContainText(
    "ComfyUI_00001.png",
    { timeout: 15_000 },
  );
  await page.getByRole("tab", { name: "Outputs" }).click();
  await expect(page.getByTestId("outputs-panel")).toContainText(
    "mounts/output/ComfyUI_00001.png",
  );
  expect(await readdir(resolve(library, "output"))).toContain(
    "ComfyUI_00001.png",
  );
  await page.screenshot({
    path: resolve(evidence, "default-output.png"),
    fullPage: true,
  });

  await page.getByTestId("backends-sidebar-toggle").click();
  const settings = page.getByTestId("output-mount-settings");
  await expect(settings).toBeVisible();
  await settings
    .getByRole("combobox", { name: "Default output mount" })
    .click();
  await page.getByRole("option", { name: "renders" }).click();
  await settings.getByRole("button", { name: "Apply" }).click();
  await expect(settings).toContainText("Saved");
  expect(await readFile(resolve(library, "mounts.toml"), "utf8")).toContain(
    'output-mount = "renders"',
  );
  await page.screenshot({
    path: resolve(evidence, "alternate-output-setting.png"),
    fullPage: true,
  });

  await page.getByTestId("backends-sidebar-toggle").click();
  await queueAndWait(page, 1);
  await page.getByRole("tab", { name: "Outputs" }).click();
  await expect(page.getByTestId("outputs-panel")).toContainText(
    "mounts/renders/ComfyUI_00001.png",
  );
  expect(await readdir(alternateOutput)).toContain("ComfyUI_00001.png");

  await request.put(`${backend}/api/mounts/output`, { data: { id: "output" } });
  await request.delete(`${backend}/api/mounts/renders`);
});

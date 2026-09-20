import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  expect,
  openRailPanel,
  selectProductOption,
  test,
  type Page,
} from "./fixtures.js";

const NATIVE_BACKEND =
  process.env["DINKSTER_NATIVE_BACKEND"] ?? "http://127.0.0.1:8765";
const proofDir = process.env["DINKSTER_TEMPLATE_PROOF_DIR"];
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true });
const EXPECTED_FAMILIES = [
  "dinkster.anima",
  "dinkster.chroma",
  "dinkster.chroma_radiance",
  "dinkster.flux2_dev",
  "dinkster.flux2_klein_4b",
  "dinkster.flux2_klein_9b",
  "dinkster.flux_dev",
  "dinkster.flux_schnell",
  "dinkster.ideogram4",
  "dinkster.krea2",
  "dinkster.ltxav",
  "dinkster.ltxv",
  "dinkster.lumina2",
  "dinkster.minimax_h3",
  "dinkster.minimax_music3",
  "dinkster.qwen_image",
  "dinkster.sd15",
  "dinkster.sdxl",
  "dinkster.sdxl_refiner",
  "dinkster.seedvr2",
  "dinkster.trellis2",
  "dinkster.triposplat",
  "dinkster.wan21",
  "dinkster.wan22",
  "dinkster.z_image",
  "dinkster.z_image_pixel_space",
] as const;

interface TemplateDescriptor {
  readonly pack: string;
  readonly id: string;
  readonly name: string;
  readonly family?: string;
}

async function starterTemplates(): Promise<
  readonly TemplateDescriptor[] | undefined
> {
  try {
    const response = await fetch(`${NATIVE_BACKEND}/api/templates?limit=200`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as {
      templates?: TemplateDescriptor[];
    };
    const families = new Set<string>(EXPECTED_FAMILIES);
    return payload.templates?.filter(
      (template) =>
        template.family !== undefined && families.has(template.family),
    );
  } catch {
    return undefined;
  }
}

async function connect(page: Page): Promise<string> {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined))
    .toBe(true);
  await page.getByTestId("backends-toggle").click();
  await page.getByTestId("backend-url-input").fill(NATIVE_BACKEND);
  await page.getByTestId("backend-add").click();
  await expect(page.getByTestId("tab-target")).toBeVisible();
  await selectProductOption(
    page,
    page.getByTestId("tab-target"),
    NATIVE_BACKEND,
  );
  const owner = await page.evaluate((baseUrl) => {
    const backend = window
      .__dinksterTest!.app.backends.get()
      .find((candidate) => candidate.baseUrl === baseUrl);
    if (backend === undefined)
      throw new Error(`backend ${baseUrl} was not registered`);
    return backend.id;
  }, NATIVE_BACKEND);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window
            .__dinksterTest!.app.backends.get()
            .find((backend) => backend.id === id)
            ?.registry.get() !== undefined,
        owner,
      ),
    )
    .toBe(true);
  await page.evaluate((ownerId) => {
    const app = window.__dinksterTest!.app;
    for (const backend of app.backends.get()) {
      if (backend.id !== ownerId) app.removeBackend(backend.id);
    }
    const ownedProblems = app as unknown as {
      problems: { get(): readonly { owner: unknown; code: string }[] };
      clearProblems(owner: unknown): void;
    };
    for (const problem of ownedProblems.problems.get()) {
      if (
        problem.code === "schema.fetchFailed" ||
        problem.code === "schema.refreshFailed"
      ) {
        ownedProblems.clearProblems(problem.owner);
      }
    }
  }, owner);
  return owner;
}

async function errorProblems(page: Page): Promise<readonly string[]> {
  return page.evaluate(() =>
    window
      .__dinksterTest!.app.problems.get()
      .filter((problem) => problem.severity === "error")
      .map((problem) => `${problem.code}: ${problem.message}`),
  );
}

async function makeModelsAvailable(page: Page): Promise<void> {
  await page.route(`${NATIVE_BACKEND}/api/assets/guess`, async (route) => {
    const request = route.request().postDataJSON() as { names: string[] };
    await route.fulfill({
      json: {
        matches: request.names.map((query) => ({
          query,
          candidates: [
            {
              digest: `blake3:${createHash("sha256").update(query).digest("hex")}`,
              name: query,
              confidence: "path",
              held: true,
              virtualPath: `mounts/models/${query}`,
              size: 1,
              mediaType: "application/octet-stream",
            },
          ],
        })),
      },
    });
  });
}

async function openTemplateGallery(page: Page): Promise<void> {
  await page.getByTestId("topbar-search").click();
  await page
    .getByTestId("universal-search-input")
    .fill("> Open template gallery");
  await page
    .locator('[data-provider="core.commands"]')
    .getByRole("option", { name: "Open template gallery" })
    .click();
}

test("all starter families load through the current wire with zero problem-panel errors", async ({
  page,
}) => {
  const templates = await starterTemplates();
  test.skip(
    templates === undefined,
    `no native Dinkster backend reachable at ${NATIVE_BACKEND}`,
  );
  test.skip(
    templates!.length === 0,
    `native backend at ${NATIVE_BACKEND} has no starter templates`,
  );
  expect(templates!.map((template) => template.family).sort()).toEqual([
    ...EXPECTED_FAMILIES,
  ]);

  const owner = await connect(page);
  await makeModelsAvailable(page);
  await openTemplateGallery(page);
  const gallery = page.getByTestId("template-gallery");
  await expect(gallery).toBeVisible();
  await expect(gallery.locator('[data-family^="dinkster."]')).toHaveCount(
    EXPECTED_FAMILIES.length,
  );
  if (proofDir !== undefined)
    await gallery.screenshot({
      path: join(proofDir, "starter-template-gallery-live.png"),
      animations: "disabled",
    });
  await gallery.getByRole("button", { name: "Close template gallery" }).click();
  await openRailPanel(page, "Problems");
  const panelErrors = page
    .getByTestId("problems-panel")
    .locator('.problem[data-severity="error"]');
  for (const template of templates!) {
    expect(
      await page.evaluate(
        ({ ownerId, row }) =>
          window.__dinksterTest!.app.openTemplate(
            row.pack,
            row.id,
            row.name,
            ownerId,
          ),
        {
          ownerId: owner,
          row: template,
        },
      ),
      template.family,
    ).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__dinksterTest!.app.activeTab()?.store.doc.lineage,
        ),
      )
      .toBe(`starter-${template.id}`);
    expect(await errorProblems(page), template.family).toEqual([]);
    await expect(panelErrors, template.family).toHaveCount(0);
  }
});

test("the all-family problem assertion rejects a malformed starter", async ({
  page,
}) => {
  const templates = await starterTemplates();
  test.skip(
    templates === undefined,
    `no native Dinkster backend reachable at ${NATIVE_BACKEND}`,
  );
  const template = templates?.find(
    (candidate) => candidate.family === "dinkster.sd15",
  );
  test.skip(
    template === undefined,
    `native backend at ${NATIVE_BACKEND} has no SD 1.5 starter`,
  );

  const bodyUrl = `${NATIVE_BACKEND}/api/packs/${encodeURIComponent(template!.pack)}/templates/${encodeURIComponent(template!.id)}`;
  const body = (await (await fetch(bodyUrl)).json()) as {
    graphs: Record<
      string,
      {
        nodes: Record<
          string,
          { type: string; values: Record<string, unknown> }
        >;
      }
    >;
  };
  const graph = Object.values(body.graphs)[0]!;
  const sampler = Object.values(graph.nodes).find(
    (node) => node.type === "dinkster.ksampler",
  );
  expect(sampler).toBeDefined();
  sampler!.values["sampler_name"] = "invalid-sampler";
  await page.route(bodyUrl, (route) => route.fulfill({ json: body }));

  const owner = await connect(page);
  await makeModelsAvailable(page);
  await openRailPanel(page, "Problems");
  await page.evaluate(
    ({ ownerId, row }) =>
      window.__dinksterTest!.app.openTemplate(
        row.pack,
        row.id,
        row.name,
        ownerId,
      ),
    {
      ownerId: owner,
      row: template!,
    },
  );
  await expect(
    page
      .getByTestId("problems-panel")
      .locator('.problem[data-severity="error"]'),
  ).not.toHaveCount(0);
});

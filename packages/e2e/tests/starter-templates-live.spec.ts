import { mkdirSync, writeFileSync } from "node:fs";
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
const EXPECTED_LOOPS = [
  "loop-map-images",
  "loop-gather-image-batch",
  "loop-fold-scan-images",
  "loop-while-until",
  "loop-per-item-image-spawn",
] as const;

interface TemplateDescriptor {
  readonly pack: string;
  readonly id: string;
  readonly name: string;
  readonly family?: string;
}

async function starterTemplates(): Promise<readonly TemplateDescriptor[]> {
  const response = await fetch(`${NATIVE_BACKEND}/api/templates?limit=200`, {
    signal: AbortSignal.timeout(2_000),
  });
  expect(response.ok).toBe(true);
  const payload = (await response.json()) as {
    templates: TemplateDescriptor[];
  };
  expect(payload.templates.map((template) => template.id).sort()).toEqual(
    ["dev-gallery", ...EXPECTED_LOOPS].sort(),
  );
  expect(
    payload.templates.flatMap((template) => template.family ?? []),
  ).toEqual([]);
  const loops = new Set<string>(EXPECTED_LOOPS);
  return payload.templates.filter((template) => loops.has(template.id));
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

async function connectNativeFrontend(page: Page): Promise<string> {
  const frontend = process.env["DINKSTER_E2E_NATIVE_FRONTEND"];
  if (frontend === undefined)
    throw new Error("DINKSTER_E2E_NATIVE_FRONTEND is required");
  await page.goto(frontend);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__dinksterTest?.app.backends
          .get()
          .find((backend) => backend.protocol === "dinkster")
          ?.registry.get(),
      ),
    )
    .toBeDefined();
  return page.evaluate(() => {
    const backend = window
      .__dinksterTest!.app.backends.get()
      .find((candidate) => candidate.protocol === "dinkster");
    if (backend === undefined)
      throw new Error("native backend was not discovered");
    return backend.id;
  });
}

async function errorProblems(page: Page): Promise<readonly string[]> {
  return page.evaluate(() =>
    window
      .__dinksterTest!.app.problems.get()
      .filter((problem) => problem.severity === "error")
      .map((problem) => `${problem.code}: ${problem.message}`),
  );
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

test("all retained loop templates load with zero problem-panel errors", async ({
  page,
}) => {
  const templates = await starterTemplates();
  expect(templates.map((template) => template.id).sort()).toEqual(
    [...EXPECTED_LOOPS].sort(),
  );

  const owner = await connectNativeFrontend(page);
  await openTemplateGallery(page);
  const gallery = page.getByTestId("template-gallery");
  await expect(gallery).toBeVisible();
  for (const template of templates) {
    await expect(
      gallery.getByTestId("template-card").filter({ hasText: template.name }),
    ).toBeVisible();
  }
  await expect(gallery.locator('[data-family^="dinkster."]')).toHaveCount(0);
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
  for (const template of templates) {
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
      template.id,
    ).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() => window.__dinksterTest!.app.activeTab()?.title),
      )
      .toBe(template.name);
    expect(await errorProblems(page), template.id).toEqual([]);
    await expect(panelErrors, template.id).toHaveCount(0);
  }
});

test("the retained while loop starter opens with readable node detail at 1280x800", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const templates = await starterTemplates();
  const template = templates.find(
    (candidate) => candidate.id === "loop-while-until",
  );
  expect(template).toBeDefined();

  const owner = await connectNativeFrontend(page);
  expect(
    await page.evaluate(
      ({ ownerId, row }) =>
        window.__dinksterTest!.app.openTemplate(
          row.pack,
          row.id,
          row.name,
          ownerId,
        ),
      { ownerId: owner, row: template! },
    ),
  ).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        lineage: window.__dinksterTest!.app.activeTab()?.store.doc.lineage,
        detail: window.__dinksterTest!.renderer?.getDetailLevel(),
      })),
    )
    .toMatchObject({
      lineage: template!.id,
      detail: "content",
    });
  await expect
    .poll(() =>
      page.evaluate(() => window.__dinksterTest!.renderer?.getViewport().scale),
    )
    .toBeGreaterThanOrEqual(0.5);
  const screenshot = await page.screenshot({ animations: "disabled" });
  await testInfo.attach("while-loop-starter-opened-1280x800", {
    body: screenshot,
    contentType: "image/png",
  });
  if (proofDir !== undefined)
    writeFileSync(
      join(proofDir, "while-loop-starter-opened-1280x800.png"),
      screenshot,
    );
});

test("the problem assertion rejects a malformed retained loop starter", async ({
  page,
}) => {
  const templates = await starterTemplates();
  const template = templates.find(
    (candidate) => candidate.id === "loop-map-images",
  );
  expect(template).toBeDefined();

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
  const source = body.graphs["root"]!.nodes["source"]!;
  expect(source.type).toBe("dinkster.image.generate");
  source.values["channels"] = "invalid-channels";
  await page.route(bodyUrl, (route) => route.fulfill({ json: body }));

  const owner = await connect(page);
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
  await expect(page.getByTestId("problems-panel")).toContainText(
    "widget.COMBO.unknownOption",
  );
  await expect(page.getByTestId("problems-panel")).toContainText(
    "source.channels: 'invalid-channels' is not in the option list",
  );
});

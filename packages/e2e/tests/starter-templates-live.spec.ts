import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestInfo } from "@playwright/test";
import { requireBackendTemplates } from "./required-nodes.js";
import { expect, openRailPanel, test, waitForStartupOwnership, type Page } from "./fixtures.js";

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
}

async function starterTemplates(
  testInfo: TestInfo,
  required: readonly string[] = EXPECTED_LOOPS,
): Promise<readonly TemplateDescriptor[]> {
  const response = await fetch(`${NATIVE_BACKEND}/api/templates?limit=200`, {
    signal: AbortSignal.timeout(2_000),
  });
  expect(response.ok).toBe(true);
  const payload = (await response.json()) as {
    templates: TemplateDescriptor[];
  };
  requireBackendTemplates(
    payload.templates
      .filter((template) => template.pack === "dinkster-nodes-foundation")
      .map((template) => template.id),
    required,
    testInfo,
  );
  const loops = new Set<string>(EXPECTED_LOOPS);
  return payload.templates.filter((template) => loops.has(template.id));
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
  await waitForStartupOwnership(page);
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
}, testInfo) => {
  const templates = await starterTemplates(testInfo);
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
  const templates = await starterTemplates(testInfo, ["loop-while-until"]);
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

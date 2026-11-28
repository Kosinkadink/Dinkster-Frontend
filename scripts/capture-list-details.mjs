import {
  chromium,
  expect,
} from "../packages/e2e/node_modules/@playwright/test/index.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const [group, destination] = process.argv.slice(2);
if (!["board", "library", "live"].includes(group) || !destination) {
  throw new Error(
    "Usage: node scripts/capture-list-details.mjs board|library|live <new-output-directory>",
  );
}
for (const key of ["DINKSTER_HOME", "XDG_DATA_HOME", "TMPDIR"]) {
  if (!process.env[key])
    throw new Error(`${key} must name a lane-local directory`);
}
if (
  process.env.CUDA_VISIBLE_DEVICES !== "" ||
  process.env.DINKSTER_ACCELERATOR !== "cpu"
) {
  throw new Error(
    "Capture requires CUDA_VISIBLE_DEVICES empty and DINKSTER_ACCELERATOR=cpu",
  );
}
const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const out = resolve(destination) + sep;
mkdirSync(out);
const log = {
  head: git("rev-parse", "HEAD"),
  origin: git("remote", "get-url", "origin"),
  trackedPorcelain: git("status", "--porcelain", "--untracked-files=no"),
  scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  group,
  results: [],
  requests: [],
  errors: [],
  console: [],
  substitutions: [
    "Controlled valid catalog/library/history HTTP routes; inert WebSocket.",
    "Production App, Board workspace, Library adapters and normalized ExecutionStore events through __dinksterTest.",
    "No engine, native generation, CSS overrides or DOM overrides. Fixed browser time and dark settings.",
  ],
};
const browser = await chromium.launch({ args: ["--disable-gpu"] });
const source = readFileSync(
  new URL(
    "../packages/e2e/tests/product-surface-visuals.spec.ts",
    import.meta.url,
  ),
  "utf8",
);
log.visualFixtureSha256 = hash(source);
const body = source
  .split(
    "const emptyVisualBackend = async (route: Route): Promise<void> => {",
  )[1]
  .split("\n}\n")[0];
const empty = new Function("route", `return (async () => {${body}})()`);
const records = (kind) =>
  [1, 2, 3].map((n) => ({
    id: `${kind}-${n}`,
    scope: "local",
    name: `${kind === "workflow" ? "Landscape" : "Composition"} ${n}`,
    digest: "blake3:" + String(n).repeat(64),
    mediaType: "application/vnd.dinkster.workflow+json",
    labels: [kind],
    created: 1795842000,
    modified: 1795842000,
    revision: 1,
    folder: "Evening studies",
  }));
const pack = {
  displayName: "Landscape tools",
  version: "1.2.3",
  publisher: "Studio",
  assets: Array.from({ length: 24 }, (_, i) => ({
    id: `asset-${i}`,
    digest: "blake3:" + "c".repeat(64),
    name: `Landscape reference ${i + 1}`,
    kind: "image",
    size: 2048,
  })),
  blueprints: [1, 2, 3].map((n) => ({
    id: `composition-${n}`,
    name: `Composition ${n}`,
    description: `A landscape composition with lighting and camera controls for study ${n}.`,
    digest: "blake3:" + String(n).repeat(64),
    tags: ["landscape"],
  })),
};
async function boot(width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    timezoneId: "America/Los_Angeles",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => log.errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") log.console.push(m.text());
  });
  page.on("requestfailed", (r) =>
    log.errors.push({ url: r.url(), failure: r.failure() }),
  );
  await page.clock.setFixedTime(new Date("2026-11-28T05:10:00Z"));
  await page.addInitScript(() =>
    localStorage.setItem(
      "dinkster.settings",
      JSON.stringify({
        v: 1,
        values: {
          "dinkster.theme": "dark",
          "features.appView.enabled": true,
          "features.board.enabled": true,
        },
      }),
    ),
  );
  await page.route("**/api/**", async (route) => {
    log.requests.push(route.request().url());
    await empty(route);
  });
  await page.route("**/replacements/index.json", (route) =>
    route.fulfill({ json: { schemaVersion: 1, items: [] } }),
  );
  await page.route("**/memory/**", (route) => route.fulfill({ status: 502 }));
  await page.route("**/supervisor/**", (route) =>
    route.fulfill({ status: 502 }),
  );
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.route("**/api/jobs/*/empty-node-run", (route) =>
    route.fulfill({
      json: {
        jobId: "empty-node-run",
        state: "completed",
        nodeStates: {},
        outputs: {},
        artifacts: [],
      },
    }),
  );
  await page.route("**/api/jobs/*/reported-counts-run", (route) =>
    route.fulfill({
      json: {
        jobId: "reported-counts-run",
        state: "completed",
        outputs: {},
        artifacts: [],
        nodeStates: {
          rendered: { state: "done" },
          reusedA: { state: "cached" },
          reusedB: { state: "cached" },
        },
      },
    }),
  );
  await page.route("**/api/nodes?*", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        epoch: 1,
        dinkster: { version: "visual-fixture", schemaWire: 2 },
        packs: { landscape: pack },
        nodes: {
          "landscape.source": {
            schemaVersion: 2,
            nodeType: "landscape.source",
            displayName: "Landscape source",
            category: "landscape",
            pack: "landscape",
            signature: "source",
            body: [
              {
                kind: "output",
                id: "image",
                type: { kind: "concrete", types: ["comfy.IMAGE"] },
              },
            ],
          },
        },
      },
    }),
  );
  await page.route("**/api/library?*", (route) => {
    const kind = new URL(route.request().url()).searchParams.get("label");
    return route.fulfill({
      json: { records: kind === "blueprint" ? [] : records("workflow") },
    });
  });
  await page.goto(process.env.DINKSTER_CAPTURE_URL ?? "http://127.0.0.1:5277/");
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined);
  await expect(page.getByTestId("status-connection")).toHaveAttribute(
    "data-state",
    "connected",
  );
  const close = page.getByRole("button", {
    name: "Close Templates",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
  return { page, context };
}
async function shot(page, name) {
  await page.mouse.move(850, 850);
  await page.screenshot({ path: out + name + ".png", animations: "disabled" });
}
async function selectSource(page, id) {
  const lib = page.getByTestId("library-overlay");
  const tab = lib.locator(`[data-testid=collection-source][data-source=${id}]`);
  if (await tab.isVisible()) await tab.click();
  else {
    await lib.getByTestId("library-source-select").click();
    await page
      .getByRole("option", {
        name: id === "workflows" ? "Workflows" : "Packs",
        exact: true,
      })
      .click();
  }
}
async function bounds(loc) {
  return loc.evaluate((e) => {
    const b = e.getBoundingClientRect();
    return {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      scrollHeight: e.scrollHeight,
      clientHeight: e.clientHeight,
    };
  });
}
try {
  for (const width of [1440, 900]) {
    const { page, context } = await boot(width);
    try {
      if (group === "board") {
        await page.evaluate(() => {
          const app = window.__dinksterTest.app;
          const entry = app.boards.open(
            {
              format: "dinkster-board",
              formatVersion: 1,
              lineage: "board-correction",
              items: {},
              order: [],
            },
            "Landscape board",
            app.backends.get()[0].baseUrl,
          );
          app.pages.open(`board:${entry.id}`);
        });
        for (const kind of ["Workflow", "Blueprint"]) {
          await page.getByRole("button", { name: "Add", exact: true }).click();
          await page.getByRole("menuitem", { name: kind, exact: true }).click();
          const dialog = page.getByTestId("board-card-picker");
          const rows = dialog.getByTestId("collection-entry");
          await expect(rows).toHaveCount(3);
          const list = dialog.locator(".collection-items");
          const content = dialog.locator(".collection-content");
          const before = {
            list: await bounds(list),
            dialog: await bounds(dialog),
            rows: await rows.evaluateAll((es) =>
              es.map((e) => e.getBoundingClientRect().toJSON()),
            ),
          };
          await shot(page, `chooser-${kind.toLowerCase()}-before-${width}`);
          await rows.first().click();
          const card = dialog.locator(".library-detail-rail");
          await expect(card).toBeVisible();
          await expect(rows.first()).toHaveAttribute("aria-selected", "true");
          const after = {
            list: await bounds(list),
            dialog: await bounds(dialog),
            card: await bounds(card),
            content: await bounds(content),
            text: await card.innerText(),
            selected: await rows.first().getAttribute("aria-selected"),
            marker: await rows.first().innerHTML(),
          };
          log.results.push({
            state: "board-chooser",
            kind,
            width,
            before,
            after,
            listHeightUnchanged:
              Math.abs(before.list.height - after.list.height) < 1,
            dialogGrew: after.dialog.height > before.dialog.height,
            cardBelow: after.card.y >= after.list.y + after.list.height,
            railAtMostHalf: after.card.height <= after.content.height / 2,
            threeRowsVisible: before.rows.every(
              (r) =>
                r.top >= before.list.y &&
                r.bottom <= before.list.y + before.list.height,
            ),
          });
          await shot(page, `chooser-${kind.toLowerCase()}-after-${width}`);
          await page.keyboard.press("Escape");
        }
      } else {
        if (group === "library") {
          await page.getByTestId("library-toggle").click();
          await selectSource(page, "workflows");
          const lib = page.getByTestId("library-overlay");
          await lib.getByTestId("collection-entry").first().click();
          const rail = lib.getByTestId("library-detail-rail");
          const text = await rail.innerText();
          const labels = await rail.locator("dt").allTextContents();
          log.results.push({
            state: "saved-workflow",
            width,
            text,
            labels,
            modifiedOnce: (text.match(/Modified/g) ?? []).length === 1,
            noModifiedFact: !labels.some((t) => /modified/i.test(t)),
          });
          await shot(page, `workflow-selected-${width}`);
          await selectSource(page, "packs");
          await lib.getByTestId("collection-entry").first().click();
          await expect(rail.locator(".library-detail-header")).toBeVisible();
          const header = rail.locator(".library-detail-header");
          const before = await bounds(header);
          await shot(page, `pack-header-before-${width}`);
          await rail.hover();
          await page.mouse.wheel(0, 1000);
          await expect
            .poll(() => rail.evaluate((e) => e.scrollTop))
            .toBeGreaterThan(0);
          const after = await bounds(header);
          const scroll = await rail.evaluate((e) => ({
            scrollTop: e.scrollTop,
            scrollHeight: e.scrollHeight,
            clientHeight: e.clientHeight,
          }));
          await header.getByRole("button").click();
          await expect(
            page.getByRole("menuitem", { name: "Copy details", exact: true }),
          ).toBeVisible();
          await shot(page, `pack-header-scrolled-${width}`);
          await page
            .getByRole("menuitem", { name: "Copy details", exact: true })
            .click();
          await expect(page.getByRole("menu")).toHaveCount(0);
          log.results.push({
            state: "pack-scroll",
            width,
            before,
            after,
            scroll,
            headerFixed: Math.abs(before.y - after.y) < 1,
            menuOperable: true,
          });
          await page.getByTestId("library-toggle").click();
        } else {
          await page.evaluate(() => {
            const app = window.__dinksterTest.app;
            const tab = app.activeTab();
            const backend = app.backendForTab(tab);
            const execution = {
              connection: backend.id,
              prompt: "empty-node-run",
            };
            const artifact = {
              snapshot: structuredClone(tab.store.doc),
              revision: 0,
              semanticHash: "correction-fixture",
              scope: { kind: "full" },
              connection: backend.id,
              schemaHash: "correction-fixture",
              prompt: {},
              provenance: { toSource: {}, fromSource: {} },
              diagnostics: [],
            };
            app.store.register(execution, artifact, 1795842000000, {
              workflowName: "Landscape study",
            });
            app.store.apply({
              kind: "started",
              execution,
              timestamp: 1795842002000,
            });
            app.store.apply({
              kind: "completed",
              execution,
              timestamp: 1795842014500,
            });
          });
          const right = page.getByTestId("dock-zone-right");
          if (!(await right.isVisible()))
            await page.getByTestId("rail-toggle").click();
          const runs = right.getByRole("tab", { name: "Runs", exact: true });
          if (await runs.isVisible()) await runs.click();
          else {
            await right.getByTestId("dock-zone-overflow-button").click();
            await page
              .getByRole("menuitemradio")
              .filter({ hasText: "Runs" })
              .first()
              .click();
          }
          const row = page.getByTestId("execution-row").first();
          await row.locator(".run-row-name").click();
          await row.getByRole("button", { name: /^More for / }).click();
          await page
            .getByRole("menuitem", { name: "Details", exact: true })
            .click();
          const facts = row.getByTestId("chosen-run-details");
          const dt = await facts.locator("dt").allTextContents();
          log.results.push({
            state: "live-empty-nodes",
            width,
            labels: dt,
            facts: await facts.innerText(),
            geometry: await bounds(facts),
            meetsRequestedNoNodes: !dt.includes("Nodes"),
            hasExpectedFacts: dt.join(",") === "State,Started,Took",
            store: await page.evaluate(() =>
              [
                ...window.__dinksterTest.app.store.executions.get().values(),
              ].map((e) => ({ status: e.status, nodes: e.nodes })),
            ),
          });
          await shot(page, `live-empty-nodes-${width}`);
          await page.evaluate(() => {
            const app = window.__dinksterTest.app;
            const empty = [...app.store.executions.get().values()].find(
              (entry) => entry.ref.prompt === "empty-node-run",
            );
            const execution = { ...empty.ref, prompt: "reported-counts-run" };
            app.store.register(execution, empty.artifact, 1795842100000, {
              workflowName: "Landscape reported counts",
            });
            app.store.apply({
              kind: "started",
              execution,
              timestamp: 1795842102000,
            });
            app.store.apply({
              kind: "nodeStates",
              execution,
              timestamp: 1795842110000,
              nodes: {
                rendered: { state: "done" },
                reusedA: { state: "cached" },
                reusedB: { state: "cached" },
              },
            });
            app.store.apply({
              kind: "completed",
              execution,
              timestamp: 1795842114500,
            });
          });
          const reported = page
            .getByTestId("execution-row")
            .filter({ hasText: "Landscape reported counts" });
          await reported.locator(".run-row-name").click();
          await reported.getByRole("button", { name: /^More for / }).click();
          await page
            .getByRole("menuitem", { name: "Details", exact: true })
            .click();
          const reportedFacts = reported.getByTestId("chosen-run-details");
          const reportedText = await reportedFacts.innerText();
          log.results.push({
            state: "live-reported-counts",
            width,
            facts: reportedText,
            geometry: await bounds(reportedFacts),
            asymmetricCounts: reportedText.includes(
              "1 nodes ran, 2 from cache",
            ),
            store: await page.evaluate(() =>
              [
                ...window.__dinksterTest.app.store.executions.get().values(),
              ].map((entry) => ({
                prompt: entry.ref.prompt,
                status: entry.status,
                nodes: entry.nodes,
              })),
            ),
          });
          await shot(page, `live-reported-counts-${width}`);
        }
      }
    } catch (e) {
      log.results.push({ width, failure: String(e) });
      await shot(page, `failure-${width}`);
    }
    await context.close();
  }
} finally {
  writeFileSync(out + "raw.json", JSON.stringify(log, null, 2));
  await browser.close();
}
const failed = log.results.some(
  (result) => result.failure || Object.values(result).includes(false),
);
if (failed || log.errors.some((error) => typeof error === "string"))
  process.exitCode = 1;

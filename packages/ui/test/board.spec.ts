import { expect, test } from "@playwright/test";

test.use({ hasTouch: true });

test("card controls edit without dragging, menus dismiss, and removal is undoable", async ({
  page,
}) => {
  await page.goto("/#board-cards");
  const card = page.locator('[data-board-item="workflow-1"]');
  const blueprint = page.locator('[data-board-item="blueprint-1"]');
  const original = (await card.boundingBox())!;
  await card
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill("Morning light");
  await card.getByRole("textbox", { name: "Prompt", exact: true }).press("Tab");
  await expect(
    card.getByRole("textbox", { name: "Prompt", exact: true }),
  ).toHaveValue("Morning light");
  await expect(
    blueprint.getByRole("textbox", { name: "Motion", exact: true }),
  ).toHaveValue("Slow push in");
  await blueprint
    .getByRole("button", { name: "Actions for Image to video" })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Choose inputs", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Open workflow", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Remove from board", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await card.getByRole("button", { name: "Run", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await expect(card.getByRole("status")).toHaveText("Running");
  expect((await card.boundingBox())!.x).toBeCloseTo(original.x);
  expect((await card.boundingBox())!.y).toBeCloseTo(original.y);
  await card.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Run", exact: true }),
  ).toBeVisible();
  const actions = card.getByRole("button", {
    name: "Actions for Diner establishing shot",
  });
  await actions.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Card actions" })).toHaveCount(0);
  await actions.click();
  await page
    .getByRole("menuitem", { name: "Choose inputs", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Choose inputs:" }),
  ).toHaveText("Choose inputs: Diner establishing shot");
  await actions.click();
  const remove = page.getByRole("menuitem", {
    name: "Remove from board",
    exact: true,
  });
  const colors = await remove.evaluate((element) => {
    const probe = document.createElement("span");
    element.append(probe);
    probe.style.color = "var(--dinkster-text-primary)";
    const neutral = getComputedStyle(probe).color;
    probe.style.color = "var(--dinkster-danger-foreground)";
    const danger = getComputedStyle(probe).color;
    probe.remove();
    return { neutral, danger };
  });
  await expect(remove).toHaveCSS("color", colors.neutral);
  await remove.hover();
  await expect(remove).toHaveCSS("color", colors.danger);
  await page.mouse.move(0, 0);
  await page.keyboard.press("End");
  await expect(remove).toBeFocused();
  await expect(remove).toHaveCSS("color", colors.danger);
  await remove.press("Enter");
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    card.getByRole("textbox", { name: "Prompt", exact: true }),
  ).toHaveValue("Morning light");
  const add = page.getByRole("button", { name: "Add", exact: true });
  await add.click();
  await expect(
    page.getByRole("menuitem", { name: "Blueprint", exact: true }),
  ).toBeVisible();
  await page.getByRole("heading", { name: "Board cards", level: 2 }).click();
  await expect(
    page.getByRole("menu", { name: "Add", exact: true }),
  ).toHaveCount(0);
  await add.click();
  await page.getByRole("menuitem", { name: "Workflow", exact: true }).click();
  const placed = page.locator('[data-board-item][data-kind="workflow"]').last();
  await expect(placed).toHaveAttribute("data-selected", "true");
  await expect(
    page.getByRole("menu", { name: "Add", exact: true }),
  ).toHaveCount(0);
  await page.goto("/#board");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Blueprint", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Workflow", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Media", exact: true }).click();
  await expect(page.locator('[data-kind="picture"]')).toHaveCount(4);
});

test("pictures move and resize without changing their shape, and edits undo and redo", async ({
  page,
}) => {
  await page.goto("/#board");
  const picture = page.locator('[data-board-item="picture-1"]');
  const before = (await picture.boundingBox())!;
  await page.mouse.move(before.x + 100, before.y + 100);
  await page.mouse.down();
  await page.mouse.move(before.x + 180, before.y + 130);
  await page.mouse.up();
  expect((await picture.boundingBox())!.x).toBeCloseTo(before.x + 80);
  expect((await picture.boundingBox())!.y).toBeCloseTo(before.y + 30);
  const handle = picture.getByRole("separator", { name: "Resize item" });
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(picture).toHaveCSS("width", "320px");
  await expect(picture.locator(".dinkster-board-caption")).toHaveText(
    "Diner at night800 x 500",
  );
  const resized = (await picture.boundingBox())!;
  expect(resized.width / resized.height).toBeCloseTo(800 / 500, 2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(picture).toHaveCSS("width", "310px");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await picture.boundingBox())!.x).toBeCloseTo(before.x);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect((await picture.boundingBox())!.x).toBeCloseTo(before.x + 80);
  await picture.click();
  await page.keyboard.press("Delete");
  await expect(picture).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(picture).toBeVisible();
  await picture.click();
  const anchored = (await picture.boundingBox())!;
  await picture.getByRole("separator", { name: "Resize top left" }).focus();
  await page.keyboard.press("ArrowLeft");
  const expanded = (await picture.boundingBox())!;
  expect(expanded.width).toBeCloseTo(anchored.width + 10);
  expect(expanded.x + expanded.width).toBeCloseTo(anchored.x + anchored.width);
  expect(expanded.y + expanded.height).toBeCloseTo(
    anchored.y + anchored.height,
  );
});

test("moving a section moves its contents, notes edit, and a new note is undoable", async ({
  page,
}) => {
  await page.goto("/#board");
  const section = page.locator('[data-board-item="section-1"]');
  const bounds = (await section.boundingBox())!;
  const picture = page.locator('[data-board-item="picture-1"]');
  const outside = page.locator('[data-board-item="picture-3"]');
  const pictureBefore = (await picture.boundingBox())!;
  const outsideBefore = (await outside.boundingBox())!;
  await page.mouse.move(bounds.x + 650, bounds.y + 330);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 690, bounds.y + 350);
  await page.mouse.up();
  expect((await section.boundingBox())!.x).toBeCloseTo(bounds.x + 40);
  expect((await picture.boundingBox())!.x).toBeCloseTo(pictureBefore.x + 40);
  expect((await outside.boundingBox())!.x).toBeCloseTo(outsideBefore.x);
  const memberBeforeResize = (await picture.boundingBox())!;
  const topLeft = (await section
    .getByRole("separator", { name: "Resize top left" })
    .boundingBox())!;
  await page.mouse.move(topLeft.x + 4, topLeft.y + 4);
  await page.mouse.down();
  await page.mouse.move(topLeft.x - 16, topLeft.y - 16);
  expect((await picture.boundingBox())!.x).toBeCloseTo(memberBeforeResize.x);
  await page.mouse.up();
  expect((await picture.boundingBox())!.y).toBeCloseTo(memberBeforeResize.y);
  await expect(section.getByRole("textbox")).toHaveCount(0);
  await section.locator(".dinkster-board-section-name").dblclick();
  const name = section.getByRole("textbox", { name: "Section name" });
  await name.fill("Rain and light");
  await name.press("Enter");
  await expect(section.getByRole("textbox")).toHaveCount(0);
  await expect(section.locator(".dinkster-board-section-name")).toHaveText(
    "Rain and light",
  );
  await page.keyboard.press("Enter");
  await name.fill("Discard this name");
  await name.press("Escape");
  await expect(section.locator(".dinkster-board-section-name")).toHaveText(
    "Rain and light",
  );
  await expect(section).toHaveAttribute("data-selected", "false");
  await expect(section.locator(".dinkster-board-caption")).toHaveCount(0);
  const noteItem = page.locator('[data-board-item="note-1"]');
  await noteItem.click();
  await expect(page.locator(".dinkster-board")).toHaveCSS(
    "outline-style",
    "none",
  );
  await expect(noteItem.getByRole("textbox")).toHaveCount(0);
  const text = await noteItem
    .locator(".dinkster-board-note-text")
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        font: getComputedStyle(element).font,
      };
    });
  await page.keyboard.press("Enter");
  const note = page.getByRole("textbox", { name: "Note text" });
  const editor = await note.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      font: getComputedStyle(element).font,
    };
  });
  expect(editor).toEqual(text);
  await expect(note).toHaveCSS("padding", "0px");
  await expect(note).toHaveCSS("outline-style", "none");
  await expect(note).toHaveCSS("resize", "none");
  await expect(noteItem.getByRole("separator")).toHaveCount(4);
  await note.fill("Keep the reflections, not the camera angle.");
  await note.press("Tab");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(noteItem).toContainText("Reference for the light");
  await noteItem.click();
  await expect(page.locator('[data-board-item="note-1"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
  await noteItem.dblclick();
  await expect(note).toBeFocused();
  const empty = (await page.locator(".dinkster-board").boundingBox())!;
  await page.mouse.click(empty.x + empty.width - 30, empty.y + 300);
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
  await expect(
    page.locator('[data-board-item="note-1"] .dinkster-board-caption'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  const board = (await page.locator(".dinkster-board").boundingBox())!;
  await page.mouse.click(board.x + board.width - 60, board.y + 640);
  await expect(page.locator('[data-kind="note"]')).toHaveCount(2);
  const placed = page.locator('[data-kind="note"]').last();
  await expect(note).toBeFocused();
  await expect(note).toHaveValue("");
  await page.keyboard.type("Checked from X570");
  await note.press("Tab");
  await expect(placed.locator(".dinkster-board-note-text")).toHaveText(
    "Checked from X570",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(placed.locator(".dinkster-board-note-text")).toHaveText("");
  await expect(page.locator('[data-kind="note"]')).toHaveCount(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator('[data-kind="note"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(placed.locator(".dinkster-board-note-text")).toHaveText("");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(placed.locator(".dinkster-board-note-text")).toHaveText(
    "Checked from X570",
  );
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  const emptyBoard = (await page.locator(".dinkster-board").boundingBox())!;
  await page.mouse.click(
    emptyBoard.x + emptyBoard.width - 60,
    emptyBoard.y + 400,
  );
  await expect(note).toBeFocused();
  await expect(note).toHaveValue("");
  await note.press("Tab");
  const emptyNote = page.locator('[data-kind="note"]').last();
  await expect(emptyNote).toBeVisible();
  await expect(emptyNote.locator(".dinkster-board-note-text")).toHaveText("");
  await emptyNote.dblclick();
  await expect(note).toHaveValue("");
  await note.press("Tab");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator('[data-kind="note"]')).toHaveCount(2);
});

test("sound and video play in place, and media can move, resize and undo removal", async ({
  page,
}) => {
  await page.goto("/#board");
  const sound = page.locator('[data-board-item="sound-1"]');
  await expect(
    sound
      .getByRole("slider", { name: "Waveform of Reference chimes" })
      .locator("path")
      .first(),
  ).not.toHaveAttribute("d", "");
  await expect(sound).toContainText("0:04");
  for (const [id, name] of [
    ["sound-1", "Reference chimes"],
    ["video-1", "Rain on the window"],
  ]) {
    const item = page.locator(`[data-board-item="${id}"]`);
    await item.scrollIntoViewIfNeeded();
    const before = (await item.boundingBox())!;
    await item
      .getByRole("button", { name: `Play ${name}`, exact: true })
      .click();
    await expect
      .poll(() =>
        item
          .locator("audio, video")
          .evaluate((element) => (element as HTMLMediaElement).currentTime),
      )
      .toBeGreaterThan(1);
    await item
      .getByRole("button", { name: `Pause ${name}`, exact: true })
      .click();
    const elapsed = await item
      .locator("audio, video")
      .evaluate((element) => (element as HTMLMediaElement).currentTime);
    const duration = await item
      .locator("audio, video")
      .evaluate((element) => (element as HTMLMediaElement).duration);
    const progress = item.getByRole("slider", {
      name: id === "sound-1" ? `Waveform of ${name}` : `Seek ${name}`,
    });
    await expect(progress).toHaveAttribute("aria-valuenow", String(elapsed));
    await expect(item.locator(".dinkster-board-media-control")).toContainText(
      `0:${Math.floor(elapsed).toString().padStart(2, "0")} / 0:04`,
    );
    await page.waitForTimeout(300);
    await expect(progress).toHaveAttribute("aria-valuenow", String(elapsed));
    const track = (await progress.boundingBox())!;
    await page.mouse.click(
      track.x + track.width * 0.25,
      track.y + track.height / 2,
    );
    await expect
      .poll(() =>
        item
          .locator("audio, video")
          .evaluate((element) => (element as HTMLMediaElement).currentTime),
      )
      .toBeCloseTo(duration * 0.25, 1);
    await expect(progress).toHaveCSS("outline-style", "none");
    await progress.press("ArrowRight");
    await expect(progress).toHaveCSS("outline-style", "solid");
    await page.mouse.move(
      track.x + track.width * 0.25,
      track.y + track.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      track.x + track.width * 0.75,
      track.y + track.height / 2,
    );
    await page.mouse.up();
    await expect
      .poll(() =>
        item
          .locator("audio, video")
          .evaluate((element) => (element as HTMLMediaElement).currentTime),
      )
      .toBeCloseTo(duration * 0.75, 1);
    expect((await item.boundingBox())!.x).toBeCloseTo(before.x);
    const dragY =
      id === "sound-1" ? before.y + before.height - 8 : before.y + 20;
    await page.mouse.move(before.x + 20, dragY);
    await page.mouse.down();
    await page.mouse.move(before.x + 60, dragY + 20);
    await page.mouse.up();
    expect((await item.boundingBox())!.x).toBeCloseTo(before.x + 40);
    await item.getByRole("separator", { name: "Resize item" }).focus();
    await page.keyboard.press("ArrowRight");
    expect((await item.boundingBox())!.width).toBeCloseTo(before.width + 10);
    await page.keyboard.press("Delete");
    await expect(item).toHaveCount(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(item).toBeVisible();
  }
});

test("moving a section keeps outside media loaded and above it", async ({
  page,
}) => {
  await page.goto("/#board");
  const video = page.locator('[data-board-item="video-1"]');
  const sound = page.locator('[data-board-item="sound-1"]');
  const waveform = sound.getByRole("slider").locator("path").first();
  await expect(waveform).not.toHaveAttribute("d", "");
  await video
    .getByRole("button", { name: "Play Rain on the window", exact: true })
    .click();
  await expect
    .poll(() =>
      video
        .locator("video")
        .evaluate((media: HTMLVideoElement) => media.currentTime),
    )
    .toBeGreaterThan(1);
  await video
    .getByRole("button", { name: "Pause Rain on the window", exact: true })
    .click();
  const elapsed = await video
    .locator("video")
    .evaluate((media: HTMLVideoElement) => media.currentTime);
  const section = page.locator('[data-board-item="section-1"]');
  const bounds = (await section.boundingBox())!;
  await page.mouse.move(bounds.x + 650, bounds.y + 330);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 680, bounds.y + 650);
  await page.mouse.up();
  expect(
    await video
      .locator("video")
      .evaluate((media: HTMLVideoElement) => media.currentTime),
  ).toBe(elapsed);
  await expect(waveform).not.toHaveAttribute("d", "");
  await expect(sound).toContainText("0:04");
  await expect(page.locator(".dinkster-board")).toHaveCSS(
    "outline-style",
    "none",
  );
  for (const item of [video, sound]) {
    await item.scrollIntoViewIfNeeded();
    const box = (await item.boundingBox())!;
    expect(
      await item.evaluate(
        (element, point) =>
          element.contains(document.elementFromPoint(point.x, point.y)),
        { x: box.x + 100, y: box.y + 20 },
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".dinkster-board")).toBeFocused();
  await expect(page.locator(".dinkster-board")).toHaveCSS(
    "outline-style",
    "solid",
  );
});

test("two fingers pan and zoom the board without moving its items", async ({
  page,
  context,
}) => {
  await page.goto("/#board");
  const picture = page.locator('[data-board-item="picture-1"]');
  const before = (await picture.boundingBox())!;
  const board = (await page.locator(".dinkster-board").boundingBox())!;
  const session = await context.newCDPSession(page);
  const x = board.x + board.width - 180;
  const y = board.y + 200;
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x, y, id: 1 },
      { x: x + 80, y, id: 2 },
    ],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: x + 20, y: y + 30, id: 1 },
      { x: x + 180, y: y + 30, id: 2 },
    ],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const after = (await picture.boundingBox())!;
  expect(after.width).toBeCloseTo(before.width * 2);
  expect(after.x).toBeCloseTo((before.x - (x + 40)) * 2 + x + 100);
  await page.getByTestId("canvas-fit-view").click();
  await expect(picture).toBeVisible();
  expect((await picture.boundingBox())!.width).toBeLessThanOrEqual(
    before.width,
  );
  await expect(page.getByTestId("minimap-toggle")).toHaveCount(0);
  await page.getByTestId("canvas-zoom-level").click();
  await page.getByTestId("canvas-zoom-reset").click();
  await expect(page.getByTestId("canvas-zoom-level")).toHaveText("100%");
  await expect(page.getByTestId("canvas-zoom-menu")).toHaveCount(0);
});

test("unreadable audio shows its name and reason without waveform or playback", async ({
  page,
}) => {
  await page.route("**/board/chimes.wav", (route) =>
    route.fulfill({ contentType: "audio/wav", body: "not audio" }),
  );
  await page.goto("/#board");
  const sound = page.locator('[data-board-item="sound-1"]');
  await expect(sound.getByRole("status")).toHaveText(
    "Reference chimesThis sound cannot be read",
  );
  await expect(sound.getByRole("img")).toHaveCount(0);
  await expect(sound.getByRole("button")).toHaveCount(0);
  await expect(sound.getByRole("progressbar")).toHaveCount(0);
  await expect(sound).not.toContainText("--:--");
});

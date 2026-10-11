import { expect, test, type Page } from "@playwright/test";

// Mocked IPC fixture (tests/browser/session-fork-sidechat.tsx): the real
// SessionPane, fork operation and session sanitizer over a scripted provider.
// Real provider inheritance and the real App are verified separately.

type Fixture = {
  submitted: { sessionId: string; text: string }[];
  forkCalls: { sourceProviderSessionId: string; turnIds: (string | undefined)[] }[];
  nativeError?: string;
  cancelError?: string;
  unbound?: boolean;
  showRight(sessionId: string): void;
  draft(): { mcp: string[]; references: string[] };
  setBusy(busy: boolean): void;
  startCancelableTurn(sessionId: string): void;
  failCancelableTurn(sessionId: string): void;
  lateCancelledEvents(sessionId: string): void;
  btwRun(): void;
  btwPartial(text: string): void;
  btwAnswer(text: string): void;
  sessions(): { id: string; title: string; busy?: boolean; providerSessionId?: string; blocks: { text: string; role?: string; turnOutcome?: string; tool?: { status?: string } }[] }[];
  reset(): void;
};
const call = <T,>(page: Page, run: (fixture: Fixture) => T) =>
  page.evaluate(
    (source) => new Function("fixture", `return (${source})(fixture)`)((window as unknown as { fixture: Fixture }).fixture),
    run.toString(),
  ) as Promise<T>;

const SOURCE_ID = "5f0c2a9e-7d41-4b8e-9a63-2c1d0e8f4b17";
const left = (page: Page) => page.getByTestId("pane-left");
const right = (page: Page) => page.getByTestId("pane-right");
const forkButton = (page: Page, pane: "left" | "right", index: number) =>
  page.getByTestId(`pane-${pane}`).getByRole("button", { name: "Fork from this turn" }).nth(index);
const sideButton = (page: Page, index: number) =>
  left(page).getByRole("button", { name: "Side question about this turn" }).nth(index);
const menu = (page: Page) => page.locator("[data-fork-menu]");
const sheet = (page: Page) => page.getByRole("dialog", { name: "By-the-way conversations" });
const focusedStrategy = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-fork-strategy"));

test.beforeEach(async ({ page }) => {
  // Vite can optimize newly encountered fixture imports and reload this page.
  // Let that navigation settle before accessing the fixture's execution context.
  await page.goto("/tests/browser/session-fork-sidechat.html", { waitUntil: "networkidle" });
  await call(page, (fixture) => fixture.reset());
  await page.reload({ waitUntil: "networkidle" });
  await expect(left(page).getByText("Noted AFTER_OMEGA_8256.")).toBeVisible();
});

test("keyboard Fork of turn 1 opens a native child beside the source, through that turn only", async ({ page }) => {
  await forkButton(page, "left", 0).focus();
  await page.keyboard.press("Enter");
  await expect(menu(page)).toContainText("Fork from Turn 1 · Remember BEFORE_ALPHA_7491 for later.");
  await expect(menu(page)).toContainText("Includes this turn. Later messages stay out.");
  await expect(menu(page)).toContainText("Uses the current checkout /work/monocode");
  await expect.poll(() => focusedStrategy(page)).toBe("native");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focusedStrategy(page)).toBe("visible-history");
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(forkButton(page, "left", 0)).toBeFocused();

  await page.keyboard.press("Enter");
  await expect.poll(() => focusedStrategy(page)).toBe("native");
  await page.keyboard.press("Enter");
  await expect(menu(page).locator('[data-fork-strategy="native"]')).toContainText("Forking…");
  await expect(menu(page)).toHaveCount(0);

  await expect(right(page)).not.toHaveAttribute("data-session", "other");
  const child = right(page);
  await expect(child.getByText("Noted BEFORE_ALPHA_7491.")).toBeVisible();
  await expect(child.getByText("AFTER_OMEGA_8256")).toHaveCount(0);
  const origin = child.locator('[data-fork-origin="native"]');
  await expect(origin).toContainText("Forked from Cache rollout plan · through Turn 1 · Remember BEFORE_ALPHA_7491 for later.");
  await expect(origin).toContainText("Codex kept its native context through this turn.");
  await expect(origin).toContainText("Files were not rolled back");
  // The card replaces the fork's plain note rather than repeating it.
  await expect(child.getByText(/Fork：native/)).toHaveCount(0);
  // Readable labels lead; the source ID is only a tooltip.
  await expect(origin).not.toContainText(SOURCE_ID);
  await expect(origin).toHaveAttribute("title", `Source session ${SOURCE_ID}`);
  expect(await call(page, (fixture) => fixture.forkCalls)).toEqual([
    { sourceProviderSessionId: "thread-source", turnIds: ["native-t1"] },
  ]);

  // The inherited plan keeps its status and cannot be built again.
  const build = child.getByRole("button", { name: /Historical plan · not built/ });
  await expect(build).toBeDisabled();
  await expect(build).toHaveAttribute("title", /can’t be built again here/);

  // The source is untouched and nothing was sent to it.
  await expect(left(page).getByText("Noted AFTER_OMEGA_8256.")).toBeVisible();
  expect(await call(page, (fixture) => fixture.submitted)).toEqual([]);
});

for (const ending of ["stop", "error"] as const) {
  test(`Fork child ${ending} keeps partial output, settles tools and rejects an unfinished boundary`, async ({ page }) => {
    const sourceBefore = await call(page, (fixture) => JSON.stringify(fixture.sessions()[0].blocks));
    await forkButton(page, "left", 0).click();
    await menu(page).locator('[data-fork-strategy="native"]').click();
    await expect(menu(page)).toHaveCount(0);
    const childId = await right(page).getAttribute("data-session");
    await call(page, (fixture) => fixture.startCancelableTurn(fixture.sessions().at(-1)!.id));
    await expect(right(page).getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(right(page).getByText("PARTIAL-KEEP", { exact: true })).toBeVisible();
    if (ending === "stop") {
      await right(page).getByRole("button", { name: "Stop", exact: true }).click();
    } else {
      await call(page, (fixture) => fixture.failCancelableTurn(fixture.sessions().at(-1)!.id));
    }
    const label = ending === "stop" ? "Stopped" : "Failed";
    await expect(right(page).locator(`[data-turn-actions][aria-label="${label}"]`)).toBeVisible();
    await right(page).getByRole("textbox").last().fill("Keep the next draft unsent.");
    await expect(right(page).getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(right(page).getByRole("textbox").last()).toHaveValue("Keep the next draft unsent.");
    await call(page, (fixture) => fixture.lateCancelledEvents(fixture.sessions().at(-1)!.id));
    await expect(right(page).getByText("PARTIAL-KEEP", { exact: true })).toBeVisible();
    await expect(right(page).getByText("LATE-WRONG", { exact: true })).toHaveCount(0);
    const child = (await call(page, (fixture) => fixture.sessions())).find((session) => session.id === childId)!;
    expect(child.busy).toBe(false);
    expect(child.blocks.find((block) => block.text === "Cancelable child sleep")?.turnOutcome).toBe(ending === "stop" ? "cancelled" : "error");
    expect(child.blocks.filter((block) => block.tool).map((block) => block.tool?.status)).toEqual([ending === "stop" ? "cancelled" : "failed"]);
    expect(await call(page, (fixture) => JSON.stringify(fixture.sessions()[0].blocks))).toBe(sourceBefore);
    expect(await call(page, (fixture) => fixture.submitted)).toEqual([]);
    const side = right(page).getByRole("button", { name: "Side question about this turn" });
    await expect(side.last()).toHaveAttribute("aria-disabled", "true");
    await expect(side.last()).toHaveAttribute("title", "This turn hasn’t finished yet.");
    await expect(side.first()).toHaveAttribute("aria-disabled", "false");
    await forkButton(page, "right", 1).click();
    await expect(menu(page)).toContainText("尚未完成");
    await expect(menu(page).locator('[data-fork-strategy="native"]')).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
  });
}

test("a native refusal stays on screen; another way is the user's explicit choice", async ({ page }) => {
  await call(page, (fixture) => {
    fixture.nativeError = "存在当前或已保存 native goal，无法证明其属于所选截止点";
  });
  await forkButton(page, "left", 1).click();
  await menu(page).locator('[data-fork-strategy="native"]').click();
  await expect(menu(page).getByRole("alert")).toContainText("存在当前或已保存 native goal，无法证明其属于所选截止点");
  await expect(menu(page).getByRole("alert")).toContainText("Nothing was sent to this session.");
  await expect(right(page)).toHaveAttribute("data-session", "other");

  await menu(page).locator('[data-fork-strategy="visible-history"]').click();
  await expect(right(page)).not.toHaveAttribute("data-session", "other");
  const origin = right(page).locator('[data-fork-origin="visible-history"]');
  await expect(origin).toContainText("through Turn 2 · Now also remember AFTER_OMEGA_8256.");
  await expect(origin).toContainText("Rebuilt from the visible transcript. The model did not inherit hidden provider state.");
  await expect(origin).toContainText("Visible text complete");
  await expect(right(page).getByText(/Fork：visible-history/)).toHaveCount(0);
});

test("a provider without exact native Fork says why, and focus starts on a way that works", async ({ page }) => {
  await forkButton(page, "right", 0).focus();
  await page.keyboard.press("Enter");
  const native = menu(page).locator('[data-fork-strategy="native"]');
  await expect(native).toHaveAttribute("aria-disabled", "true");
  await expect(native).toContainText("该会话没有可用的精确 native Fork");
  await expect.poll(() => focusedStrategy(page)).toBe("visible-history");
  await native.dispatchEvent("click");
  await page.waitForTimeout(300);
  await expect(right(page)).toHaveAttribute("data-session", "other");
});

test("while the session runs, a side question starts from the latest finished turn; stop is its own", async ({ page }) => {
  await call(page, (fixture) => fixture.setBusy(true));
  await expect(left(page).getByText("Keep working on the rollout.")).toBeVisible();

  // Exercise the live click guard even though the unavailable action is marked.
  await sideButton(page, 0).click({ force: true });
  await expect(sideButton(page, 0)).toHaveAttribute("aria-disabled", "true");
  await expect(sideButton(page, 0)).toHaveAttribute("title", /latest finished turn/);
  await expect(sheet(page)).toHaveCount(0);

  await sideButton(page, 1).click();
  const scope = sheet(page).locator("[data-btw-scope]");
  await expect(scope).toContainText("As of Turn 2 · Now also remember AFTER_OMEGA_8256. (inclusive)");
  await expect(scope).toContainText("Read-only");
  await expect(scope).toContainText("Later messages stay out. Excerpts, plus read-only lookups");
  const question = sheet(page).getByRole("textbox", { name: "By-the-way question" });
  await expect(question).toBeFocused();
  await question.fill("Which value came last?");
  await page.keyboard.press("Enter");
  await expect(scope.locator("[data-btw-status]")).toHaveText("Waiting in queue");

  await call(page, (fixture) => {
    fixture.cancelError = "native 中断未确认：interrupt 超时";
  });
  await sheet(page).getByRole("button", { name: /stop/i }).click();
  await expect(scope.locator("[data-btw-status]")).toHaveText("Stopped");
  await expect(sheet(page).getByRole("status")).toContainText("You stopped this request.");
  await expect(sheet(page).getByRole("status")).toContainText("native 中断未确认：interrupt 超时");
  // Stopped while queued: the turn reads as stopped, not as timed, finished work.
  const footer = sheet(page).locator("[data-turn-actions]").last();
  await expect(footer).toHaveAttribute("aria-label", "Stopped");
  await expect(footer.locator(":scope > span").first().locator("svg")).toHaveCount(0);
  await expect(sheet(page).getByText(/worked for/)).toHaveCount(0);
  // Stopping the side request left the main turn running.
  expect(await call(page, (fixture) => fixture.sessions().find((session) => session.id === "5f0c2a9e-7d41-4b8e-9a63-2c1d0e8f4b17")?.busy)).toBe(true);

  await sheet(page).getByRole("button", { name: "Retry" }).click();
  await expect(scope.locator("[data-btw-status]")).toHaveText("Waiting in queue");
  await call(page, (fixture) => fixture.btwRun());
  await expect(scope.locator("[data-btw-status]")).toHaveText("Answering");
  await call(page, (fixture) => fixture.btwAnswer("AFTER_OMEGA_8256 came last."));
  await expect(scope.locator("[data-btw-status]")).toHaveText("Answered");
  await expect(sheet(page).getByText("AFTER_OMEGA_8256 came last.")).toBeVisible();
  // A finished answer keeps its usual duration line.
  await expect(sheet(page).getByText(/worked for/).first()).toBeVisible();
  // The parent's running turn never entered the side conversation.
  await expect(sheet(page).getByText("Keep working on the rollout.")).toHaveCount(0);
});

for (const input of ["pointer", "keyboard"] as const) {
  test(`the ${input} side-question button refreshes after the main session becomes idle`, async ({ page }) => {
    await left(page).getByRole("textbox").last().fill("Keep this draft unsent.");
    await call(page, (fixture) => fixture.setBusy(true));
    const button = sideButton(page, 0);
    if (input === "pointer") await button.hover();
    else await button.focus();
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).toHaveAttribute("title", /latest finished turn/);
    await expect(sheet(page)).toHaveCount(0);

    // No new hover/focus event: the existing button must follow session state.
    await call(page, (fixture) => fixture.setBusy(false));
    await expect(left(page).getByText("MAIN-DONE", { exact: true })).toBeVisible();
    await expect(left(page).getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(button).toHaveAttribute("aria-disabled", "false");
    await expect(button).toHaveAttribute("title", "Side question about this turn");
    if (input === "pointer") await button.click();
    else {
      // The pane focuses its composer on completion. Check availability above
      // before focusing this action again, then exercise keyboard activation.
      await button.focus();
      await page.keyboard.press("Enter");
    }
    await expect(sheet(page).locator("[data-btw-scope]")).toContainText("As of Turn 1");
    await expect(sheet(page).getByText("Noted AFTER_OMEGA_8256.")).toHaveCount(0);
    expect(await call(page, (fixture) => fixture.submitted)).toEqual([]);
  });
}

test("a selected conclusion joins the existing draft, keeping its attachment, MCP tag and reference card, without sending", async ({ page }) => {
  await page.goto("/tests/browser/session-fork-sidechat.html?draft=1");
  const main = left(page).getByRole("textbox").last();
  await expect(main).toHaveValue("Earlier draft use @mcp/docs ");
  const cards = left(page).locator("[data-composer-box] [data-session-reference-chips] li");
  await expect(cards).toHaveCount(1);
  await main.click();
  await main.evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(left(page).getByText("notes.txt")).toBeVisible();

  await sideButton(page, 1).click();
  const question = sheet(page).getByRole("textbox", { name: "By-the-way question" });
  await question.fill("What should we keep?");
  await page.keyboard.press("Enter");
  await call(page, (fixture) => fixture.btwRun());
  await call(page, (fixture) => fixture.btwAnswer("结论：**保留缓存**，再重试。阅读[原文](https://example.com/context)之后继续。"));
  const answer = sheet(page).locator("[data-selectable-agent-response]").last();
  await expect(answer).toContainText("保留缓存");
  await answer.evaluate((el) => {
    const paragraph = el.querySelector("p") ?? el;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole("toolbar", { name: "Selected text actions" }).getByRole("button", { name: "Bring to main chat" }).click();

  await expect(sheet(page)).toHaveCount(0);
  await expect(main).toHaveValue(
    "Earlier draft use @mcp/docs \n\nFrom side question “What should we keep?” (as of Turn 2 · Now also remember AFTER_OMEGA_8256., inclusive):\n结论：保留缓存，再重试。阅读原文之后继续。\n\n",
  );
  await expect(main).toBeFocused();
  await expect(left(page).getByText("notes.txt")).toBeVisible();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("Referenced design notes");
  expect(await call(page, (fixture) => fixture.draft())).toEqual({ mcp: ["@mcp/docs"], references: ["ref-1"] });
  expect(await call(page, (fixture) => fixture.submitted)).toEqual([]);
});

test("saved side discussions come back after a reload, with an interrupted request marked", async ({ page }) => {
  await sideButton(page, 1).click();
  const question = sheet(page).getByRole("textbox", { name: "By-the-way question" });
  await question.fill("First question");
  await page.keyboard.press("Enter");
  await call(page, (fixture) => fixture.btwRun());
  await call(page, (fixture) => fixture.btwAnswer("First answer kept."));
  await question.fill("Second question");
  await page.keyboard.press("Enter");
  await expect(sheet(page).locator("[data-btw-status]")).toHaveText("Waiting in queue");
  await page.waitForTimeout(300);

  await page.reload();
  await expect(left(page).getByText("Noted AFTER_OMEGA_8256.")).toBeVisible();
  await sideButton(page, 1).click();
  await sheet(page).getByRole("tab", { name: /First question/ }).click();
  await expect(sheet(page).getByText("First answer kept.")).toBeVisible();
  await expect(sheet(page).locator("[data-btw-status]")).toHaveText("Couldn’t finish");
  await expect(sheet(page).getByRole("alert")).toContainText("interrupted before reload");
  const interrupted = sheet(page).locator("[data-turn-actions]").last();
  await expect(interrupted).toHaveAttribute("aria-label", "Didn’t finish");
  await expect(interrupted.locator(":scope > span").first().locator("svg")).toHaveCount(0);
  await expect(sheet(page).getByText(/worked for/)).toHaveCount(1);
});

test("narrow window: the fork menu and side question scope stay inside the pane", async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 700 });
  await forkButton(page, "left", 1).click();
  const box = await menu(page).boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 560).toBe(true);
  await page.keyboard.press("Escape");

  await sideButton(page, 1).click();
  const scope = sheet(page).locator("[data-btw-scope]");
  await expect(scope).toContainText("Read-only");
  const overflow = await scope.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("an unbound fork record shows its native thread and cannot send, even after a reload", async ({ page }) => {
  await call(page, (fixture) => {
    fixture.unbound = true;
  });
  await forkButton(page, "left", 0).click();
  await menu(page).locator('[data-fork-strategy="native"]').click();
  await expect(menu(page).getByRole("alert")).toContainText("未绑定 native child：thread-child");
  await expect(right(page)).toHaveAttribute("data-session", "other");

  await page.reload();
  await expect(left(page).getByText("Noted AFTER_OMEGA_8256.")).toBeVisible();
  const record = await call(page, (fixture) =>
    fixture.sessions().find((session) => session.title.startsWith("Fork 未绑定")),
  );
  expect(record?.providerSessionId).toBeUndefined();
  await page.evaluate((id) => (window as unknown as { fixture: Fixture }).fixture.showRight(id), record!.id);
  const card = right(page).locator("[data-fork-recovery]");
  await expect(card).toContainText("Fork not bound · needs recovery · from Cache rollout plan");
  await expect(card).toContainText("thread-child");
  await expect(card).toContainText("nothing is sent, resumed or cleaned up from here");
  await expect(right(page).getByRole("textbox").last()).toBeDisabled();
  await expect(right(page).getByRole("button", { name: "Fork from this turn" })).toHaveCount(0);
  await expect(right(page).getByRole("button", { name: "Side question about this turn" })).toHaveCount(0);
  expect(await call(page, (fixture) => fixture.submitted)).toEqual([]);
});

test("a stopped partial answer is kept, reads as stopped, and comes back that way after a reload", async ({ page }) => {
  await sideButton(page, 1).click();
  const question = sheet(page).getByRole("textbox", { name: "By-the-way question" });
  await question.fill("Earlier question");
  await page.keyboard.press("Enter");
  await call(page, (fixture) => fixture.btwRun());
  await call(page, (fixture) => fixture.btwAnswer("Earlier answer finished."));
  await question.fill("Explain the rollout");
  await page.keyboard.press("Enter");
  await call(page, (fixture) => fixture.btwRun());
  await call(page, (fixture) => fixture.btwPartial("PARTIAL_ROLLOUT_NOTE so far"));
  await expect(sheet(page).getByText("PARTIAL_ROLLOUT_NOTE so far")).toBeVisible();
  await sheet(page).getByRole("button", { name: /stop/i }).click();

  const check = async () => {
    await expect(sheet(page).locator("[data-btw-status]")).toHaveText("Stopped");
    await expect(sheet(page).getByText("PARTIAL_ROLLOUT_NOTE so far")).toBeVisible();
    await expect(sheet(page).locator("[data-turn-actions]").last()).toHaveAttribute("aria-label", "Stopped");
    // Only the earlier, finished turn carries a duration.
    await expect(sheet(page).getByText(/worked for/)).toHaveCount(1);
  };
  await check();
  expect(await call(page, (fixture) => fixture.submitted)).toEqual([]);

  await page.waitForTimeout(300);
  await page.reload();
  await expect(left(page).getByText("Noted AFTER_OMEGA_8256.")).toBeVisible();
  await sideButton(page, 1).click();
  await sheet(page).getByRole("tab", { name: /Earlier question/ }).click();
  await check();
});

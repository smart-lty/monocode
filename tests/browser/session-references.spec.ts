import { expect, test, type Page } from "@playwright/test";

// Mocked IPC fixture (tests/browser/session-references.tsx); the real Rust
// store, Tauri drag and provider delivery are verified in the App separately.

const composer = (page: Page, pane: "left" | "right") =>
  page.getByTestId(`pane-${pane}`).locator("textarea");
const picker = (page: Page) => page.locator("[data-session-reference-picker]");
const chips = (page: Page, pane: "left" | "right") =>
  page
    .getByTestId(`pane-${pane}`)
    .locator("[data-composer-box] [data-session-reference-chips] li");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/session-references.html");
});

test("## walks all 1,200 sessions across projects to the last page", async ({
  page,
}) => {
  const input = composer(page, "left");
  await input.click();
  await input.pressSequentially("##");
  const list = picker(page).getByRole("listbox");
  await expect(list.getByRole("option").first()).toBeVisible();
  for (let page_ = 0; page_ < 14; page_++) {
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(60);
  }
  await expect(picker(page).getByRole("status")).toHaveText("1200 sessions");
  const ids = await list
    .getByRole("option")
    .evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size).toBe(1200);
  // Browsing all projects never touched the draft or the current session.
  await expect(page.getByTestId("session-left")).toHaveText("left-1");
  await expect(input).toHaveValue("##");
});

test("title hits beyond the first screen rank first, including Chinese and duplicates", async ({
  page,
}) => {
  const input = composer(page, "left");
  await input.click();
  await input.pressSequentially("##needle");
  const first = picker(page).getByRole("option").first();
  await expect(first).toContainText("Needle in the oldest session");
  await expect(first).toContainText("notes-app");
  await expect(input).toHaveAttribute("aria-activedescendant", /option-0$/);

  await input.fill("");
  await input.pressSequentially("##输入法");
  await expect(picker(page).getByRole("option").first()).toContainText(
    "修复 Composer 中文输入法回车",
  );

  await input.fill("");
  await input.pressSequentially("#refactor");
  const rows = picker(page).getByRole("option");
  // Same title in this project: told apart by short id.
  await expect(rows.nth(0)).toContainText("0012");
  await expect(rows.nth(1)).toContainText("0015");
  await input.fill("");
  await input.pressSequentially("##refactor");
  await expect(picker(page).getByRole("option")).toHaveCount(4);
  await expect(picker(page).getByRole("option").nth(1)).toContainText("synara");
});

test("explicit content search finds a message, Escape returns to titles", async ({
  page,
}) => {
  const input = composer(page, "left");
  await input.click();
  await input.pressSequentially("#zebra");
  await expect(picker(page).getByRole("status")).toContainText("No matching");
  await picker(page).getByText("Search message content for “zebra”").click();
  await expect(picker(page).getByRole("option").first()).toContainText(
    "zebra-crossing bug",
  );
  await input.press("Escape");
  await expect(picker(page)).toContainText("This project");
  await input.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await input.pressSequentially("x");
  await expect(picker(page)).toHaveCount(0);
});

test("keyboard picks, dedupes and removes cards without touching the text", async ({
  page,
}) => {
  const input = composer(page, "left");
  await input.click();
  await input.pressSequentially("keep this ");
  await input.pressSequentially("#");
  await expect(picker(page).getByRole("option").first()).toBeVisible();
  // Bare # does not preselect: Enter would send. Arrow then Tab picks.
  await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/);
  await input.press("ArrowDown");
  await input.press("Tab");
  await expect(chips(page, "left")).toHaveCount(1);
  await expect(input).toHaveValue("keep this ");
  await expect(input).toBeFocused();
  await input.pressSequentially("#");
  await expect(picker(page).getByRole("option").first()).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("keep this ");
  await expect(chips(page, "left")).toHaveCount(1);
  await chips(page, "left").first().getByRole("button").click();
  await expect(chips(page, "left")).toHaveCount(0);
  await expect(input).toHaveValue("keep this ");
});

const sidebarCalls = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { sidebarCalls: string[] }).sidebarCalls,
  );

async function dragCard(page: Page, id: string, to: { x: number; y: number }) {
  // The real Sidebar SessionCard: pointer down, a few moves, pointer up.
  const card = page.getByTestId(`card-${id}`).locator("[data-session-card]");
  const from = (await card.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
}

test("a real Sidebar card drag lands on the composer under the pointer only", async ({
  page,
}) => {
  const rightInput = composer(page, "right");
  await rightInput.click();
  await rightInput.pressSequentially("typed before");
  await rightInput.evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(5, 5),
  );
  const right = page.getByTestId("pane-right").locator("[data-composer-box]");
  const box = (await right.boundingBox())!;
  await dragCard(page, "s0003", {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  await expect(right).toHaveAttribute("data-session-reference-over", "true");
  await page.mouse.up();
  await expect(right).not.toHaveAttribute("data-session-reference-over");
  // The snapshot check is slow; keep typing meanwhile.
  await rightInput.focus();
  await page.keyboard.type("+");
  await expect(chips(page, "right")).toHaveCount(1);
  await expect(chips(page, "left")).toHaveCount(0);
  await expect(rightInput).toHaveValue("typed+ before");
  expect(
    await rightInput.evaluate((el: HTMLTextAreaElement) => el.selectionStart),
  ).toBe(6);
  // No selecting, splitting or moving sessions on the way.
  expect(await sidebarCalls(page)).toEqual([]);
  await expect(page.getByTestId("session-left")).toHaveText("left-1");

  // A session dropped on its own composer is not referenced.
  const left = page.getByTestId("pane-left").locator("[data-composer-box]");
  const leftBox = (await left.boundingBox())!;
  await dragCard(page, "left-1", {
    x: leftBox.x + leftBox.width / 2,
    y: leftBox.y + leftBox.height / 2,
  });
  await expect(left).not.toHaveAttribute("data-session-reference-over");
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(chips(page, "left")).toHaveCount(0);
  expect(await sidebarCalls(page)).toEqual([]);

  // Outside a composer the card keeps its usual pane drop.
  const pane = (await page.getByTestId("pane-left").boundingBox())!;
  await dragCard(page, "s0006", { x: pane.x + pane.width / 2, y: pane.y + 40 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(chips(page, "left")).toHaveCount(0);
  expect(await sidebarCalls(page)).toEqual([
    expect.stringMatching(/^placeOnPane:"s0006"/),
  ]);
});

test("old rows can't be clicked after the query changes", async ({ page }) => {
  const input = composer(page, "left");
  await input.click();
  await input.pressSequentially("##needle");
  await expect(picker(page).getByRole("option").first()).toContainText(
    "Needle in the oldest session",
  );
  // A one-letter query is served slowly (1.5s) by the mock.
  await input.fill("##n");
  const stale = picker(page).getByRole("option").first();
  await expect(stale).toHaveAttribute("aria-disabled", "true");
  // force: Playwright would otherwise wait for aria-disabled to clear.
  await stale.click({ force: true });
  await expect(chips(page, "left")).toHaveCount(0);
  await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/);
  await expect(stale).not.toHaveAttribute("aria-disabled");
  await expect(chips(page, "left")).toHaveCount(0);
  // Once the new results are in, the same row is a real choice.
  await stale.click();
  await expect(chips(page, "left")).toHaveCount(1);
});

test("Enter while results load sends normally; nothing is picked later", async ({
  page,
}) => {
  const input = composer(page, "left");
  await input.click();
  await input.pressSequentially("hello #n");
  await input.press("Enter");
  // Past the slow (1.5s) response: it must not pick anything either.
  await page.waitForTimeout(1800);
  expect(
    await page.evaluate(() =>
      (window as unknown as { submitted: { text: string }[] }).submitted.map(
        (entry) => entry.text,
      ),
    ),
  ).toEqual(["[left] hello #n"]);
  await expect(chips(page, "left")).toHaveCount(0);
});

for (const color of ["abc", "abcdef", "cafe"]) {
  test(`#${color} keeps Enter as send even with matching sessions`, async ({
    page,
  }) => {
    const input = composer(page, "left");
    await input.click();
    await input.pressSequentially(`#${color}`);
    await page.waitForTimeout(200);
    await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/);
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect(chips(page, "left")).toHaveCount(0);
  });
}

test("cards and text survive switching sessions and are sent with the message", async ({
  page,
}) => {
  const input = composer(page, "left");
  await input.click();
  await input.pressSequentially("draft text ##needle");
  await expect(input).toHaveAttribute("aria-activedescendant", /option-0$/);
  await input.press("Enter");
  await expect(chips(page, "left")).toHaveCount(1);
  await expect(input).toHaveValue("draft text ");
  await page.getByRole("button", { name: "Open left-2" }).click();
  await expect(chips(page, "left")).toHaveCount(0);
  await expect(composer(page, "left")).toHaveValue("");
  await page.getByRole("button", { name: "Open left-1" }).click();
  await expect(chips(page, "left")).toHaveCount(1);
  await expect(composer(page, "left")).toHaveValue("draft text ");
  await composer(page, "left").press("Enter");
  await expect(chips(page, "left")).toHaveCount(0);
  await expect(
    page.getByTestId("sent-left").locator("[data-session-reference-chips] li"),
  ).toHaveText(/Needle in the oldest session/);
});

test("@ still picks files", async ({ page }) => {
  const input = composer(page, "left");
  await input.click();
  await input.pressSequentially("@READ");
  await expect(page.locator("[data-mention-picker]")).toContainText(
    "README.md",
  );
  await input.press("Enter");
  await expect(input).toHaveValue("@README.md ");
  await expect(picker(page)).toHaveCount(0);
});

test.describe("narrow window", () => {
  test.use({ viewport: { width: 360, height: 480 } });
  test("the picker and many cards leave the input visible", async ({
    page,
  }) => {
    const input = composer(page, "left");
    for (let index = 0; index < 8; index++) {
      await input.click();
      await input.pressSequentially("##");
      await expect(picker(page).getByRole("option").first()).toBeVisible();
      for (let step = 0; step <= index; step++) await input.press("ArrowDown");
      await input.press("Enter");
    }
    await expect(chips(page, "left")).toHaveCount(8);
    await input.pressSequentially("still typing");
    await expect(input).toBeInViewport();
    const inputBox = (await input.boundingBox())!;
    expect(inputBox.height).toBeGreaterThan(15);
    await input.fill("");
    await input.pressSequentially("##ses");
    await expect(picker(page).getByRole("option").first()).toBeVisible();
    // Model, time, title and project never overlap in a 360px window.
    const overlaps = await picker(page)
      .getByRole("option")
      .evaluateAll((rows) =>
        rows.slice(0, 5).flatMap((row) => {
          const boxes = [
            "[data-session-model]",
            "[data-session-time]",
            "[data-session-title]",
            "[data-session-project]",
          ].map((selector) =>
            row.querySelector(selector)?.getBoundingClientRect(),
          );
          const hits: string[] = [];
          boxes.forEach((a, i) =>
            boxes.slice(i + 1).forEach((b, j) => {
              if (
                a &&
                b &&
                a.width > 0 &&
                b.width > 0 &&
                a.left < b.right - 0.5 &&
                b.left < a.right - 0.5 &&
                a.top < b.bottom - 0.5 &&
                b.top < a.bottom - 0.5
              )
                hits.push(`${row.id}:${i}/${i + j + 1}`);
            }),
          );
          return hits;
        }),
      );
    expect(overlaps).toEqual([]);
    const pickerBox = (await picker(page).boundingBox())!;
    expect(pickerBox.y).toBeGreaterThanOrEqual(0);
    expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(
      (await input.boundingBox())!.y,
    );
  });
});

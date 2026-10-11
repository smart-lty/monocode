import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { MarkdownExample, MarkdownFixture } from "./markdown-regressions";

const headings = "# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6";
const wideSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400"><rect width="1600" height="400"/></svg>';
const tauri = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));

async function expectLoaded(image: ReturnType<Page["locator"]>) {
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate(
        (el: HTMLImageElement) => el.complete && el.naturalWidth > 0,
      ),
    )
    .toBe(true);
}

async function show(page: Page, example: MarkdownExample) {
  await page.evaluate(
    (example) => (window as unknown as MarkdownFixture).showMarkdown(example),
    example,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/markdown-regressions.html");
  await expect(page.locator(".agent-markdown")).toContainText("Ready.");
});

test("ordinary network images render and fit the container", async ({
  page,
}) => {
  await page.route("https://images.example.org/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: wideSvg,
    }),
  );
  await show(page, {
    text: "![Network diagram](https://images.example.org/diagram.svg)",
  });
  const image = page.getByRole("img", { name: "Network diagram" });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBe(1600);
  expect(
    await image.evaluate(
      (el) =>
        el.getBoundingClientRect().width <=
        el.closest(".agent-markdown")!.getBoundingClientRect().width,
    ),
  ).toBe(true);
});

test("H1–H6 use consistent computed font sizes", async ({ page }) => {
  for (const light of [false, true]) {
    await page.evaluate(
      (light) =>
        document.documentElement.classList.toggle("theme-light", light),
      light,
    );
    await show(page, { text: headings });
    const titles = page.locator("h1, h2, h3, h4, h5, h6");
    await expect(titles).toHaveCount(6);
    expect(
      await titles.evaluateAll((elements) =>
        elements.map((el) => getComputedStyle(el).fontSize),
      ),
    ).toEqual(["22px", "18px", "16px", "15px", "14px", "14px"]);
    expect(
      await titles.evaluateAll((elements) =>
        elements.map((el) => getComputedStyle(el).fontWeight),
      ),
    ).toEqual(["700", "700", "600", "600", "600", "600"]);
  }
});

test("HTTP and HTTPS images pass the shipped img-src directive", async ({
  page,
}) => {
  // Apply only the actual image directive to the fixture. Other Tauri policies
  // and native WebView behavior are not being exercised by this browser test.
  for (const policy of [tauri.app.security.csp, tauri.app.security.devCsp]) {
    await page.evaluate((content) => {
      const meta = document.createElement("meta");
      meta.httpEquiv = "Content-Security-Policy";
      meta.content = content
        .split(";")
        .find((part: string) => part.trim().startsWith("img-src "))!
        .trim();
      document.head.append(meta);
    }, policy);
  }
  await page.route(/https?:\/\/images\.example\.org\//, (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: wideSvg }),
  );
  await show(page, {
    text: "![HTTP](http://images.example.org/http.svg)\n\n![HTTPS](https://images.example.org/https.svg)",
  });
  await expectLoaded(page.getByRole("img", { name: "HTTP", exact: true }));
  await expectLoaded(page.getByRole("img", { name: "HTTPS", exact: true }));
  expect(
    await page.evaluate(() => (window as unknown as MarkdownFixture).fileReads),
  ).toEqual([]);
});

test("local relative, absolute, Chinese and space paths use image blobs", async ({
  page,
}) => {
  await show(page, {
    cwd: "/repo",
    text: [
      "![Bare](images/chart.png)",
      "![JPEG](images/photo.jpg)",
      "![Relative](./images/chart.png)",
      "![Chinese](<images/中文 图.png>)",
      "![Absolute](</tmp/图 表.png>)",
      "![Encoded](images/%E5%9B%BE%20%E8%A1%A8.png)",
    ].join("\n\n"),
  });
  for (const alt of [
    "Bare",
    "JPEG",
    "Relative",
    "Chinese",
    "Absolute",
    "Encoded",
  ]) {
    const image = page.getByRole("img", { name: alt, exact: true });
    await expectLoaded(image);
    expect(await image.getAttribute("src")).toMatch(/^blob:/);
    expect(
      await image.evaluate(
        (el) =>
          el.getBoundingClientRect().width <=
          el.closest(".agent-markdown")!.getBoundingClientRect().width,
      ),
    ).toBe(true);
  }
  expect(
    await page.evaluate(() => (window as unknown as MarkdownFixture).fileReads),
  ).toEqual([
    "/repo/images/chart.png",
    "/repo/images/photo.jpg",
    "/repo/images/chart.png",
    "/repo/images/中文 图.png",
    "/tmp/图 表.png",
    "/repo/images/图 表.png",
  ]);
});

test("raw HTML images use the same local reader and remove event attributes", async ({
  page,
}) => {
  await show(page, {
    cwd: "/repo",
    text: '<img src="images/中文 图.png" alt="HTML image" onerror="window.__rawImageEventRan = true" width="1600">',
  });
  const image = page.getByRole("img", { name: "HTML image" });
  await expectLoaded(image);
  await expect(image).not.toHaveAttribute("onerror");
  expect(
    await image.evaluate(
      (el) =>
        el.getBoundingClientRect().width <=
        el.closest(".agent-markdown")!.getBoundingClientRect().width,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as MarkdownFixture).fileReads),
  ).toEqual(["/repo/images/中文 图.png"]);
});

test("changing image source or session cwd releases the previous blob", async ({
  page,
}) => {
  await show(page, { cwd: "/repo-one", text: "![Chart](chart.png)" });
  const image = page.getByRole("img", { name: "Chart" });
  await expectLoaded(image);
  const first = (await image.getAttribute("src"))!;
  await show(page, { cwd: "/repo-two", text: "![Chart](chart.png)" });
  await expectLoaded(image);
  await expect(image).not.toHaveAttribute("src", first);
  const second = (await image.getAttribute("src"))!;
  await show(page, { cwd: "/repo-two", text: "![Chart](second.png)" });
  await expectLoaded(image);
  await expect(image).not.toHaveAttribute("src", second);
  expect(
    await page.evaluate(() => (window as unknown as MarkdownFixture).fileReads),
  ).toEqual([
    "/repo-one/chart.png",
    "/repo-two/chart.png",
    "/repo-two/second.png",
  ]);
  expect(
    await page.evaluate(
      () => (window as unknown as MarkdownFixture).revokedImageUrls,
    ),
  ).toEqual([first, second]);
});

test("local SVG stays an image in the transcript and lightbox, with no active content", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("svg-resources.invalid"))
      externalRequests.push(request.url());
  });
  await page.route("https://svg-resources.invalid/**", (route) =>
    route.fulfill({ status: 200, body: "unexpected" }),
  );
  await show(page, {
    cwd: "/repo",
    text: "![Local SVG](<diagrams/中文 图.svg>)",
  });
  const image = page.getByRole("img", { name: "Local SVG", exact: true });
  await expectLoaded(image);
  const src = (await image.getAttribute("src"))!;
  expect(src).toMatch(/^blob:/);
  expect(
    await page.evaluate(
      async (src) => (await fetch(src)).headers.get("Content-Type"),
      src,
    ),
  ).toBe("image/svg+xml");
  await image.click();
  const preview = page.getByRole("dialog", {
    name: "Image preview: Local SVG",
  });
  await expectLoaded(preview.getByRole("img", { name: "Local SVG" }));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(
    await page.evaluate(() => ({
      script: Reflect.get(window, "__svgScriptRan"),
      event: Reflect.get(window, "__svgEventRan"),
    })),
  ).toEqual({ script: undefined, event: undefined });
  expect(externalRequests).toEqual([]);
  await expect(
    page.locator(".agent-markdown svg, [role=dialog] svg, iframe, object"),
  ).toHaveCount(1); // Only the existing close-button icon.
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await show(page, { text: "Removed." });
  await expect
    .poll(() =>
      page.evaluate(
        (src) =>
          (window as unknown as MarkdownFixture).revokedImageUrls.includes(src),
        src,
      ),
    )
    .toBe(true);
});

test("bad network, missing local, invalid bytes and malformed SVG keep alt text and feedback", async ({
  page,
}) => {
  await page.route("https://images.example.org/missing.png", (route) =>
    route.fulfill({ status: 404, body: "missing" }),
  );
  await show(page, {
    cwd: "/repo",
    text: [
      "![Broken network](https://images.example.org/missing.png)",
      "![Missing file](missing.png)",
      "![Invalid image](invalid.png)",
      "![Invalid SVG](invalid.svg)",
      "![Malformed SVG](malformed.svg)",
    ].join("\n\n"),
  });
  for (const alt of [
    "Broken network",
    "Missing file",
    "Invalid image",
    "Invalid SVG",
    "Malformed SVG",
  ]) {
    await expect(
      page.locator(".markdown-image-failure").filter({ hasText: alt }),
    ).toContainText("Could not load image");
  }
  await expect(page.locator(".agent-markdown img")).toHaveCount(0);
});

test("Inbox keeps its media allowlist and notes keep their own resolver", async ({
  page,
}) => {
  await show(page, {
    cwd: "/repo",
    allowRemoteMedia: true,
    text: [
      "![Allowed](https://user-images.githubusercontent.com/diagram.png)",
      "![Blocked web](https://images.example.org/diagram.png)",
      "![Blocked local](/tmp/chart.png)",
    ].join("\n\n"),
  });
  await expectLoaded(page.getByRole("img", { name: "Allowed" }));
  await expect(page.locator(".agent-markdown")).toContainText(
    "Image blocked: Blocked web",
  );
  await expect(page.locator(".agent-markdown")).toContainText(
    "Image blocked: Blocked local",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as MarkdownFixture).mediaFetches,
    ),
  ).toEqual(["https://user-images.githubusercontent.com/diagram.png"]);
  expect(
    await page.evaluate(() => (window as unknown as MarkdownFixture).fileReads),
  ).toEqual([]);
  await page.route("http://asset.localhost/**", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: wideSvg }),
  );
  await show(page, {
    text: "![Note image](/note-assets/note-browser/diagram.png)",
  });
  await expectLoaded(page.getByRole("img", { name: "Note image" }));
  await expect(page.locator("[data-note-image]")).toHaveAttribute(
    "src",
    "http://asset.localhost/app-data/note-assets/note-browser/diagram.png",
  );
  expect(
    await page.evaluate(() => (window as unknown as MarkdownFixture).fileReads),
  ).toEqual([]);
});

test("picture sources cannot bypass the Inbox image allowlist", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("images.example.org"))
      requests.push(request.url());
  });
  await page.route("https://images.example.org/spoof.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: wideSvg,
    }),
  );
  await show(page, {
    allowRemoteMedia: true,
    text: '<picture><source srcset="https://images.example.org/spoof.svg"><img src="https://user-images.githubusercontent.com/picture.png" alt="Inbox picture"></picture>',
  });
  await expectLoaded(page.getByRole("img", { name: "Inbox picture" }));
  expect(requests).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as MarkdownFixture).mediaFetches,
    ),
  ).toEqual(["https://user-images.githubusercontent.com/picture.png"]);
});

test("data images remain available while unsupported protocols stay inactive", async ({
  page,
}) => {
  await show(page, {
    cwd: "/repo",
    text: [
      `![Data](data:image/svg+xml,${encodeURIComponent(wideSvg)})`,
      "![Script](javascript:alert%281%29)",
      "![File URI](file:///tmp/chart.png)",
      "![Blob](blob:uncontrolled)",
      "![Network path](//images.example.org/chart.png)",
    ].join("\n\n"),
  });
  await expectLoaded(page.getByRole("img", { name: "Data" }));
  await expect(page.locator(".agent-markdown img")).toHaveCount(1);
  for (const alt of ["Script", "File URI", "Blob", "Network path"]) {
    await expect(page.locator(".agent-markdown")).toContainText(alt);
  }
  expect(
    await page.evaluate(() => (window as unknown as MarkdownFixture).fileReads),
  ).toEqual([]);
});

test("streaming comparison text and partial tags restore when the same source completes", async ({
  page,
}) => {
  const text = "前文 a<b 则交换。\n\n尾部 <Foo";
  await show(page, { text, streaming: true, revealOnMount: false });
  await expect(page.locator(".agent-markdown-block").first()).toContainText(
    "前文 a<b 则交换。",
  );
  await expect(page.locator(".agent-markdown-block").last()).toHaveText("尾部");
  await show(page, { text, streaming: false });
  await expect(page.locator(".agent-markdown-block").last()).toHaveText(
    "尾部 <Foo",
  );
  await show(page, { text: "如果 a<b 则交换。", streaming: true, mountId: "comparison" });
  await expect(page.locator(".agent-markdown")).toHaveText("如果 a<b 则交换。");
  await show(page, { text: "如果 a<b 则交换。", streaming: false });
  await expect(page.locator(".agent-markdown")).toHaveText("如果 a<b 则交换。");
});

test("a completed reply paced on mount finishes without losing its comparison text", async ({
  page,
}) => {
  await show(page, {
    text: "如果 a<b 则交换。",
    revealOnMount: true,
    mountId: "paced-completed",
  });
  await expect(page.locator(".word-fading")).toHaveCount(1);
  await expect(page.locator(".agent-markdown")).toHaveText("如果 a<b 则交换。");
  await expect(page.locator(".word-fading")).toHaveCount(0);
});

test("Chinese emphasis, punctuation boundaries and generic text render alongside safe HTML", async ({
  page,
}) => {
  await show(page, {
    text: '**注意：**后面的内容需要确认。\n\n这是**“引用”**文本，以及**（括号）**说明。\n\n访问 https://example.com/docs。然后继续\n\nVec<String>、Option<T>、Map<K, V>\n\n<details open onclick="window.__htmlEventRan = true"><summary>More</summary><kbd onmouseover="window.__htmlEventRan = true">Ctrl</kbd><br>Tail</details>\n\n<Widget onClick="window.__htmlEventRan = true">unknown</Widget>\n\n<script>window.__htmlScriptRan = true</script>',
  });
  const strong = page.locator('[data-streamdown="strong"]');
  await expect(strong).toHaveText(["注意：", "“引用”", "（括号）"]);
  for (const span of await strong.all())
    await expect(span).toHaveCSS("font-weight", "600");
  await expect(page.locator("a")).toHaveAttribute(
    "href",
    "https://example.com/docs",
  );
  await expect(page.locator(".agent-markdown")).toContainText(
    "Vec<String>、Option<T>、Map<K, V>",
  );
  await expect(page.locator("details")).toHaveCount(1);
  await expect(page.locator("kbd")).toHaveText("Ctrl");
  await expect(page.locator("br")).toHaveCount(1);
  await expect(
    page.locator(
      ".agent-markdown script, .agent-markdown [onclick], .agent-markdown [onmouseover], .agent-markdown widget",
    ),
  ).toHaveCount(0);
  await page.locator("kbd").hover();
  expect(
    await page.evaluate(() => ({
      script: Reflect.get(window, "__htmlScriptRan"),
      event: Reflect.get(window, "__htmlEventRan"),
    })),
  ).toEqual({ script: undefined, event: undefined });
});

test("whats-new and zen heading overrides remain in both themes", async ({
  page,
}) => {
  for (const light of [false, true]) {
    await page.evaluate(
      (light) =>
        document.documentElement.classList.toggle("theme-light", light),
      light,
    );
    await show(page, { text: headings, zen: true });
    await expect(page.locator("h1, h2, h3, h4, h5, h6")).toHaveCount(6);
    expect(
      await page
        .locator("h1, h2, h3, h4, h5, h6")
        .evaluateAll((elements) =>
          elements.map((el) => getComputedStyle(el).fontSize),
        ),
    ).toEqual(Array(6).fill("14px"));
    await show(page, { text: "### Release", className: "whats-new-md" });
    await expect(page.locator("h3")).toHaveCSS("font-size", "11px");
    await expect(page.locator("h3")).toHaveCSS("text-transform", "uppercase");
  }
});

test("code, Mermaid and file navigation keep their behavior", async ({
  page,
}) => {
  await show(page, {
    cwd: "/repo",
    text: "`Vec<String>`\n\n```typescript\nconst value: Vec<String> = x;\n```\n\n```mermaid\ngraph TD\nA[开始] --> B[结束]\n```\n\n[Guide](<docs/中文 Guide.md#L7>) and `src/main.ts:12:3`",
  });
  await expect(page.locator(".agent-markdown p code").first()).toHaveText(
    "Vec<String>",
  );
  await expect(
    page.locator('[data-streamdown="code-block-body"] code').first(),
  ).toContainText("const value: Vec<String> = x;");
  await expect(page.locator(".mermaid-block svg")).toBeVisible();
  await expect(page.locator(".mermaid-block")).toContainText("开始");
  await page.getByRole("link", { name: "Guide" }).click();
  await page.getByRole("link", { name: "src/main.ts:12:3" }).press("Enter");
  expect(
    await page.evaluate(
      () => (window as unknown as MarkdownFixture).openedFiles,
    ),
  ).toEqual([
    { path: "/repo/docs/中文 Guide.md", navigation: { line: 7 } },
    { path: "/repo/src/main.ts", navigation: { line: 12, column: 3 } },
  ]);
  await show(page, { text: "```mermaid\ngraph TD\nA[修改] --> B[结束]\n```" });
  await expect(page.locator(".mermaid-block")).toContainText("修改");
});


test("math renders inline and display layout with local fonts", async ({ page }) => {
  await show(page, { text: "Inline $x^2$ and ${2x+1}$.\n\n$$\n\\frac{1}{2} = \\sum_{n=1}^{\\infty} 2^{-n-1}\n$$" });
  await expect(page.locator(".katex")).toHaveCount(3);
  await expect(page.locator(".katex-display")).toBeVisible();
  await expect(page.locator(".katex .katex-mathml math")).toHaveCount(3);
  await expect(page.locator(".markdown-code-shell")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.locator(".katex-html").first().evaluate((el) => getComputedStyle(el).display)).not.toBe("none");
  expect(await page.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBe(true);
  const inline = page.locator(".katex").first();
  expect(await inline.evaluate((el) => el.closest("p") !== null)).toBe(true);
});

test("streamed math settles without dropping symbols or fading its layout", async ({ page }) => {
  for (const text of ["Before $x", "Before $x^2$\n\n$$\n\\frac{1}", "Before $x^2$\n\n$$\n\\frac{1}{2}\n$$"]) {
    await show(page, { text, streaming: true });
  }
  await expect(page.locator(".katex")).toHaveCount(2);
  await expect(page.locator(".katex [data-word-fade]")).toHaveCount(0);
  await show(page, { text: "Before $x^2$\n\n$$\n\\frac{1}{2}\n$$", streaming: false });
  await expect(page.locator(".katex")).toHaveCount(2);
  await expect(page.locator(".katex-display mfrac")).toHaveCount(1);
  await expect(page.locator(".katex-error")).toHaveCount(0);
});

test("math preserves code and invalid input without executable links", async ({ page }) => {
  await show(page, { text: "`$x$` and \\$5, \\$10.\n\n$\\notACommand{x}$\n\n$\\href{javascript:alert(1)}{click}$" });
  await expect(page.locator("code")).toContainText("$x$");
  await expect(page.locator(".agent-markdown")).toContainText("$5, $10");
  await expect(page.locator(".agent-markdown")).toContainText("notACommand");
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
});


test("prices and shell variables stay literal while streaming and after completion", async ({ page }) => {
  for (const text of ["Price $5", "Price $5 and $10", "Set $HOME and $PATH"]) {
    for (const streaming of [true, false]) {
      await show(page, { text, streaming });
      await expect(page.locator(".agent-markdown")).toHaveText(text);
      await expect(page.locator(".katex")).toHaveCount(0);
    }
  }
});

test("long display math scrolls horizontally inside a narrow transcript", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await show(page, { text: "$$\n" + Array.from({ length: 80 }, (_, i) => `x_{${i}}`).join(" + ") + "\n$$" });
  const formula = page.locator(".katex-display");
  await expect(formula).toBeVisible();
  const metrics = await formula.evaluate((el) => {
    el.scrollLeft = 300;
    return { scroll: el.scrollLeft, width: el.clientWidth, content: el.scrollWidth, overflow: getComputedStyle(el).overflowX };
  });
  expect(metrics.overflow).toBe("auto");
  expect(metrics.content).toBeGreaterThan(metrics.width);
  expect(metrics.scroll).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420);
});

test("comparisons and generic prose remain visible during streaming", async ({ page }) => {
  for (const text of ["如果 a<b 则交换，后面还有一整句话", "Use List<T while checking x<y"]) {
    await show(page, { text, streaming: true });
    await expect(page.locator(".agent-markdown")).toHaveText(text);
  }
});

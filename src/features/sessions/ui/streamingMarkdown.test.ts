import { describe, expect, it } from "vitest";
import { parseStreamingMarkdown } from "./streamingMarkdown";

describe("streaming Markdown blocks", () => {
  it("retains completed comparison text while still repairing prose", () => {
    expect(parseStreamingMarkdown("如果 a<b 则交换。")).toEqual([
      "如果 a<b 则交换。",
    ]);
    expect(
      parseStreamingMarkdown("范围 20~25 之间，或 30~40").join(""),
    ).toContain("\\~");
    expect(parseStreamingMarkdown("- > 25").join("")).toContain("\\>");
  });

  it("only hides an unfinished HTML tag in the last streaming block", () => {
    const text = "前文 a<b 则交换。\n\n末尾 <details";
    const streaming = parseStreamingMarkdown(text, { streaming: true });
    expect(streaming[0]).toContain("a<b 则交换。");
    expect(streaming.at(-1)).toBe("末尾");
    expect(parseStreamingMarkdown(text, { streaming: false }).at(-1)).toBe(
      "末尾 <details",
    );
  });

  it("restores the same source when streaming completes", () => {
    const text = "如果 a<b 则交换。";
    expect(parseStreamingMarkdown(text, { streaming: true })).toEqual([
      text,
    ]);
    expect(parseStreamingMarkdown(text, { streaming: false })).toEqual([text]);
  });

  it("closes incomplete emphasis within its paragraph", () => {
    const blocks = parseStreamingMarkdown(
      "First **unfinished\n\nSecond paragraph.",
    );
    expect(blocks[0]).toBe("First **unfinished**");
    expect(blocks.at(-1)).toBe("Second paragraph.");
  });

  it.each([
    "> ```markdown\n> **literal** and [link](url)\n> ```",
    "- Example:\n\n  ```markdown\n  **literal** and [link](url)\n  ```",
  ])("preserves complete code inside a list or blockquote", (source) => {
    // These container blocks still use prose repair. The performance shortcut
    // is deliberately limited to top-level fences, rather than rewriting lists
    // and quotes or treating their surrounding prose as literal code.
    expect(parseStreamingMarkdown(source).join("")).toBe(source);
  });

  it.each(["```", "````", "~~~"])(
    "preserves literal markers in an open or closed %s fence",
    (fence) => {
      const source = `${fence}markdown\n# Prompt\n\n**unfinished emphasis\n[unfinished link](https://example.com\n\`inline code`;
      expect(parseStreamingMarkdown(source)).toEqual([source]);
      const closed = `${source}\n${fence}`;
      expect(parseStreamingMarkdown(closed)).toEqual([closed]);
    },
  );

  it("repairs unfinished prose after a Markdown fence without changing the fence", () => {
    const fence =
      "````markdown\n**literal** and [link](url)\n```ts\nconst x = 1;\n```\n````\n";
    const blocks = parseStreamingMarkdown(
      `Introduction.\n\n${fence}\nThis is **unfinished`,
    );
    expect(blocks.find((block) => block.startsWith("````"))?.trimEnd()).toBe(
      fence.trimEnd(),
    );
    expect(blocks.at(-1)).toBe("This is **unfinished**");
  });

  it("keeps incomplete links and inline code readable while prose streams", () => {
    expect(
      parseStreamingMarkdown("Read [the docs](https://example.com").join(""),
    ).toContain("streamdown:incomplete-link");
    expect(parseStreamingMarkdown("Run `npm test").join("")).toBe(
      "Run `npm test`",
    );
  });

  it("preserves indented fences and content with a shorter nested fence", () => {
    const source =
      "  ````markdown\n# Instructions\n```typescript\nconst x = 1;\n```\n  ````";
    expect(parseStreamingMarkdown(source)).toEqual([source]);
  });
});

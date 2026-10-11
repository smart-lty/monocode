import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import {
  sessionBlocksPage,
  SessionBlocksVersionError,
  type SessionBlocksOptions,
  type SessionBlocksSource,
} from "./sessionBlocks";

function saved(
  blocks: Block[],
  metadata: Partial<SessionBlocksSource> = {},
): SessionBlocksSource {
  return {
    id: "saved-session",
    title: "会话",
    cwd: "/project",
    blocks,
    updatedAt: 100,
    readVersion: "saved-v1",
    ...metadata,
  };
}

function readBlock(
  source: SessionBlocksSource,
  view: SessionBlocksOptions["view"],
  blockId: string,
  maxChars = 201,
  maxTotalChars = 700,
  initialOffset = 0,
) {
  let offset: number | null = initialOffset;
  let text = "";
  let segments = 0;
  do {
    const page = sessionBlocksPage(source, {
      view,
      blockId,
      offset,
      readVersion: source.readVersion,
      maxChars,
      maxTotalChars,
    });
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(maxTotalChars);
    expect(page.blocks).toHaveLength(1);
    expect(page.nextBefore).toBeNull();
    const part = page.blocks[0];
    expect(part.offset).toBe(offset);
    expect(part.text.length).toBeLessThanOrEqual(maxChars);
    expect(part.text).not.toMatch(/\p{Surrogate}/u);
    if (part.nextOffset !== null) {
      expect(part.nextOffset).toBe(offset + part.text.length);
      expect(part.nextOffset).toBeGreaterThan(offset);
      expect(part.truncated).toBe(true);
    } else {
      expect(part.offset + part.text.length).toBe(part.totalChars);
      expect(part.truncated).toBe(false);
    }
    text += part.text;
    offset = part.nextOffset;
    expect(++segments).toBeLessThan(5000);
  } while (offset !== null);
  return text;
}

describe("saved session block reads", () => {
  it("keeps every assistant message and uses exclusive older-page cursors", () => {
    const source = saved([
      { id: "u", role: "user", text: "request" },
      { id: "a", role: "assistant", text: "progress" },
      { id: "t", role: "tool", text: "result" },
      { id: "p", role: "plan", text: "plan" },
      { id: "b", role: "assistant", text: "answer" },
    ]);
    const recent = sessionBlocksPage(source, { view: "messages", limit: 2 });
    expect(recent.blocks.map((block) => block.id)).toEqual(["a", "b"]);
    expect(recent.nextBefore).toBe("a");
    const older = sessionBlocksPage(source, {
      view: "messages",
      before: recent.nextBefore!,
      readVersion: recent.readVersion,
    });
    expect(older.blocks.map((block) => block.id)).toEqual(["u"]);
    expect(older.nextBefore).toBeNull();
    expect(older.truncated).toBe(false);
    expect(
      sessionBlocksPage(source, { view: "messages", before: "u" }).blocks,
    ).toEqual([]);
    expect(
      sessionBlocksPage(source, { view: "blocks", limit: 2 }).blocks.map(
        (block) => block.id,
      ),
    ).toEqual(["p", "b"]);
  });

  const longText =
    '中文 😀🚀 🇨🇳 👩🏽‍💻 é "引号" \\ \n\t\u0000'.repeat(2000) + "末尾🏁";
  it.each(["user", "assistant", "plan"] as const)(
    "reconstructs very long %s text with Chinese, emoji and escaped characters",
    (role) => {
      const source = saved([{ id: "long", role, text: longText }]);
      expect(
        readBlock(source, role === "plan" ? "blocks" : "messages", "long"),
      ).toBe(longText);
    },
  );

  it("reconstructs tool title, arguments, result and detail in one offset space", () => {
    const input = "printf '中文🚀'\n".repeat(1500);
    const result = "工具结果✅\n".repeat(800);
    const detail = "补充😀".repeat(700);
    const source = saved([
      {
        id: "tool",
        role: "tool",
        text: result,
        tool: { title: "Shell", input, detail, kind: "shell", status: "done" },
      },
      { id: "plan", role: "plan", text: "计划原文", plan: { status: "ready" } },
    ]);
    expect(readBlock(source, "blocks", "tool")).toBe(
      `Shell\n\n${input}\n\n${result}\n\n${detail}`,
    );
    const page = sessionBlocksPage(source, { view: "blocks" });
    expect(page.blocks[0].tool).toEqual({ kind: "shell", status: "done" });
    expect(page.blocks[1]).toMatchObject({
      text: "计划原文",
      plan: { status: "ready" },
    });
  });

  it("does not split an emoji at the per-block cap or accept an interior offset", () => {
    const text = "中".repeat(199) + "😀结束";
    const source = saved([{ id: "emoji", role: "assistant", text }]);
    const first = sessionBlocksPage(source, {
      view: "messages",
      blockId: "emoji",
      maxChars: 200,
    });
    expect(first.offsetUnit).toBe("utf-16");
    expect(first.blocks[0].text).toBe("中".repeat(199));
    expect(first.blocks[0].nextOffset).toBe(199);
    expect(readBlock(source, "messages", "emoji", 200)).toBe(text);
    expect(() =>
      sessionBlocksPage(source, {
        view: "messages",
        blockId: "emoji",
        offset: 200,
        readVersion: source.readVersion,
      }),
    ).toThrow(/character boundary/);
    const end = sessionBlocksPage(source, {
      view: "messages",
      blockId: "emoji",
      offset: text.length,
      readVersion: source.readVersion,
    }).blocks[0];
    expect(end).toMatchObject({ text: "", nextOffset: null, truncated: false });
    expect(() =>
      sessionBlocksPage(source, {
        view: "messages",
        blockId: "emoji",
        offset: text.length + 1,
        readVersion: source.readVersion,
      }),
    ).toThrow(/within the block/);
  });

  it("advances by a complete pair at an all-emoji minimum budget or fails explicitly", () => {
    const source = saved([
      { id: "emoji", role: "assistant", text: "😀".repeat(1000) },
    ]);
    for (const offset of [0, 2, 198]) {
      const options = {
        view: "messages" as const,
        blockId: "emoji",
        offset,
        readVersion: source.readVersion,
        maxChars: 200,
      };
      const probe = sessionBlocksPage(source, options);
      const expected = {
        ...probe,
        blocks: [{ ...probe.blocks[0], text: "😀", nextOffset: offset + 2 }],
      };
      const pairBudget = JSON.stringify(expected).length;
      const page = sessionBlocksPage(source, {
        ...options,
        maxTotalChars: pairBudget,
      });
      expect(page).toEqual(expected);
      expect(page.blocks[0].nextOffset).toBeGreaterThan(offset);
      expect(JSON.stringify(page).length).toBe(pairBudget);
      expect(() =>
        sessionBlocksPage(source, { ...options, maxTotalChars: pairBudget - 1 }),
      ).toThrow(/maxTotalChars cannot fit block metadata and one character/);
    }
  });

  it("bounds Chinese JSON output to 60000 UTF-8 bytes at the 20000-unit cap", () => {
    const source = saved(
      ["a", "b"].map((id): Block => ({
        id,
        role: "assistant",
        text: "中".repeat(12000),
      })),
      { title: "Chinese" },
    );
    const page = sessionBlocksPage(source, {
      view: "messages",
      maxChars: 12000,
      maxTotalChars: 20000,
    });
    const json = JSON.stringify(page);
    const bytes = new TextEncoder().encode(json).byteLength;
    const chineseUnits = page.blocks.reduce(
      (sum, block) => sum + block.text.length,
      0,
    );
    expect(json.length).toBe(20000);
    expect(bytes).toBe(json.length + 2 * chineseUnits);
    expect(bytes).toBeGreaterThan(20000);
    expect(bytes).toBeLessThanOrEqual(60000);
  });

  it("includes escaped metadata and text in the exact serialized page budget", () => {
    const text = '\\"中文😀\n'.repeat(100);
    const source = saved([{ id: "quoted", role: "user", text }], {
      title: '\\"标题\n'.repeat(30),
      cwd: '/项目/带"引号\\路径',
      readVersion: 'persisted-"revision"',
    });
    const full = sessionBlocksPage(source, { view: "blocks" });
    const exactBudget = JSON.stringify(full).length;
    const exact = sessionBlocksPage(source, {
      view: "blocks",
      maxTotalChars: exactBudget,
    });
    expect(exact).toEqual(full);
    const smaller = sessionBlocksPage(source, {
      view: "blocks",
      maxTotalChars: exactBudget - 1,
    });
    expect(JSON.stringify(smaller).length).toBeLessThan(exactBudget);
    expect(smaller.blocks[0].nextOffset).not.toBeNull();
    expect(smaller.blocks[0].text.length).toBeLessThan(text.length);
    expect(readBlock(source, "blocks", "quoted", 12000, 900)).toBe(text);
  });

  it("traverses budget-limited pages and restores every truncated block once", () => {
    const blocks: Block[] = Array.from({ length: 41 }, (_, index) => ({
      id: `block-${index}`,
      role: index % 2 ? "assistant" : "user",
      text: `第${index}块: ` + '中文😀"\n'.repeat(100),
    }));
    const source = saved(blocks);
    let before: string | undefined;
    let restored: { id: string; text: string }[] = [];
    let pages = 0;
    do {
      const page = sessionBlocksPage(source, {
        view: "messages",
        before,
        limit: 30,
        maxChars: 12000,
        maxTotalChars: 900,
        readVersion: source.readVersion,
      });
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(900);
      expect(page.blocks.length).toBeGreaterThan(0);
      expect(page.blocks.length).toBeLessThan(30);
      if (page.nextBefore !== null)
        expect(page.nextBefore).toBe(page.blocks[0].id);
      restored = [
        ...page.blocks.map((part) => {
          const tail =
            part.nextOffset === null
              ? ""
              : readBlock(
                  source,
                  "messages",
                  part.id,
                  201,
                  700,
                  part.nextOffset,
                );
          return { id: part.id, text: part.text + tail };
        }),
        ...restored,
      ];
      before = page.nextBefore ?? undefined;
      expect(++pages).toBeLessThanOrEqual(blocks.length);
    } while (before !== undefined);
    expect(restored).toEqual(blocks.map(({ id, text }) => ({ id, text })));
    expect(new Set(restored.map((block) => block.id)).size).toBe(blocks.length);
  });

  it("fails explicitly when metadata cannot fit instead of omitting it", () => {
    expect(() =>
      sessionBlocksPage(saved([], { title: "元数据".repeat(1000) }), {
        view: "messages",
        maxTotalChars: 500,
      }),
    ).toThrow(/session metadata/);
    expect(() =>
      sessionBlocksPage(
        saved([
          {
            id: "huge-meta",
            role: "tool",
            text: "result",
            tool: { kind: "metadata".repeat(1000) },
          },
        ]),
        { view: "blocks", maxTotalChars: 500 },
      ),
    ).toThrow(/block metadata/);
  });

  it.each(["messages", "blocks"] as const)(
    "excludes draft and internal content from %s and rejects their IDs",
    (view) => {
      const source = saved([
        { id: "draft", role: "user", text: "secret draft", draft: true },
        { id: "internal", role: "assistant", text: "private", internal: true },
        { id: "visible", role: "assistant", text: "sent" },
      ]);
      expect(sessionBlocksPage(source, { view }).blocks.map((b) => b.id)).toEqual(
        ["visible"],
      );
      for (const id of ["draft", "internal", "missing"]) {
        expect(() =>
          sessionBlocksPage(source, { view, blockId: id }),
        ).toThrow(/not in this view/);
        expect(() =>
          sessionBlocksPage(source, { view, before: id }),
        ).toThrow(/not in this view/);
      }
    },
  );

  it("rejects old versions after an edit or append and reports the saved revision", () => {
    const original = saved([{ id: "a", role: "assistant", text: longText }]);
    const first = sessionBlocksPage(original, { view: "messages", maxChars: 200 });
    const changed = saved(
      [
        { id: "a", role: "assistant", text: "modified" },
        { id: "b", role: "user", text: "new request" },
      ],
      { updatedAt: 101, readVersion: "saved-v2" },
    );
    try {
      sessionBlocksPage(changed, {
        view: "messages",
        blockId: "a",
        offset: first.blocks[0].nextOffset!,
        readVersion: first.readVersion,
      });
      expect.fail("must not splice different saved revisions");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionBlocksVersionError);
      expect(error).toMatchObject({
        code: "SESSION_READ_VERSION_MISMATCH",
        expectedReadVersion: "saved-v1",
        actualReadVersion: "saved-v2",
        updatedAt: 101,
        message: expect.stringContaining("offset=0"),
      });
    }
    expect(() =>
      sessionBlocksPage(changed, {
        view: "messages",
        before: "b",
        readVersion: "saved-v1",
      }),
    ).toThrow(SessionBlocksVersionError);
    const latest = sessionBlocksPage(changed, { view: "messages", before: "b" });
    expect(latest.readVersion).toBe("saved-v2");
    expect(latest.blocks[0].text).toBe("modified");
    expect(latest.updatedAt).toBe(101);
  });

  it("requires a persisted version and pinned nonzero block offsets", () => {
    const source = saved([{ id: "a", role: "assistant", text: "answer" }]);
    expect(() =>
      sessionBlocksPage({ ...source, readVersion: "" }, { view: "messages" }),
    ).toThrow(/saved readVersion/);
    expect(() =>
      sessionBlocksPage(source, { view: "messages", blockId: "a", offset: 1 }),
    ).toThrow(/readVersion is required/);
    expect(() =>
      sessionBlocksPage(source, {
        view: "messages",
        offset: 1,
        readVersion: source.readVersion,
      }),
    ).toThrow(/offset requires blockId/);
    expect(() =>
      sessionBlocksPage(source, { view: "messages", blockId: "a", before: "a" }),
    ).toThrow(/cannot be combined/);
    expect(() =>
      sessionBlocksPage(saved([], { updatedAt: NaN }), { view: "messages" }),
    ).toThrow(/saved updatedAt/);
  });

  it.each([
    { limit: 0 },
    { limit: 31 },
    { limit: 1.5 },
    { maxChars: 199 },
    { maxChars: 12001 },
    { maxTotalChars: 199 },
    { maxTotalChars: 20001 },
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { before: "" },
    { blockId: "" },
    { readVersion: "" },
  ])("rejects invalid options %j", (options) => {
    expect(() =>
      sessionBlocksPage(saved([]), { view: "messages", ...options }),
    ).toThrow();
  });

  it("preserves empty text and reads frozen records without modifying them", () => {
    const source = saved([
      { id: "empty", role: "user", text: "" },
      { id: "spaces", role: "assistant", text: " \n " },
    ]);
    const snapshot = JSON.stringify(source);
    source.blocks.forEach(Object.freeze);
    Object.freeze(source.blocks);
    Object.freeze(source);
    const page = sessionBlocksPage(source, { view: "messages" });
    expect(page.blocks.map((block) => block.text)).toEqual(["", " \n "]);
    expect(page.blocks.every((block) => block.nextOffset === null)).toBe(true);
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(sessionBlocksPage(saved([]), { view: "blocks" })).toMatchObject({
      blocks: [],
      nextBefore: null,
      truncated: false,
      readVersion: "saved-v1",
    });
  });
});

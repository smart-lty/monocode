// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { sanitizeSessionForPersist, getSession } from "../data/sessionStore";
import { invoke } from "@tauri-apps/api/core";
import { newSession, type Block } from "./session";
import {
  sessionBlocksPage,
  type SessionBlocksOptions,
} from "../../agent-app/model/sessionBlocks";
import {
  getComposerSessionReferences,
  setComposerSessionReferences,
  clearComposerDraft,
} from "./draftCache";
import {
  prepareSessionReferenceTurn,
  quoteShellArgument,
  referencedSessionIds,
  sanitizeSessionReferences,
  sentSessionReferences,
  SESSION_REFERENCE_MAX_CHARS,
  type SessionReference,
  type SessionReferenceSnapshot,
} from "./sessionReferences";

const ref: SessionReference = {
  sessionId: "source",
  title: "计划 ' 与中文",
  cwd: "/other project/'quoted",
  harness: "codex",
};
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const snapshot = (id = ref.sessionId): SessionReferenceSnapshot => ({
  id,
  title: ref.title,
  cwd: ref.cwd,
  harness: "codex",
  model: "codex:test",
  updatedAt: 42,
  readVersion: "revision-42",
  blocks: [
    { id: "first", role: "user", text: "最初需求可能要修改。".repeat(2000) },
    { id: "secret", role: "user", text: "hidden old task", internal: true },
    { id: "draft", role: "user", text: "unsent correction", draft: true },
    { id: "revision", role: "user", text: "修订：按照最新文件处理。" },
    { id: "answer", role: "assistant", text: "近期结论。".repeat(2000) },
  ],
});
const host = {
  cliPath: vi.fn(
    async () => "/Applications/Mono Code's.app/Contents/MacOS/monocode",
  ),
  snapshot: vi.fn(async (id: string) => snapshot(id)),
};

type InjectedExcerpt = {
  sessionId: string;
  blockId: string;
  view: "messages";
  readVersion: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
  text: string;
};
const excerpts = (context: string): InjectedExcerpt[] =>
  context
    .split("\n")
    .filter((line) => line.startsWith("摘录 JSON："))
    .map((line) => JSON.parse(line.slice("摘录 JSON：".length)));
function readCommands(
  context: string,
): (SessionBlocksOptions & { sessionId: string })[] {
  return context
    .split("\n")
    .filter(
      (line) =>
        /^(读取|工具\/计划|定位|补读)/.test(line) &&
        line.includes(" app sessions.read --json "),
    )
    .map((line) => {
      const command = line.slice(line.indexOf("：") + 1);
      // Parse the exact executable command with a real shell, without executing its CLI.
      const argv = execFileSync(
        "/bin/sh",
        ["-c", `set -- ${command}; printf '%s\\n' "$@"`],
        { encoding: "utf8" },
      )
        .trimEnd()
        .split("\n");
      expect(argv.slice(0, 4)).toEqual([
        "/Applications/Mono Code's.app/Contents/MacOS/monocode",
        "app",
        "sessions.read",
        "--json",
      ]);
      return JSON.parse(argv[4]);
    });
}
function reconstruct(
  source: SessionReferenceSnapshot,
  part: InjectedExcerpt,
  commands: ReturnType<typeof readCommands>,
): string {
  let text = part.text;
  expect(part.sessionId).toBe(source.id);
  expect(part.offset).toBe(0);
  expect(part.totalChars).toBe(
    source.blocks.find((block) => block.id === part.blockId)!.text.length,
  );
  if (part.nextOffset === null) return text;
  const command = commands.find(
    (input) =>
      input.sessionId === part.sessionId &&
      input.blockId === part.blockId &&
      input.view === part.view &&
      input.offset === part.nextOffset,
  );
  expect(command).toBeDefined();
  expect(command!.readVersion).toBe(part.readVersion);
  expect(command!.offset).toBe(text.length);
  let input = command!;
  while (true) {
    const page = sessionBlocksPage(source, input);
    const slice = page.blocks[0];
    expect(slice.offset).toBe(text.length);
    text += slice.text;
    if (slice.nextOffset === null) return text;
    input = { ...input, offset: slice.nextOffset };
  }
}

describe("sent session references", () => {
  it("sanitizes, deduplicates and excludes drafts, queues, internal and non-user blocks from authority", () => {
    expect(
      sanitizeSessionReferences([
        ref,
        ref,
        { ...ref, sessionId: "../../private" },
        { ...ref, harness: "unknown" },
        { ...ref, cwd: " " },
      ]),
    ).toEqual([ref]);
    const blocks: Block[] = [
      {
        id: "draft",
        role: "user",
        text: "",
        draft: true,
        sessionReferences: [ref],
      },
      {
        id: "internal",
        role: "user",
        text: "",
        internal: true,
        sessionReferences: [ref],
      },
      { id: "quoted", role: "assistant", text: "", sessionReferences: [ref] },
    ];
    expect(referencedSessionIds(blocks)).toEqual([]);
    blocks.push({
      id: "sent",
      role: "user",
      text: "compare",
      sessionReferences: [ref, ref],
    });
    expect(sentSessionReferences(blocks)).toEqual([ref]);
  });

  it("round trips user and unsent queue references without promoting queued authority", async () => {
    const session = {
      ...newSession("codex", "/current"),
      blocks: [
        {
          id: "sent",
          role: "user" as const,
          text: "compare",
          sessionReferences: [ref],
        },
      ],
      queuedMessages: [
        {
          id: "queue",
          text: "later",
          attachments: [],
          sessionReferences: [{ ...ref, sessionId: "later" }],
        },
      ],
    };
    const persisted = sanitizeSessionForPersist(session);
    expect(persisted.blocks[0].sessionReferences).toEqual([ref]);
    expect(persisted.queuedMessages?.[0].sessionReferences?.[0].sessionId).toBe(
      "later",
    );
    vi.mocked(invoke).mockResolvedValueOnce({
      ...persisted,
      createdAt: 1,
      updatedAt: 2,
    });
    const restored = (await getSession(session.id))!;
    expect(referencedSessionIds(restored.blocks)).toEqual(["source"]);
    expect(restored.queuedMessages?.[0].sessionReferences?.[0].sessionId).toBe(
      "later",
    );
    setComposerSessionReferences(session.id, [ref, ref]);
    expect(getComposerSessionReferences(session.id)).toEqual([ref]);
    clearComposerDraft(session.id);
    expect(getComposerSessionReferences(session.id)).toEqual([]);
  });

  it("quotes CLI paths and JSON independently for a real POSIX shell", () => {
    for (const text of [
      "a'b",
      "$(printf changed) `printf changed` \\ 中文",
      JSON.stringify(ref),
    ]) {
      const output = execFileSync(
        "/bin/sh",
        ["-c", `set -- ${quoteShellArgument(text)}; printf '%s' "$1"`],
        { encoding: "utf8" },
      );
      expect(output).toBe(text);
    }
  });

  it("gives new sources first/last excerpts, revision warning, actual CLI and executable lossless commands", async () => {
    const result = await prepareSessionReferenceTurn(
      { sessionId: "current", blocks: [], added: [ref], prompt: "继续" },
      host,
    );
    expect(result.context).toContain("首次需求可能已");
    expect(result.context).toContain("最初需求可能要修改");
    expect(result.context).toContain("修订：按照最新文件处理");
    expect(result.context).toContain("近期结论");
    expect(result.context).toContain("更新时间=42");
    expect(result.context).toContain(" app sessions.read --json ");
    expect(result.context).toContain('"view":"blocks"');
    expect(result.context).toContain('"readVersion":"revision-42"');
    expect(result.context).toContain("session_references");
    expect(result.context).not.toContain("hidden old task");
    expect(result.context).not.toContain("unsent correction");
    expect(result.context.length).toBeLessThanOrEqual(
      SESSION_REFERENCE_MAX_CHARS,
    );
  });

  it("reconstructs FIRST/LAST exactly from the actual default-budget excerpt and its parsed continuation", async () => {
    const source = {
      ...snapshot(),
      blocks: [
        { id: "first", role: "user" as const, text: "FIRST".repeat(1000) },
        { id: "last", role: "assistant" as const, text: "LAST".repeat(1000) },
      ],
    };
    const result = await prepareSessionReferenceTurn(
      { sessionId: "current", blocks: [], added: [ref], prompt: "compare" },
      { ...host, snapshot: async () => source },
    );
    const parts = excerpts(result.context),
      commands = readCommands(result.context);
    expect(parts.map((part) => part.blockId)).toEqual(["first", "last"]);
    for (const part of parts) {
      expect(part.text.length).toBeGreaterThan(200);
      expect(reconstruct(source, part, commands)).toBe(
        source.blocks.find((block) => block.id === part.blockId)!.text,
      );
    }
    expect(commands.some((command) => command.offset === 200)).toBe(false);
  });

  it("keeps emoji pairs, JSON escaping and every selected block's exact cutoff, and reads unshown history from page one", async () => {
    const source = {
      ...snapshot(),
      blocks: Array.from({ length: 9 }, (_, index) => ({
        id: `block-${index}`,
        role: index % 2 ? ("assistant" as const) : ("user" as const),
        text: `段${index}😀\"\\\n`.repeat(1600),
      })),
    };
    const result = await prepareSessionReferenceTurn(
      { sessionId: "current", blocks: [], added: [ref], prompt: "compare" },
      { ...host, snapshot: async () => source },
    );
    const parts = excerpts(result.context),
      commands = readCommands(result.context);
    expect(parts.map((part) => part.blockId)).toEqual([
      "block-0",
      "block-6",
      "block-7",
      "block-8",
    ]);
    for (const part of parts) {
      expect(part.text).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(reconstruct(source, part, commands)).toBe(
        source.blocks.find((block) => block.id === part.blockId)!.text,
      );
    }
    expect(commands.every((command) => command.before === undefined)).toBe(
      true,
    );
    let input = commands.find(
      (command) => command.view === "messages" && !command.blockId,
    )!;
    const all: string[] = [];
    while (true) {
      const page = sessionBlocksPage(source, input);
      all.unshift(...page.blocks.map((block) => block.id));
      if (page.nextBefore === null) break;
      input = {
        ...input,
        before: page.nextBefore,
        readVersion: page.readVersion,
      };
    }
    expect(all).toEqual(source.blocks.map((block) => block.id));
    expect(result.context.length).toBeLessThanOrEqual(8000);
  });

  it.each([100, 800, 1800, 2500, 4500])(
    "never skips undisplayed text when the entire command and excerpt budget is %i",
    async (maxChars) => {
      const source = snapshot();
      const result = await prepareSessionReferenceTurn(
        {
          sessionId: "current",
          blocks: [],
          added: [ref],
          prompt: "compare",
          maxChars,
        },
        { ...host, snapshot: async () => source },
      );
      const parts = excerpts(result.context),
        commands = readCommands(result.context);
      expect(result.context.length).toBeLessThanOrEqual(maxChars);
      for (const command of commands.filter(
        (input) => (input.offset ?? 0) > 0,
      )) {
        const part = parts.find(
          (item) =>
            item.blockId === command.blockId && item.view === command.view,
        );
        expect(part).toBeDefined();
        expect(command.offset).toBe(part!.text.length);
      }
      for (const part of parts)
        expect(reconstruct(source, part, commands)).toBe(
          source.blocks.find((block) => block.id === part.blockId)!.text,
        );
      expect(commands.every((command) => command.before === undefined)).toBe(
        true,
      );
    },
  );

  it("starts old-source directory locators at offset=0 and shows no fabricated page or body", async () => {
    const source = snapshot();
    const result = await prepareSessionReferenceTurn(
      {
        sessionId: "current",
        blocks: [
          { id: "sent", role: "user", text: "old", sessionReferences: [ref] },
        ],
        prompt: "next",
      },
      { ...host, snapshot: async () => source },
    );
    expect(excerpts(result.context)).toEqual([]);
    expect(result.context).toContain("非摘录续读，从 offset=0 读取本块");
    const commands = readCommands(result.context);
    expect(
      commands.every(
        (command) =>
          (command.offset ?? 0) === 0 && command.before === undefined,
      ),
    ).toBe(true);
    const locator = commands.find((command) => command.blockId)!;
    expect(sessionBlocksPage(source, locator).blocks[0].text).toBe(
      source.blocks.at(-1)!.text.slice(0, 4000),
    );
  });

  it("shares the budget between multiple sources' real excerpts and matching commands", async () => {
    const added = ["source-a", "source-b"].map((sessionId) => ({
      ...ref,
      sessionId,
    }));
    const sources = added.map((reference) => ({
      ...snapshot(reference.sessionId),
      blocks: [
        {
          id: "first",
          role: "user" as const,
          text: `${reference.sessionId}😀 first `.repeat(1000),
        },
        {
          id: "last",
          role: "assistant" as const,
          text: `${reference.sessionId}😀 last `.repeat(1000),
        },
      ],
    }));
    const result = await prepareSessionReferenceTurn(
      {
        sessionId: "current",
        blocks: [],
        added,
        prompt: "compare",
        maxChars: 8000,
      },
      {
        ...host,
        snapshot: async (id) => sources.find((source) => source.id === id)!,
      },
    );
    const parts = excerpts(result.context),
      commands = readCommands(result.context);
    expect(parts).toHaveLength(4);
    expect(result.context.length).toBeLessThanOrEqual(8000);
    for (const part of parts) {
      const source = sources.find((value) => value.id === part.sessionId)!;
      expect(part.text.length).toBeGreaterThan(0);
      expect(part.text).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(reconstruct(source, part, commands)).toBe(
        source.blocks.find((block) => block.id === part.blockId)!.text,
      );
    }
  });

  it.each([
    "normal follow-up",
    "hydrate/resume",
    "Build approved plan",
    "model switch",
    "harness switch",
    "post-compaction",
  ])(
    "rebuilds a brief directory at %s without replaying saved tasks or approvals",
    async (prompt) => {
      const blocks: Block[] = [
        {
          id: "sent",
          role: "user",
          text: "obsolete task",
          sessionReferences: [ref],
        },
        {
          id: "approval",
          role: "approval",
          text: "old approved task",
          approval: { requestId: 99, decided: "allow" },
        },
      ];
      const result = await prepareSessionReferenceTurn(
        { sessionId: "current", blocks, prompt },
        host,
      );
      expect(result.references).toEqual([ref]);
      expect(result.context).toContain("来源 ID=source");
      expect(result.context).not.toContain("最初需求可能要修改");
      expect(result.context).not.toContain("obsolete task");
      expect(result.context).not.toContain("old approved task");
    },
  );

  it("shares a hard budget across directories, labels and bodies with a paginated overflow directory", async () => {
    const added = Array.from({ length: 40 }, (_, i) => ({
      ...ref,
      sessionId: `source-${i}`,
      title: "中文很长标题".repeat(100),
    }));
    const prompt = "当前已批准计划".repeat(300);
    const result = await prepareSessionReferenceTurn(
      { sessionId: "current", blocks: [], added, prompt, maxChars: 4500 },
      host,
    );
    expect(result.context.length).toBeLessThanOrEqual(4500);
    expect(result.references).toHaveLength(40);
    expect(result.omittedSources).toBeGreaterThan(0);
    expect(result.context).toContain("app sessions.references");
    const limited = await prepareSessionReferenceTurn(
      {
        sessionId: "current",
        blocks: [],
        added: [ref],
        prompt,
        contextWindowTokens: prompt.length + 1000,
      },
      host,
    );
    expect(limited.context.length).toBeLessThanOrEqual(50);
    expect(prompt).toBe("当前已批准计划".repeat(300));
  });

  it("leaves native slash syntax untouched, and explicitly marks missing sources", async () => {
    const native = await prepareSessionReferenceTurn(
      {
        sessionId: "current",
        blocks: [],
        added: [ref],
        prompt: "/compact original args",
        nativeCommand: true,
      },
      host,
    );
    expect(native.context).toBe("");
    const missing = await prepareSessionReferenceTurn(
      { sessionId: "current", blocks: [], added: [ref], prompt: "continue" },
      { ...host, snapshot: async () => null },
    );
    expect(missing.context).toContain("来源已删除或不可读");
  });
});

// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...original,
    invoke: (command: string, args?: Record<string, unknown>) =>
      command === "session_reference_snapshot"
        ? snapshot(args?.sessionId)
        : original.invoke(command, args),
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import { Composer } from "./Composer";
import type {
  SessionReferenceCandidate,
  SessionReferenceCandidatesPage,
  SessionReferencePickerOptions,
} from "../data/sessionStore";
import type { SessionReference } from "../model/sessionReferences";
import type { Attachment, ComposerTurnOptions } from "../model/session";
import { SESSION_REFERENCE_DROP } from "../model/sessionReferenceDrop";
import { clearComposerDraft, setComposerMcpTags } from "../model/draftCache";
import { newMcpTag } from "../model/mcpPicker";
import { copyMessage } from "../../../platform/tauri/clipboard";

const candidate = (
  id: string,
  title = `Session ${id}`,
  cwd = "/repo",
): SessionReferenceCandidate => ({
  sessionId: id,
  title,
  cwd,
  harness: "codex",
  model: "gpt-5",
  updatedAt: Date.now() - 60_000,
  userTurnCount: 3,
  relevance: 0,
});

type Loader = (
  options: SessionReferencePickerOptions,
) => Promise<SessionReferenceCandidatesPage>;

let container: HTMLDivElement;
let root: Root;
let references: SessionReference[];
let submit: ReturnType<
  typeof vi.fn<
    (
      text: string,
      attachments: Attachment[],
      options?: ComposerTurnOptions,
    ) => boolean | void
  >
>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  references = [];
  submit = vi.fn();
  snapshot.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Mirrors SessionPane: the cached draft comes back as initialDraft whenever
 * the pane re-renders, e.g. for a new reference card. */
function Harness({
  loader,
  initialDraft,
  sessionId = "current",
}: {
  loader?: Loader;
  initialDraft?: string;
  sessionId?: string;
}) {
  const [value, setValue] = useState<SessionReference[]>([]);
  const draft = useRef<string | undefined>(initialDraft);
  return createElement(Composer, {
    initialDraft: draft.current,
    onDraftChange: (text: string) => {
      draft.current = text;
    },
    focused: true,
    harness: "claude",
    model: "claude-sonnet",
    runtimeMode: "supervised",
    cwd: "/repo",
    executionCwd: "/repo/.worktrees/feature",
    sessionId,
    hideTopBar: true,
    sessionReferences: value,
    onSessionReferencesChange: (next: SessionReference[]) => {
      references = next;
      setValue(next);
    },
    onSearchSessionReferences: loader,
    onFocus: () => {},
    onCwdChange: () => {},
    onModelChange: () => {},
    onRuntimeModeChange: () => {},
    onSubmit: submit,
  });
}

async function render(
  loader?: Loader,
  initialDraft?: string,
  sessionId?: string,
) {
  await act(async () =>
    root.render(createElement(Harness, { loader, initialDraft, sessionId })),
  );
  return container.querySelector("textarea")!;
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });

async function type(
  textarea: HTMLTextAreaElement,
  value: string,
  caret = value.length,
) {
  await act(async () => {
    textarea.value = value;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
  await settle();
}

async function key(
  textarea: HTMLTextAreaElement,
  name: string,
  init: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => {
    textarea.dispatchEvent(event);
    textarea.dispatchEvent(
      new KeyboardEvent("keyup", { key: name, bubbles: true }),
    );
  });
  return event;
}

const picker = () => container.querySelector("[data-session-reference-picker]");
const options = () =>
  Array.from(container.querySelectorAll('[role="option"]')).map(
    (node) => node.textContent ?? "",
  );
const activeOption = (textarea: HTMLTextAreaElement) => {
  const id = textarea.getAttribute("aria-activedescendant");
  return id ? (document.getElementById(id)?.textContent ?? "") : null;
};
const chips = () =>
  Array.from(
    container.querySelectorAll("[data-session-reference-chips] li"),
  ).map((node) => node.textContent ?? "");

describe("Composer # session references", () => {
  it("lists this project with # and all projects with ##, without preselecting", async () => {
    const loader = vi.fn<Loader>(async () => ({
      items: [candidate("a", "Fix IME"), candidate("b", "Search")],
      nextCursor: null,
    }));
    const textarea = await render(loader);
    await type(textarea, "hello #");
    expect(picker()).not.toBeNull();
    expect(loader).toHaveBeenLastCalledWith(
      expect.objectContaining({
        currentSessionId: "current",
        projectCwd: "/repo",
        scope: "project",
        query: "",
        search: "title",
      }),
    );
    expect(options()).toHaveLength(2);
    expect(activeOption(textarea)).toBeNull();

    await type(textarea, "hello ##");
    expect(loader).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: "all", query: "" }),
    );
    expect(
      container.querySelector('[aria-pressed="true"]')?.textContent,
    ).toContain("All projects");

    // Backspace: ## → # → closed.
    await type(textarea, "hello #");
    expect(loader).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: "project" }),
    );
    await type(textarea, "hello ");
    expect(picker()).toBeNull();
  });

  it("adds a card on Enter, removes the token and keeps the rest of the draft", async () => {
    const loader = vi.fn<Loader>(async ({ query }) => ({
      items: query === "fix" ? [candidate("a", "Fix IME")] : [],
      nextCursor: null,
    }));
    const textarea = await render(loader);
    await type(textarea, "compare #fix with this", 12);
    expect(activeOption(textarea)).toContain("Fix IME");
    const enter = await key(textarea, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("compare with this");
    expect(textarea.selectionStart).toBe(8);
    expect(references.map((ref) => ref.sessionId)).toEqual(["a"]);
    expect(chips()[0]).toContain("Fix IME");
    expect(picker()).toBeNull();

    // Same session again by Tab: still one card.
    await type(textarea, "compare #fix with this", 12);
    const tab = await key(textarea, "Tab");
    expect(tab.defaultPrevented).toBe(true);
    expect(references).toHaveLength(1);

    // Remove with ×, then send references alone.
    await act(async () =>
      (
        container.querySelector(
          '[aria-label="Remove reference Fix IME"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(references).toEqual([]);
    expect(chips()).toEqual([]);
  });

  it("sends selected references with the message", async () => {
    const loader = vi.fn<Loader>(async () => ({
      items: [candidate("a", "Fix IME", "/other")],
      nextCursor: null,
    }));
    const textarea = await render(loader);
    await type(textarea, "##fix");
    await key(textarea, "Enter");
    await type(textarea, "continue");
    await key(textarea, "Enter");
    expect(submit).toHaveBeenCalledWith(
      "continue",
      [],
      expect.objectContaining({
        sessionReferences: [
          { sessionId: "a", title: "Fix IME", cwd: "/other", harness: "codex" },
        ],
      }),
    );
    expect(references).toEqual([]);
  });

  it("keeps Enter and Tab for colors, issue numbers and unselected rows", async () => {
    const loader = vi.fn<Loader>(async () => ({
      items: [candidate("a", "Theme fff")],
      nextCursor: null,
    }));
    const textarea = await render(loader);
    await type(textarea, "color #fff");
    expect(picker()).not.toBeNull();
    expect(activeOption(textarea)).toBeNull();
    const tab = await key(textarea, "Tab");
    expect(tab.defaultPrevented).toBe(false);
    await key(textarea, "Enter");
    expect(submit).toHaveBeenCalledWith("color #fff", [], expect.anything());
    expect(references).toEqual([]);
  });

  it("does not open for headings, ###, code or when references are unavailable", async () => {
    const loader = vi.fn<Loader>(async () => ({ items: [], nextCursor: null }));
    const textarea = await render(loader);
    for (const text of [
      "# Title",
      "## 小节",
      "###",
      "```\n#include",
      "a `#x",
      "see ``code #query",
    ]) {
      await type(textarea, text);
      expect(picker()).toBeNull();
    }
    expect(loader).not.toHaveBeenCalled();

    const plain = await render(undefined);
    await type(plain, "#fix");
    expect(picker()).toBeNull();
  });

  it("Escape closes the token for good; a new token opens again", async () => {
    const loader = vi.fn<Loader>(async () => ({
      items: [candidate("a")],
      nextCursor: null,
    }));
    const textarea = await render(loader);
    await type(textarea, "#ab");
    expect(picker()).not.toBeNull();
    await key(textarea, "Escape");
    expect(picker()).toBeNull();
    await type(textarea, "#abc");
    expect(picker()).toBeNull();
    await type(textarea, "#abc #x");
    expect(picker()).not.toBeNull();
  });

  it("ignores an older response that arrives after a newer query", async () => {
    const pending = new Map<
      string,
      (page: SessionReferenceCandidatesPage) => void
    >();
    const loader = vi.fn<Loader>(
      ({ query }) =>
        new Promise((resolve) => pending.set(query ?? "", resolve)),
    );
    const textarea = await render(loader);
    await type(textarea, "#xy");
    await type(textarea, "#xyz");
    await act(async () => {
      pending.get("xyz")!({
        items: [candidate("new", "xyz new")],
        nextCursor: null,
      });
      pending.get("xy")!({
        items: [candidate("old", "xy old")],
        nextCursor: null,
      });
    });
    expect(options().join()).toContain("xyz new");
    expect(options().join()).not.toContain("xy old");
    await key(textarea, "Enter");
    expect(references.map((ref) => ref.sessionId)).toEqual(["new"]);
  });

  it("keeps Enter and Tab while results load, and never picks them later", async () => {
    let resolve!: (page: SessionReferenceCandidatesPage) => void;
    const loader = vi.fn<Loader>(() => new Promise((done) => (resolve = done)));
    const textarea = await render(loader);
    await type(textarea, "see #needle");
    const tab = await key(textarea, "Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(textarea.getAttribute("aria-activedescendant")).toBeNull();
    const enter = await key(textarea, "Enter");
    expect(enter.defaultPrevented).toBe(true); // the normal send
    expect(submit).toHaveBeenCalledWith("see #needle", [], expect.anything());
    await act(async () =>
      resolve({ items: [candidate("n", "Needle")], nextCursor: null }),
    );
    expect(references).toEqual([]);
  });

  it("keeps Enter and Tab when a query has no results", async () => {
    const loader = vi.fn<Loader>(async () => ({ items: [], nextCursor: null }));
    const textarea = await render(loader);
    await type(textarea, "about #nothing");
    expect(picker()).not.toBeNull();
    expect((await key(textarea, "Tab")).defaultPrevented).toBe(false);
    await key(textarea, "Enter");
    expect(submit).toHaveBeenCalledWith(
      "about #nothing",
      [],
      expect.anything(),
    );
  });

  it.each(["abc", "abcd", "abcdef", "abcdefab", "cafe", "decade", "1e1e1e"])(
    "never preselects the hex color #%s, but arrows can still pick it",
    async (query) => {
      const loader = vi.fn<Loader>(async () => ({
        items: [candidate("h", `${query} title`)],
        nextCursor: null,
      }));
      const textarea = await render(loader);
      await type(textarea, `#${query}`);
      expect(options()[0]).toContain(`${query} title`);
      expect(textarea.getAttribute("aria-activedescendant")).toBeNull();
      expect((await key(textarea, "Tab")).defaultPrevented).toBe(false);
      await key(textarea, "ArrowDown");
      expect(activeOption(textarea)).toContain(`${query} title`);
      await key(textarea, "Enter");
      expect(references.map((ref) => ref.sessionId)).toEqual(["h"]);
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it("old rows can't be picked once the query or scope changes", async () => {
    const pending = new Map<
      string,
      (page: SessionReferenceCandidatesPage) => void
    >();
    const loader = vi.fn<Loader>(({ scope, query, search }) =>
      query === "xy" && scope === "project" && search === "title"
        ? Promise.resolve({
            items: [candidate("old", "xy old")],
            nextCursor: null,
          })
        : new Promise((resolve) =>
            pending.set(`${scope}|${search}|${query}`, resolve),
          ),
    );
    const textarea = await render(loader);
    await type(textarea, "#xy");
    expect(options()[0]).toContain("xy old");
    expect(activeOption(textarea)).toContain("xy old");

    const clickOld = async () => {
      const row = container.querySelector<HTMLElement>('[role="option"]')!;
      expect(row.textContent).toContain("xy old");
      expect(row.getAttribute("aria-disabled")).toBe("true");
      await act(async () => {
        row.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
        row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        row.click();
      });
      expect(references).toEqual([]);
      expect(textarea.getAttribute("aria-activedescendant")).toBeNull();
    };

    // New query, old rows still on screen.
    await type(textarea, "#xyz");
    await clickOld();
    // The content-search row of the stale list is inert too.
    const rows = container.querySelectorAll<HTMLElement>('[role="option"]');
    const content = rows[rows.length - 1]!;
    await act(async () => content.click());
    expect(loader).not.toHaveBeenCalledWith(
      expect.objectContaining({ search: "content" }),
    );
    await act(async () =>
      pending.get("project|title|xyz")!({
        items: [candidate("new", "xyz new")],
        nextCursor: null,
      }),
    );
    expect(options()[0]).toContain("xyz new");
    expect(references).toEqual([]);

    // Same for a scope change.
    await type(textarea, "##xyz");
    expect(options()[0]).toContain("xyz new");
    const row = container.querySelector<HTMLElement>('[role="option"]')!;
    await act(async () => row.click());
    expect(references).toEqual([]);
    await act(async () =>
      pending.get("all|title|xyz")!({
        items: [candidate("far", "xyz far", "/other")],
        nextCursor: null,
      }),
    );
    await act(async () =>
      container.querySelector<HTMLElement>('[role="option"]')!.click(),
    );
    expect(references.map((ref) => ref.sessionId)).toEqual(["far"]);
  });

  it("walks every page with the keyboard, beyond the first screen", async () => {
    const all = Array.from({ length: 130 }, (_, index) =>
      candidate(`s${index}`, `Session ${index}`),
    );
    const loader = vi.fn<Loader>(async ({ cursor }) =>
      cursor
        ? { items: all.slice(100), nextCursor: null }
        : { items: all.slice(0, 100), nextCursor: "page-2" },
    );
    const textarea = await render(loader);
    await type(textarea, "#");
    expect(options()).toHaveLength(100);
    for (let index = 0; index < 100; index++) await key(textarea, "ArrowDown");
    expect(activeOption(textarea)).toContain("Session 99");
    // One more press past the loaded page asks for the next one and moves on.
    await key(textarea, "ArrowDown");
    await settle();
    expect(loader).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "page-2" }),
    );
    expect(options()).toHaveLength(130);
    expect(activeOption(textarea)).toContain("Session 100");
    await key(textarea, "PageDown");
    await key(textarea, "PageDown");
    await key(textarea, "PageDown");
    await key(textarea, "PageDown");
    expect(activeOption(textarea)).toContain("Session 129");
    await key(textarea, "Enter");
    expect(references.map((ref) => ref.sessionId)).toEqual(["s129"]);
  });

  it("searches message content on request and Escape returns to titles", async () => {
    const loader = vi.fn<Loader>(async ({ search }) => ({
      items:
        search === "content"
          ? [
              {
                ...candidate("c", "Unrelated title"),
                snippet: "…the 输入法 bug…",
              },
            ]
          : [],
      nextCursor: null,
    }));
    const textarea = await render(loader);
    await type(textarea, "#输入法");
    expect(options()[options().length - 1]).toContain("Search message content");
    const mod = await key(textarea, "Enter", { metaKey: true });
    expect(mod.defaultPrevented).toBe(true);
    await settle();
    expect(loader).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "content", query: "输入法" }),
    );
    expect(options()[0]).toContain("输入法 bug");
    await key(textarea, "Escape");
    await settle();
    expect(picker()).not.toBeNull();
    expect(loader).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "title" }),
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("waits for IME composition before searching", async () => {
    const loader = vi.fn<Loader>(async () => ({ items: [], nextCursor: null }));
    const textarea = await render(loader);
    await type(textarea, "#");
    loader.mockClear();
    await act(async () =>
      textarea.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    await type(textarea, "#shu");
    await type(textarea, "#shuru");
    expect(loader).not.toHaveBeenCalled();
    await act(async () => {
      textarea.value = "#输入";
      textarea.setSelectionRange(3, 3);
      textarea.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
    });
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "输入" }),
    );
  });

  it("keeps attachments and MCP tags when a card is picked or dropped", async () => {
    setComposerMcpTags("current", [
      newMcpTag(
        {
          provider: "claude",
          name: "docs",
          scope: "project",
          configPath: "/repo/.mcp.json",
          transport: "stdio",
        },
        [],
      ),
    ]);
    try {
      const loader = vi.fn<Loader>(async () => ({
        items: [candidate("a", "Fix IME")],
        nextCursor: null,
      }));
      const textarea = await render(loader, "use @mcp/docs ");
      // A copied message carries its attachment, as in Composer.paste.test.
      let written: ClipboardItem[] = [];
      vi.spyOn(navigator.clipboard, "write").mockImplementation(
        async (items) => {
          written = items;
        },
      );
      await copyMessage("", [
        {
          id: "f",
          name: "notes.png",
          mimeType: "image/png",
          kind: "image",
          size: 3,
          data: "YWJj",
        },
      ]);
      const html = await (await written[0]!.getType("text/html")).text();
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: {
          getData: (type: string) => (type === "text/html" ? html : ""),
          files: [],
          items: [],
        },
      });
      await act(async () => {
        textarea.setSelectionRange(14, 14);
        textarea.dispatchEvent(paste);
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(container.querySelector('[title="notes.png"]')).not.toBeNull();

      await type(textarea, "use @mcp/docs #fix");
      await key(textarea, "Enter");
      snapshot.mockResolvedValueOnce({
        id: "d",
        title: "Dropped",
        cwd: "/other",
        harness: "claude",
        model: "x",
        updatedAt: 1,
        readVersion: "v",
        blocks: [],
      });
      await act(async () => {
        container
          .querySelector('[data-session-reference-target="current"]')!
          .dispatchEvent(
            new CustomEvent(SESSION_REFERENCE_DROP, {
              detail: {
                sessionId: "d",
                title: "",
                cwd: "/other",
                harness: "claude",
              },
            }),
          );
      });
      expect(textarea.value).toBe("use @mcp/docs ");
      expect(container.querySelector('[title="notes.png"]')).not.toBeNull();
      expect(container.querySelector("[data-mcp-tag]")).not.toBeNull();
      expect(references.map((ref) => ref.sessionId)).toEqual(["a", "d"]);

      // Removing a card leaves text, caret, attachment and tag alone.
      textarea.setSelectionRange(4, 4);
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Remove reference Dropped"]',
          )!
          .click(),
      );
      expect(references.map((ref) => ref.sessionId)).toEqual(["a"]);
      expect(textarea.value).toBe("use @mcp/docs ");
      expect(textarea.selectionStart).toBe(4);
      expect(container.querySelector('[title="notes.png"]')).not.toBeNull();
      expect(container.querySelector("[data-mcp-tag]")).not.toBeNull();

      await key(textarea, "Enter");
      expect(submit).toHaveBeenCalledTimes(1);
      const [text, files, options] = submit.mock.calls[0]!;
      expect(text).toMatch(/^MCP context: .*"docs"/);
      expect(files.map((entry) => entry.name)).toEqual(["notes.png"]);
      expect(options?.sessionReferences?.map((ref) => ref.sessionId)).toEqual([
        "a",
      ]);
    } finally {
      clearComposerDraft("current");
      vi.restoreAllMocks();
    }
  });

  it("accepts a Sidebar drop only for referenceable sessions", async () => {
    const textarea = await render(vi.fn<Loader>());
    await type(textarea, "keep this");
    const box = container.querySelector<HTMLElement>(
      '[data-session-reference-target="current"]',
    )!;
    snapshot.mockResolvedValueOnce({
      id: "d",
      title: "Dropped",
      cwd: "/repo",
      harness: "claude",
      model: "x",
      updatedAt: 1,
      readVersion: "v",
      blocks: [],
    });
    await act(async () => {
      box.dispatchEvent(
        new CustomEvent(SESSION_REFERENCE_DROP, {
          detail: {
            sessionId: "d",
            title: "stale",
            cwd: "/repo",
            harness: "claude",
          },
        }),
      );
    });
    expect(references).toEqual([
      { sessionId: "d", title: "Dropped", cwd: "/repo", harness: "claude" },
    ]);
    expect(textarea.value).toBe("keep this");

    snapshot.mockResolvedValueOnce(null);
    await act(async () => {
      box.dispatchEvent(
        new CustomEvent(SESSION_REFERENCE_DROP, {
          detail: {
            sessionId: "w",
            title: "Worker",
            cwd: "/repo",
            harness: "claude",
          },
        }),
      );
    });
    expect(references).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "can't be referenced",
    );
  });

  it("drops a late snapshot for an unmounted or switched composer", async () => {
    let resolveSnapshot!: (value: unknown) => void;
    snapshot.mockImplementation(
      () => new Promise((resolve) => (resolveSnapshot = resolve)),
    );
    const source = {
      id: "d",
      title: "Dropped",
      cwd: "/repo",
      harness: "claude",
      model: "x",
      updatedAt: 1,
      readVersion: "v",
      blocks: [],
    };
    const drop = () =>
      act(async () => {
        container
          .querySelector("[data-session-reference-target]")!
          .dispatchEvent(
            new CustomEvent(SESSION_REFERENCE_DROP, {
              detail: {
                sessionId: "d",
                title: "",
                cwd: "/repo",
                harness: "claude",
              },
            }),
          );
      });

    // Switched to another session before the snapshot arrived.
    const textarea = await render(vi.fn<Loader>(), undefined, "first");
    await drop();
    await render(vi.fn<Loader>(), undefined, "second");
    await type(textarea, "second draft");
    await act(async () => resolveSnapshot(source));
    expect(references).toEqual([]);
    expect(chips()).toEqual([]);
    expect(textarea.value).toBe("second draft");
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // Unmounted before it arrived.
    await drop();
    act(() => root.unmount());
    await act(async () => resolveSnapshot(source));
    expect(references).toEqual([]);
    root = createRoot(container);
  });

  it("a late drop adds the card without taking focus from elsewhere", async () => {
    let resolveSnapshot!: (value: unknown) => void;
    snapshot.mockImplementation(
      () => new Promise((resolve) => (resolveSnapshot = resolve)),
    );
    const textarea = await render(vi.fn<Loader>(), "keep me");
    textarea.setSelectionRange(2, 4);
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    try {
      await act(async () => {
        container
          .querySelector("[data-session-reference-target]")!
          .dispatchEvent(
            new CustomEvent(SESSION_REFERENCE_DROP, {
              detail: {
                sessionId: "d",
                title: "",
                cwd: "/repo",
                harness: "claude",
              },
            }),
          );
      });
      elsewhere.focus();
      await act(async () =>
        resolveSnapshot({
          id: "d",
          title: "Dropped",
          cwd: "/repo",
          harness: "claude",
          model: "x",
          updatedAt: 1,
          readVersion: "v",
          blocks: [],
        }),
      );
      expect(references.map((ref) => ref.sessionId)).toEqual(["d"]);
      expect(document.activeElement).toBe(elsewhere);
      expect(textarea.value).toBe("keep me");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 4]);
    } finally {
      elsewhere.remove();
    }
  });
});

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...original,
    invoke: (command: string, args?: Record<string, unknown>) =>
      command.startsWith("session_reference_")
        ? backend.invoke(command, args)
        : original.invoke(command, args),
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("./AgentTranscript", () => ({ AgentTranscript: () => null }));
const runs = vi.hoisted(() => [] as never[]);
vi.mock("../../orchestration/model/orchestration", async (original) => ({
  ...(await original<
    typeof import("../../orchestration/model/orchestration")
  >()),
  orchestrator: {
    subscribe: () => () => {},
    snapshot: () => runs,
    hydrate: async () => {},
  },
}));

import { SessionPane, type SessionPaneProps } from "./SessionPane";
import {
  clearComposerDraft,
  getComposerSessionReferences,
} from "../model/draftCache";
import type { Session } from "../model/session";

let container: HTMLDivElement;
let root: Root;
const submit = vi.fn();
const noop = () => {};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  submit.mockReset();
  backend.invoke.mockReset().mockImplementation(async (command: string) =>
    command === "session_reference_candidates"
      ? {
          items: [
            {
              sessionId: "source",
              title: "Fix IME",
              cwd: "/other",
              harness: "codex",
              model: "gpt-5",
              updatedAt: Date.now(),
              userTurnCount: 2,
              relevance: 4000,
            },
          ],
          nextCursor: null,
        }
      : null,
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearComposerDraft("chat");
  clearComposerDraft("other");
  vi.unstubAllGlobals();
});

function session(id: string): Session {
  return {
    id,
    title: id,
    cwd: "/repo",
    harness: "codex",
    model: "",
    modelSettings: {},
    runtimeMode: "supervised",
    blocks: [{ id: `${id}-user`, role: "user", text: "Hello" }],
  } as Session;
}

function props(current: Session): SessionPaneProps {
  return {
    session: current,
    visible: true,
    focused: true,
    inSplit: false,
    composerFocused: true,
    recents: [],
    onFocus: noop,
    onClose: noop,
    onCwdChange: noop,
    onBranchChange: noop,
    onWorkspaceModeChange: noop,
    onWorktreeBaseChange: noop,
    onModelChange: noop,
    onModelSettingsChange: noop,
    onRuntimeModeChange: noop,
    onSubmit: submit,
    onSaveDraft: noop,
    onRemoveDraft: noop,
    onStop: noop,
    onCompactContext: () => false,
    onPlaceSessionInFolder: noop,
    onDeleteQueuedMessage: noop,
    onEditQueuedMessage: noop,
    onQueuedMessageEditingChange: noop,
    onSteerQueuedMessage: noop,
    onResumeQueue: noop,
    onUsageLimitResume: noop,
    onUsageLimitResumeAtReset: noop,
    onUsageLimitDismiss: noop,
    onApproval: noop,
    onQuestionReply: noop,
    onOpenFile: noop,
    onOpenDiff: noop,
    onOpenPlan: noop,
    onBuildPlan: noop,
    onNewTerminal: noop,
  };
}

// App renders one SessionPane per session, keyed by its id.
const show = (id: string) =>
  act(async () =>
    root.render(createElement(SessionPane, { key: id, ...props(session(id)) })),
  );
const field = () => container.querySelector("textarea")!;
const chips = () =>
  Array.from(
    container.querySelectorAll(
      "[data-composer-box] [data-session-reference-chips] li",
    ),
  ).map((node) => node.textContent);

it("restores a picked card with the draft text through the pane's own cache", async () => {
  await show("chat");
  const textarea = field();
  await act(async () => {
    textarea.value = "compare #fix with mine";
    textarea.setSelectionRange(12, 12);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  expect(backend.invoke).toHaveBeenCalledWith(
    "session_reference_candidates",
    expect.objectContaining({
      options: expect.objectContaining({
        cwd: "/repo",
        currentSessionId: "chat",
      }),
    }),
  );
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(textarea.value).toBe("compare with mine");
  expect(textarea.selectionStart).toBe(8);
  expect(chips()[0]).toContain("Fix IME");
  expect(getComposerSessionReferences("chat")).toHaveLength(1);
  expect(submit).not.toHaveBeenCalled();

  // Switching sessions remounts the composer; the other draft stays empty.
  await show("other");
  expect(field().value).toBe("");
  expect(chips()).toEqual([]);

  await show("chat");
  expect(field().value).toBe("compare with mine");
  expect(chips()[0]).toContain("Fix IME");

  // Sending hands the card to the app and clears the cached one.
  await act(async () => {
    field().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(submit).toHaveBeenCalledWith(
    "chat",
    "compare with mine",
    [],
    expect.objectContaining({
      sessionReferences: [
        {
          sessionId: "source",
          title: "Fix IME",
          cwd: "/other",
          harness: "codex",
        },
      ],
    }),
  );
  expect(getComposerSessionReferences("chat")).toEqual([]);
});

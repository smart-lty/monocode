import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { SessionPane, type SessionPaneProps } from "../../src/features/sessions/ui/SessionPane";
import { getSession, upsertSession } from "../../src/features/sessions/data/sessionStore";
import { appendUser, applyHarnessEvent, stopStreaming } from "../../src/integrations/harness/core/apply";
import {
  applyBtwHarnessEvent,
  cancelBtwThread,
  queueBtwThread,
  replaceBtwThread,
} from "../../src/features/sessions/model/btw";
import {
  completedSessionBoundary,
  SESSION_FORK_EVENT,
  type SessionForkRequest,
} from "../../src/features/sessions/model/sessionFork";
import { runSessionFork } from "../../src/features/sessions/model/sessionForkOperation";
import { provideSessionTitles } from "../../src/features/sessions/ui/sessionTitleLookup";
import type { Block, BtwThread, Session } from "../../src/features/sessions/model/session";
import {
  getComposerMcpTags,
  getComposerSessionReferences,
  setComposerDraft,
  setComposerMcpTags,
  setComposerSessionReferences,
} from "../../src/features/sessions/model/draftCache";
import { newMcpTag } from "../../src/features/sessions/model/mcpPicker";
import "../../src/styles/index.css";

// Mocked IPC and a scripted provider. The fork runs the real
// runSessionFork/createForkChild and the real session sanitizer on save and
// load; the native provider call, its queue and its answers are synthetic.
// Real Codex/OpenCode behaviour and the real App are verified separately.

const CWD = "/work/monocode";
const SOURCE_ID = "5f0c2a9e-7d41-4b8e-9a63-2c1d0e8f4b17";
const STORE = "fork-sidechat-store";
const saved: Record<string, unknown> = JSON.parse(sessionStorage.getItem(STORE) ?? "{}");

type Fixture = {
  submitted: { sessionId: string; text: string }[];
  forkCalls: { sourceProviderSessionId: string; turnIds: (string | undefined)[] }[];
  /** A native refusal, as the provider adapter reports it. */
  nativeError?: string;
  /** Saved when a stop is not confirmed by the provider. */
  cancelError?: string;
  /** Fail saving the child and removing its native thread: an unbound record. */
  unbound?: boolean;
  showRight(sessionId: string): void;
  /** The source composer's MCP tags and reference cards, from the draft cache. */
  draft(): { mcp: string[]; references: string[] };
  setBusy(busy: boolean): void;
  startCancelableTurn(sessionId: string): void;
  failCancelableTurn(sessionId: string): void;
  lateCancelledEvents(sessionId: string): void;
  btwRun(): void;
  /** Stream part of an answer through the real event path. */
  btwPartial(text: string): void;
  btwAnswer(text: string): void;
  sessions(): Session[];
  reset(): void;
};
const fixture = window as unknown as { fixture: Fixture };

mockWindows("main");
mockIPC(
  (command, args) => {
    const input = args as Record<string, unknown>;
    if (command === "session_upsert") {
      const session = input.session as { id: string; title: string; harness: string; model: string };
      saved[session.id] = session;
      sessionStorage.setItem(STORE, JSON.stringify(saved));
      return { ...session, createdAt: 1, updatedAt: Date.now() };
    }
    if (command === "session_get") return saved[input.sessionId as string] ?? null;
    if (command === "inspect_paths") return [];
    if (command === "session_checkpoint_status") return { files: [] };
    if (command === "git_branches") return { current: "main", detached: false, branches: [] };
    if (command === "read_text_file") return "";
    return [];
  },
  { shouldMockEvents: true },
);

const now = Date.UTC(2026, 9, 10, 9, 0);
function turn(id: string, text: string, answer: string, extra: Block[] = []): Block[] {
  return [
    {
      id: `${id}-user`,
      role: "user",
      text,
      startedAt: now,
      durationMs: 1200,
      providerTurnId: `native-${id}`,
      nativeContext: { harness: "codex", sessionId: "thread-source", turnId: `native-${id}`, source: "provider" },
    },
    ...extra,
    { id: `${id}-answer`, role: "assistant", text: answer },
  ];
}

function seed(): Session[] {
  return [
    {
      id: SOURCE_ID,
      cwd: CWD,
      harness: "codex",
      model: "gpt-5",
      runtimeMode: "supervised",
      title: "Cache rollout plan",
      providerSessionId: "thread-source",
      blocks: [
        ...turn("t1", "Remember BEFORE_ALPHA_7491 for later.", "Noted BEFORE_ALPHA_7491.", [
          {
            id: "t1-plan",
            role: "plan",
            text: "# Roll out the cache\n\n1. Warm it\n2. Switch traffic",
            plan: { status: "ready" },
          },
        ]),
        ...turn("t2", "Now also remember AFTER_OMEGA_8256.", "Noted AFTER_OMEGA_8256."),
      ],
    },
    {
      id: "other",
      cwd: CWD,
      harness: "claude",
      model: "claude-opus-4-5",
      runtimeMode: "supervised",
      title: "Claude session",
      blocks: [
        { id: "o1-user", role: "user", text: "Explain the queue.", startedAt: now, durationMs: 900 },
        { id: "o1-answer", role: "assistant", text: "It runs one request at a time." },
      ],
    },
  ];
}

function runningTurn(): Block[] {
  return [
    { id: "t3-user", role: "user", text: "Keep working on the rollout.", startedAt: Date.now() },
    { id: "t3-answer", role: "assistant", text: "Working on it", streaming: true },
  ];
}

const noop = () => {};
const BASE: Omit<SessionPaneProps, "session" | "visible" | "focused" | "inSplit" | "composerFocused"> = {
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
  onSubmit: noop,
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

fixture.fixture = {
  submitted: [],
  forkCalls: [],
} as unknown as Fixture;

function Harness({ initial }: { initial: Session[] }) {
  const [sessions, setSessions] = useState(initial);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [right, setRight] = useState("other");
  const [focus, setFocus] = useState({ id: SOURCE_ID, token: 0 });
  const request = useRef<{ sessionId: string; userBlockId: string; threadId: string } | null>(null);

  const update = useCallback((id: string, change: (session: Session) => Session) => {
    const next = sessionsRef.current.map((session) => (session.id === id ? change(session) : session));
    sessionsRef.current = next;
    setSessions(next);
    const session = next.find((entry) => entry.id === id);
    if (session) void upsertSession(session);
  }, []);
  const updateThread = useCallback(
    (sessionId: string, userBlockId: string, threadId: string, change: (thread?: BtwThread) => BtwThread | undefined) =>
      update(sessionId, (session) => ({
        ...session,
        blocks: session.blocks.map((block) => {
          if (block.id !== userBlockId) return block;
          const current = block.btwThreads?.find((thread) => thread.id === threadId);
          const next = change(current);
          if (!next) return block;
          return current ? replaceBtwThread(block, next) : { ...block, btwThreads: [...(block.btwThreads ?? []), next] };
        }),
      })),
    [update],
  );

  useEffect(() => {
    void Promise.all(initial.map((session) => upsertSession(session)));
    return provideSessionTitles((id) => sessionsRef.current.find((session) => session.id === id)?.title);
  }, [initial]);

  // The App's fork receiver, with a synthetic native provider.
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<SessionForkRequest>).detail;
      void runSessionFork(detail, {
        source: () => sessionsRef.current.find((session) => session.id === detail.sourceSessionId),
        available: async () => true,
        fork: async (_harness, input) => {
          fixture.fixture.forkCalls.push({
            sourceProviderSessionId: input.sourceProviderSessionId,
            turnIds: input.nativeTurns.map((entry) => entry.turnId),
          });
          await new Promise((resolve) => setTimeout(resolve, 150));
          if (fixture.fixture.nativeError) throw new Error(fixture.fixture.nativeError);
          return {
            providerSessionId: "thread-child",
            nativeCutoff: "inclusive-turn",
            nativeTurns: input.nativeTurns.map((entry) => ({ ...entry, sessionId: "thread-child", source: "fork" as const })),
            discard: async () => {
              if (fixture.fixture.unbound) throw new Error("thread/archive failed");
            },
          };
        },
        save: async (child) => {
          if (fixture.fixture.unbound && child.blocks.some((block) => block.inherited))
            throw new Error("Fork child 未成功持久化；未绑定 native child。");
          if (!(await upsertSession(child))) throw new Error("not saved");
          // Saved records are listed like any session, as in the sidebar.
          if (!sessionsRef.current.some((session) => session.id === child.id)) {
            sessionsRef.current = [...sessionsRef.current, child];
            setSessions(sessionsRef.current);
          }
        },
        remove: async () => {},
        publish: (child) => {
          sessionsRef.current = [...sessionsRef.current, child];
          setSessions(sessionsRef.current);
          setRight(child.id);
          setFocus((current) => ({ id: child.id, token: current.token + 1 }));
        },
      }).then(detail.resolve, detail.reject);
    };
    window.addEventListener(SESSION_FORK_EVENT, receive);
    return () => window.removeEventListener(SESSION_FORK_EVENT, receive);
  }, []);

  fixture.fixture.sessions = () => sessionsRef.current;
  fixture.fixture.showRight = (id) => setRight(id);
  fixture.fixture.draft = () => ({
    mcp: getComposerMcpTags(SOURCE_ID).map((tag) => tag.token),
    references: getComposerSessionReferences(SOURCE_ID).map((reference) => reference.sessionId),
  });
  fixture.fixture.reset = () => {
    sessionStorage.removeItem(STORE);
  };
  fixture.fixture.setBusy = (busy) =>
    update(SOURCE_ID, (session) => ({
      ...session,
      busy,
      blocks: busy ? [...session.blocks, ...runningTurn()] : session.blocks.map((block) =>
        block.id === "t3-user" ? { ...block, durationMs: 1000 }
          : block.id === "t3-answer" ? { ...block, text: "MAIN-DONE", streaming: false }
            : block),
    }));
  fixture.fixture.startCancelableTurn = (sessionId) => update(sessionId, (source) => {
    let session = appendUser(source, "Cancelable child sleep");
    session = applyHarnessEvent(session, { type: "turn.started", providerTurnId: "fixture-cancelled" });
    session = applyHarnessEvent(session, { type: "tool.started", callId: "sleep", title: "sleep 60", kind: "execute", status: "in_progress" });
    session = applyHarnessEvent(session, { type: "approval.requested", requestId: 7, callId: "sleep", title: "sleep 60" });
    session = applyHarnessEvent(session, { type: "approval.resolved", requestId: 7, decision: "allow" });
    return applyHarnessEvent(session, { type: "message.delta", text: "PARTIAL-KEEP" });
  });
  fixture.fixture.failCancelableTurn = (id) => update(id, (session) =>
    applyHarnessEvent(session, { type: "session.error", message: "Connection lost" }));
  fixture.fixture.lateCancelledEvents = (id) => update(id, (session) => {
    session = applyHarnessEvent(session, { type: "tool.updated", callId: "sleep", status: "completed" });
    return applyHarnessEvent(session, { type: "message.delta", text: "LATE-WRONG" });
  });
  fixture.fixture.btwRun = () => {
    const current = request.current;
    if (current) updateThread(current.sessionId, current.userBlockId, current.threadId, (thread) =>
      thread?.status === "queued" ? { ...thread, status: "running", updatedAt: Date.now() } : thread);
  };
  fixture.fixture.btwPartial = (text) => {
    const current = request.current;
    if (current) updateThread(current.sessionId, current.userBlockId, current.threadId, (thread) =>
      thread?.status === "running"
        ? {
            ...thread,
            updatedAt: Date.now(),
            pendingBlocks: applyBtwHarnessEvent(
              thread.pendingBlocks ?? [],
              { type: "message.delta", text },
              thread.harness ?? "codex",
              thread.model ?? "gpt-5",
              thread.messages[thread.messages.length - 1]?.id ?? thread.id,
            ),
          }
        : thread);
  };
  fixture.fixture.btwAnswer = (text) => {
    const current = request.current;
    if (!current) return;
    updateThread(current.sessionId, current.userBlockId, current.threadId, (thread) =>
      thread?.status === "running"
        ? {
            ...thread,
            status: "ready",
            updatedAt: Date.now(),
            pendingBlocks: undefined,
            messages: [...thread.messages, { id: crypto.randomUUID(), role: "assistant", text, createdAt: Date.now() }],
          }
        : thread);
    request.current = null;
  };

  const props = (session: Session): SessionPaneProps => ({
    ...BASE,
    session,
    visible: true,
    focused: focus.id === session.id,
    inSplit: true,
    composerFocused: focus.id === session.id,
    composerFocusToken: focus.id === session.id ? focus.token : undefined,
    onFocus: (id) => setFocus((current) => (current.id === id ? current : { id, token: current.token })),
    onSubmit: (sessionId, text) => {
      fixture.fixture.submitted.push({ sessionId, text });
    },
    onStop: (sessionId) => update(sessionId, (session) => stopStreaming(session, Date.now(), "cancelled")),
    onBtwSubmit: (sessionId, turnBlocks, threadId, messageId, text, model) => {
      const source = sessionsRef.current.find((entry) => entry.id === sessionId);
      const user = turnBlocks.find((block) => block.role === "user");
      const end = turnBlocks[turnBlocks.length - 1]?.id;
      if (!source || !user || !end) return false;
      const existing = source.blocks.find((block) => block.id === user.id)?.btwThreads?.find((thread) => thread.id === threadId);
      if (existing?.status === "running" || existing?.status === "queued") return false;
      if (!existing) {
        try { completedSessionBoundary(source, end); } catch { return false; }
      }
      const at = Date.now();
      const message = { id: messageId, role: "user" as const, text, createdAt: at };
      const thread: BtwThread = existing
        ? { ...queueBtwThread(existing, at), messages: [...existing.messages, message] }
        : {
            id: threadId, sourceEndBlockId: end, createdAt: at, updatedAt: at, status: "queued", pendingBlocks: [],
            harness: source.harness, model: model ?? source.model, messages: [message],
            contextScope: `as-of ${end}（含已完成轮次）；有限摘录、附件仅元数据。`,
          };
      updateThread(sessionId, user.id, threadId, () => thread);
      request.current = { sessionId, userBlockId: user.id, threadId };
      return true;
    },
    onBtwStop: (sessionId, turnBlocks, threadId) => {
      const user = turnBlocks.find((block) => block.role === "user");
      if (!user) return;
      updateThread(sessionId, user.id, threadId, (thread) => {
        if (!thread) return thread;
        const cancelled = cancelBtwThread(thread);
        return fixture.fixture.cancelError ? { ...cancelled, error: fixture.fixture.cancelError } : cancelled;
      });
      request.current = null;
    },
    onBtwRetry: (sessionId, turnBlocks, threadId) => {
      const user = turnBlocks.find((block) => block.role === "user");
      if (!user) return;
      updateThread(sessionId, user.id, threadId, (thread) => (thread ? queueBtwThread(thread) : thread));
      request.current = { sessionId, userBlockId: user.id, threadId };
    },
    onBtwDelete: noop,
  });

  const left = sessions.find((session) => session.id === SOURCE_ID)!;
  const rightSession = sessions.find((session) => session.id === right);
  return (
    <main className="flex h-screen min-w-0 bg-surface text-content">
      <section data-testid="pane-left" className="relative flex min-w-0 flex-1 flex-col">
        <SessionPane {...props(left)} />
      </section>
      <section data-testid="pane-right" data-session={right} className="relative flex min-w-0 flex-1 flex-col border-l border-content/10">
        {rightSession ? <SessionPane {...props(rightSession)} /> : null}
      </section>
    </main>
  );
}

async function start() {
  // A reload stands in for a restart: sessions come back through the real
  // sanitizer, with interrupted requests marked as such.
  const restored = (await Promise.all(Object.keys(saved).map((id) => getSession(id)))).filter(
    (session): session is Session => !!session,
  );
  const initial = restored.some((session) => session.id === SOURCE_ID) ? restored : seed();
  // An unsent draft with an MCP tag and a session reference card, as the
  // composer keeps it while the pane is open.
  if (new URLSearchParams(location.search).has("draft")) {
    setComposerDraft(SOURCE_ID, "Earlier draft use @mcp/docs ");
    setComposerMcpTags(SOURCE_ID, [
      newMcpTag({ provider: "codex", name: "docs", scope: "project", configPath: "/work/monocode/.mcp.json", transport: "stdio" }, []),
    ]);
    setComposerSessionReferences(SOURCE_ID, [
      { sessionId: "ref-1", cwd: CWD, harness: "claude", title: "Referenced design notes" },
    ]);
  }
  createRoot(document.getElementById("root")!).render(<Harness initial={initial} />);
}
void start();

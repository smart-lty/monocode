import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Request = {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

const sent: Request[] = [];
let onLine: ((line: string) => void) | undefined;
let output = "Generated text";
let threadCount = 0;
let failTurn = false;
let missingResume = false;
let wrongResumeId = false;
let holdTurnStart = false;
let holdThreadStart = false;
let autoComplete = true;
let failInterrupt = false;
let noActiveInterruptOnce = false;
let startDuringInterruptFailure = false;
let serverRequests: { id: number; method: string; params: Record<string, unknown> }[] = [];
const spawnChild = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined),
);
const killChild = vi.hoisted(() => vi.fn(async (_id: string) => undefined));
const prepareCodexMonoContext = vi.hoisted(() =>
  vi.fn(async (_input: unknown) => ({
    config: { sqlite_home: "/private/mono" },
    hasThread: true,
  })),
);
vi.mock("./codexStore", () => ({ prepareCodexMonoContext }));

function receive(message: unknown) {
  onLine?.(JSON.stringify(message));
}

vi.mock("../../core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/fake/codex" }),
  spawnChild,
  restoreMonoCodexAgentState: async () => undefined,
  killChild,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (value: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    const request = JSON.parse(line) as Request;
    sent.push(request);
    if (request.id === undefined) return;
    if (request.method === "thread/start") {
      if (holdThreadStart) return;
      receive({
        id: request.id,
        result: { thread: { id: `thread_${++threadCount}` } },
      });
    } else if (request.method === "thread/resume") {
      receive(
        missingResume
          ? { id: request.id, error: { message: "thread not found" } }
          : {
              id: request.id,
              result: { thread: { id: wrongResumeId ? "different_thread" : request.params?.threadId } },
            },
      );
    } else if (request.method === "turn/start") {
      if (!holdTurnStart) receive({ id: request.id, result: { turn: { id: "turn_1" } } });
      for (const call of serverRequests) receive({ ...call, params: { ...call.params, threadId: request.params?.threadId } });
      if (!autoComplete) return;
      setTimeout(() => {
        receive({
          method: "item/agentMessage/delta",
          params: { threadId: request.params?.threadId, turnId: "turn_1", delta: output },
        });
        receive({
          method: "turn/completed",
          params: {
            threadId: request.params?.threadId,
            turn: {
              id: "turn_1",
              status: failTurn ? "failed" : "completed",
              ...(failTurn ? { error: { message: "Generation failed" } } : {}),
            },
          },
        });
      }, serverRequests.length ? 10 : 0);
    } else if (request.method === "turn/interrupt") {
      if (noActiveInterruptOnce) {
        noActiveInterruptOnce = false;
        receive({ id: request.id, error: { message: "no active turn to interrupt" } });
        if (startDuringInterruptFailure) receive({ method: "turn/started", params: {
          threadId: request.params?.threadId, turn: { id: request.params?.turnId },
        } });
        return;
      }
      if (!request.params?.threadId || !request.params?.turnId || failInterrupt) {
        receive({ id: request.id, error: { message: "interrupt rejected: threadId and turnId are required" } });
        return;
      }
      receive({ id: request.id, result: {} });
      receive({ method: "turn/completed", params: {
        threadId: request.params.threadId, turn: { id: request.params.turnId, status: "interrupted" },
      } });
    } else {
      receive({ id: request.id, result: {} });
    }
  },
}));

vi.mock("../../../../platform/tauri/fs", () => ({
  gitStagedContext: async () => ({
    branch: "helpers",
    summary: "1 file changed",
    patch: "diff",
  }),
  gitRangeContext: async () => ({
    base: "main",
    head: "helpers",
    commitSummary: "Keep helper history clean",
    diffSummary: "1 file changed",
    diffPatch: "diff",
  }),
}));

const { runCodexTextPrompt, stopCodexTextPrompt, warmupCodexText } =
  await import("./codexText");
const { generateCodexSessionTitle } = await import("./codexTitle");
const {
  generateCodexCommitMessage,
  generateCodexBranchName,
  generateCodexPrContent,
} = await import("./codexGit");

function threadStarts() {
  return sent.filter((request) => request.method === "thread/start");
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  output = "Generated text";
  threadCount = 0;
  failTurn = false;
  missingResume = false;
  wrongResumeId = false;
  holdTurnStart = false;
  holdThreadStart = false;
  autoComplete = true;
  failInterrupt = false;
  noActiveInterruptOnce = false;
  startDuringInterruptFailure = false;
  serverRequests = [];
  spawnChild.mockClear();
  killChild.mockClear();
  prepareCodexMonoContext.mockClear();
});

afterEach(async () => {
  await stopCodexTextPrompt();
});

it.each([
  {
    name: "session titles",
    response: { title: "Keep Helper History Clean", workItem: null },
    run: () =>
      generateCodexSessionTitle({
        sessionId: "session",
        cwd: "/repo",
        message: "Keep helper history clean",
      }),
    expected: { title: "Keep Helper History Clean", workItem: null },
  },
  {
    name: "commit messages",
    response: { subject: "Keep helper history clean", body: "" },
    run: () => generateCodexCommitMessage("/repo"),
    expected: "Keep helper history clean",
  },
  {
    name: "branch names",
    response: { branch: "keep-helper-history-clean" },
    run: () => generateCodexBranchName("/repo", "Keep helper history clean"),
    expected: "keep-helper-history-clean",
  },
  {
    name: "PR content",
    response: {
      title: "Keep helper history clean",
      body: "## Summary\n- Use unsaved threads",
    },
    run: () => generateCodexPrContent("/repo"),
    expected: {
      title: "Keep helper history clean",
      body: "## Summary\n- Use unsaved threads",
      base: "main",
      head: "helpers",
    },
  },
])(
  "generates $name without saving a Codex conversation",
  async ({ response, run, expected }) => {
    output = JSON.stringify(response);
    await expect(run()).resolves.toEqual(expected);
    expect(threadStarts()).toHaveLength(1);
    expect(threadStarts()[0].params).toMatchObject({ ephemeral: true });
    expect(sent.some((request) => request.method === "thread/resume")).toBe(
      false,
    );
  },
);

it("keeps warmup and subsequent prompts unsaved across model changes", async () => {
  await warmupCodexText("/repo");
  await expect(
    runCodexTextPrompt({
      cwd: "/repo",
      model: "test-model",
      prompt: "Generate text",
    }),
  ).resolves.toBe(output);
  await expect(
    runCodexTextPrompt({ cwd: "/repo", prompt: "Generate more text" }),
  ).resolves.toBe(output);
  expect(threadStarts()).toHaveLength(3);
  expect(
    threadStarts().every((request) => request.params?.ephemeral === true),
  ).toBe(true);
});

it("does not resume a stored thread for an unsaved text request", async () => {
  await runCodexTextPrompt({
    cwd: "/repo",
    threadId: "stored_thread",
    prompt: "Generate text",
  });
  expect(sent.some((request) => request.method === "thread/resume")).toBe(
    false,
  );
  expect(threadStarts()[0].params).toMatchObject({ ephemeral: true });
});

it("allows side questions to explicitly retain and resume their thread", async () => {
  const onThreadId = vi.fn();
  await warmupCodexText("/repo");
  await runCodexTextPrompt({
    cwd: "/repo",
    ephemeral: false,
    onThreadId,
    prompt: "Side question",
  });
  expect(threadStarts()).toHaveLength(2);
  expect(threadStarts()[0].params).toMatchObject({ ephemeral: true });
  expect(threadStarts()[1].params).not.toHaveProperty("ephemeral");
  expect(onThreadId).toHaveBeenCalledWith("thread_2");

  await runCodexTextPrompt({
    cwd: "/repo",
    ephemeral: false,
    threadId: "thread_2",
    prompt: "Follow-up",
  });
  expect(
    sent.find((request) => request.method === "thread/resume")?.params,
  ).toMatchObject({ threadId: "thread_2" });
  expect(threadStarts()).toHaveLength(2);
});

it("fails explicitly when a saved side thread is missing instead of silently reinjecting history", async () => {
  missingResume = true;
  await expect(runCodexTextPrompt({
    cwd: "/repo",
    ephemeral: false,
    threadId: "missing_thread",
    prompt: "Side question",
  })).rejects.toThrow("Start a new discussion explicitly");
  expect(threadStarts()).toHaveLength(0);
});

it("resumes a read-only side thread with only the new question, never the full discussion again", async () => {
  await runCodexTextPrompt({ cwd: "/repo", ephemeral: false, threadId: "saved_side",
    prompt: "ALL_SAVED_DISCUSSION", resumePrompt: "NEW_QUESTION" });
  expect(sent.find((request) => request.method === "thread/resume")?.params).toMatchObject({
    sandbox: "read-only", approvalPolicy: "never",
  });
  const params = sent.find((request) => request.method === "turn/start")?.params;
  expect(params).toMatchObject({ sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" });
  expect(JSON.stringify(params)).toContain("NEW_QUESTION");
  expect(JSON.stringify(params)).not.toContain("ALL_SAVED_DISCUSSION");
});
it("rejects a native resume that returns a different thread, without reinjecting saved discussion", async () => {
  wrongResumeId = true;
  await expect(runCodexTextPrompt({ cwd: "/repo", ephemeral: false, threadId: "saved",
    prompt: "SAVED_DISCUSSION", resumePrompt: "NEW" })).rejects.toThrow("requested saved");
  expect(threadStarts()).toHaveLength(0); expect(sent.some((request) => request.method === "turn/start")).toBe(false);
});
it("exposes only the bounded host reader and denies dynamic writes and native write approval", async () => {
  serverRequests = [
    { id: 101, method: "item/tool/call", params: { tool: "monocode_read_context", arguments: { sessionId: "parent", view: "messages" } } },
    { id: 102, method: "item/tool/call", params: { tool: "monocode_write_context", arguments: { sessionId: "parent", text: "write" } } },
    { id: 103, method: "item/fileChange/requestApproval", params: {} },
    { id: 104, method: "item/permissions/requestApproval", params: {} },
  ];
  const readContext = vi.fn(async () => ({ blocks: [{ text: "BEFORE" }], readOnly: true }));
  await runCodexTextPrompt({ cwd: "/repo", prompt: "Question", intent: "build", readContext });
  expect(readContext).toHaveBeenCalledTimes(1);
  const responses = sent as unknown as { id: number; result?: Record<string, unknown> }[];
  expect(responses.find((entry) => entry.id === 101)?.result).toMatchObject({ success: true });
  expect(responses.find((entry) => entry.id === 102)?.result).toMatchObject({ success: false });
  expect(responses.find((entry) => entry.id === 103)?.result).toEqual({ decision: "decline" });
  expect(responses.find((entry) => entry.id === 104)?.result).toEqual({ permissions: {} });
  expect(sent.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
    sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" });
});

it("keeps a failed generation and its retry unsaved", async () => {
  failTurn = true;
  await expect(
    runCodexTextPrompt({ cwd: "/repo", prompt: "Generate text" }),
  ).rejects.toThrow("Generation failed");
  failTurn = false;
  await expect(
    runCodexTextPrompt({ cwd: "/repo", prompt: "Retry" }),
  ).resolves.toBe(output);
  expect(threadStarts()).toHaveLength(2);
  expect(
    threadStarts().every((request) => request.params?.ephemeral === true),
  ).toBe(true);
});

it("isolates Mono side questions from regular Codex threads and resumes them after restart", async () => {
  await runCodexTextPrompt({
    cwd: "/repo",
    ephemeral: false,
    prompt: "Regular side question",
  });
  expect(spawnChild.mock.calls[0][6]).toBeUndefined();
  expect(prepareCodexMonoContext).not.toHaveBeenCalled();
  await runCodexTextPrompt({
    cwd: "/repo",
    ephemeral: false,
    codexStore: "mono",
    prompt: "Mono side question",
  });
  expect(spawnChild.mock.calls[1][6]).toBe("mono");
  expect(threadStarts()[1].params).toMatchObject({
    config: { sqlite_home: "/private/mono" },
  });
  expect(threadStarts()[1].params).not.toHaveProperty("ephemeral");
  await stopCodexTextPrompt();
  await runCodexTextPrompt({
    cwd: "/repo",
    ephemeral: false,
    codexStore: "mono",
    threadId: "thread_2",
    prompt: "Continue",
  });
  expect(sent.find((m) => m.method === "thread/resume")?.params).toMatchObject({
    threadId: "thread_2",
    config: { sqlite_home: "/private/mono" },
  });
  expect(threadStarts()).toHaveLength(2);
});

it("reports private side-question resume failures without replacing saved context", async () => {
  missingResume = true;
  await expect(
    runCodexTextPrompt({
      cwd: "/repo",
      ephemeral: false,
      codexStore: "mono",
      threadId: "saved-mono",
      prompt: "Continue",
    }),
  ).rejects.toThrow("thread not found");
  expect(threadStarts()).toHaveLength(0);
});

it("does not send a native interrupt or start for a queued cancellation", async () => {
  autoComplete = false;
  const first = runCodexTextPrompt({ cwd: "/repo", prompt: "First side question" });
  await vi.waitFor(() => expect(sent.filter((request) => request.method === "turn/start")).toHaveLength(1));
  const controller = new AbortController();
  const waiting = runCodexTextPrompt({ cwd: "/repo", prompt: "Queued side question", signal: controller.signal });
  controller.abort(); await expect(waiting).rejects.toThrow("cancelled");
  expect(sent.some((request) => request.method === "turn/interrupt")).toBe(false);
  receive({ method: "item/agentMessage/delta", params: { threadId: "thread_1", turnId: "turn_1", delta: output } });
  receive({ method: "turn/completed", params: { threadId: "thread_1", turn: { id: "turn_1", status: "completed" } } });
  await expect(first).resolves.toBe(output);
  expect(sent.filter((request) => request.method === "turn/start")).toHaveLength(1);
});

it("cancels the actual turn returned by turn/start without requiring a start notification", async () => {
  autoComplete = false;
  const controller = new AbortController(), onCancelError = vi.fn();
  const active = runCodexTextPrompt({ cwd: "/repo", prompt: "Side", signal: controller.signal, onCancelError });
  await vi.waitFor(() => expect(sent.some((request) => request.method === "turn/start")).toBe(true));
  const priorKills = killChild.mock.calls.length;
  controller.abort(); await expect(active).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(killChild.mock.calls.length).toBeGreaterThan(priorKills));
  expect(sent.filter((request) => request.method === "turn/interrupt").map((request) => request.params))
    .toEqual([{ threadId: "thread_1", turnId: "turn_1" }]);
  expect(onCancelError).not.toHaveBeenCalled();
});

it.each(["response", "notification"] as const)("waits for a late start %s after cancellation and holds the queue until that side turn is interrupted", async (identitySource) => {
  autoComplete = false; holdTurnStart = true;
  const controller = new AbortController(), onCancelError = vi.fn();
  const active = runCodexTextPrompt({ cwd: "/repo", prompt: "Side", signal: controller.signal, onCancelError });
  await vi.waitFor(() => expect(sent.some((request) => request.method === "turn/start")).toBe(true));
  const start = sent.find((request) => request.method === "turn/start")!, oldReceiver = onLine!;
  // Unrelated notifications cannot supply an interrupt target or end this side turn.
  receive({ method: "turn/started", params: { threadId: "parent", turn: { id: "parent_turn" } } });
  receive({ method: "turn/completed", params: { threadId: "parent", turn: { id: "parent_turn", status: "completed" } } });
  controller.abort(); await expect(active).rejects.toThrow("cancelled");
  const next = runCodexTextPrompt({ cwd: "/repo", prompt: "Next" });
  expect(sent.some((request) => request.method === "turn/interrupt")).toBe(false);
  expect(sent.filter((request) => request.method === "turn/start")).toHaveLength(1);
  holdTurnStart = false; autoComplete = true;
  if (identitySource === "response") receive({ id: start.id, result: { turn: { id: "late_turn" } } });
  else receive({ method: "turn/started", params: { threadId: "thread_1", turn: { id: "late_turn" } } });
  await expect(next).resolves.toBe(output);
  expect(sent.filter((request) => request.method === "turn/interrupt").map((request) => request.params))
    .toEqual([{ threadId: "thread_1", turnId: "late_turn" }]);
  expect(onCancelError).not.toHaveBeenCalled();
  oldReceiver(JSON.stringify({ id: start.id, result: { turn: { id: "late_turn" } } }));
  expect(sent.filter((request) => request.method === "turn/start")).toHaveLength(2);
});

it("uses a matching turn/started notification before the start RPC response arrives", async () => {
  autoComplete = false; holdTurnStart = true;
  const controller = new AbortController();
  const active = runCodexTextPrompt({ cwd: "/repo", prompt: "Side", signal: controller.signal });
  await vi.waitFor(() => expect(sent.some((request) => request.method === "turn/start")).toBe(true));
  const priorKills = killChild.mock.calls.length;
  receive({ method: "turn/started", params: { threadId: "thread_1", turn: { id: "notified_turn" } } });
  controller.abort(); await expect(active).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(killChild.mock.calls.length).toBeGreaterThan(priorKills));
  expect(sent.find((request) => request.method === "turn/interrupt")?.params)
    .toEqual({ threadId: "thread_1", turnId: "notified_turn" });
});

it("does not start generation when cancellation precedes a delayed thread/start response", async () => {
  holdThreadStart = true;
  const controller = new AbortController();
  const active = runCodexTextPrompt({ cwd: "/repo", prompt: "Side", signal: controller.signal });
  await vi.waitFor(() => expect(threadStarts()).toHaveLength(1));
  const priorKills = killChild.mock.calls.length;
  controller.abort(); await expect(active).rejects.toThrow("cancelled");
  receive({ id: threadStarts()[0].id, result: { thread: { id: "late_thread" } } });
  await vi.waitFor(() => expect(killChild.mock.calls.length).toBeGreaterThan(priorKills));
  expect(sent.some((request) => request.method === "turn/start" || request.method === "turn/interrupt")).toBe(false);
});

it("sends a valid interrupt on generation timeout and records native interrupt rejection", async () => {
  autoComplete = false; failInterrupt = true;
  const onCancelError = vi.fn();
  await expect(runCodexTextPrompt({ cwd: "/repo", prompt: "Side", timeoutMs: 20, onCancelError }))
    .rejects.toThrow("interrupt rejected");
  expect(sent.find((request) => request.method === "turn/interrupt")?.params)
    .toEqual({ threadId: "thread_1", turnId: "turn_1" });
  expect(onCancelError).toHaveBeenCalledOnce();
  expect(onCancelError.mock.calls[0][0].message).toContain("side interrupt failed");
});

it("reports unconfirmed native cancellation if no turn ID arrives instead of sending a missing-field interrupt", async () => {
  holdTurnStart = true; autoComplete = false;
  const onCancelError = vi.fn();
  await expect(runCodexTextPrompt({ cwd: "/repo", prompt: "Side", timeoutMs: 20, onCancelError }))
    .rejects.toThrow("native cancellation is unconfirmed");
  expect(sent.some((request) => request.method === "turn/interrupt")).toBe(false);
  expect(onCancelError).toHaveBeenCalledOnce();
  expect(killChild).toHaveBeenCalledWith("monocode-codex-text");
});

it("retries the real no-active-turn race only after a matching side start notification", async () => {
  autoComplete = false; noActiveInterruptOnce = true;
  const controller = new AbortController(), onCancelError = vi.fn();
  const active = runCodexTextPrompt({ cwd: "/repo", prompt: "Side", signal: controller.signal, onCancelError });
  await vi.waitFor(() => expect(sent.some((request) => request.method === "turn/start")).toBe(true));
  controller.abort(); await expect(active).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(sent.filter((request) => request.method === "turn/interrupt")).toHaveLength(1));
  const next = runCodexTextPrompt({ cwd: "/repo", prompt: "Next" });
  receive({ method: "turn/started", params: { threadId: "parent", turn: { id: "parent_turn" } } });
  expect(sent.filter((request) => request.method === "turn/interrupt")).toHaveLength(1);
  expect(sent.filter((request) => request.method === "turn/start")).toHaveLength(1);
  autoComplete = true;
  receive({ method: "turn/started", params: { threadId: "thread_1", turn: { id: "turn_1" } } });
  await expect(next).resolves.toBe(output);
  expect(sent.filter((request) => request.method === "turn/interrupt").map((request) => request.params))
    .toEqual([{ threadId: "thread_1", turnId: "turn_1" }, { threadId: "thread_1", turnId: "turn_1" }]);
  expect(onCancelError).not.toHaveBeenCalled();
});

it("handles activation arriving between the interrupt error response and its rejection handler", async () => {
  autoComplete = false; noActiveInterruptOnce = true; startDuringInterruptFailure = true;
  const controller = new AbortController(), onCancelError = vi.fn();
  const active = runCodexTextPrompt({ cwd: "/repo", prompt: "Side", signal: controller.signal, onCancelError });
  await vi.waitFor(() => expect(sent.some((request) => request.method === "turn/start")).toBe(true));
  controller.abort(); await expect(active).rejects.toThrow("cancelled");
  autoComplete = true;
  await expect(runCodexTextPrompt({ cwd: "/repo", prompt: "Next" })).resolves.toBe(output);
  expect(sent.filter((request) => request.method === "turn/interrupt").map((request) => request.params))
    .toEqual([{ threadId: "thread_1", turnId: "turn_1" }, { threadId: "thread_1", turnId: "turn_1" }]);
  expect(onCancelError).not.toHaveBeenCalled();
});

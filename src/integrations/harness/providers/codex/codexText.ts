import { enqueueTextPrompt } from "../../core/textQueue";
import { modelsFor } from "../../../../features/sessions/model/models";
import {
  killChild,
  resolveCodexBinary,
  restoreMonoCodexAgentState,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child";
import {
  asRecord,
  buildThreadStartParams,
  buildTurnStartParams,
  mapCodexNotification,
  stringField,
} from "./codexProtocol";
import type { HarnessEvent } from "../../core/types";
import { JsonRpcClient, type JsonRpcId } from "../../core/jsonRpc";
import { prepareCodexMonoContext } from "./codexStore";
import type { TextPromptInput } from "../../core/registry";

import { mergeStream, streamTextDelta } from "../../core/streamText";

const TEXT_CHILD_ID = "monocode-codex-text";
const INIT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 45_000;
const INTERRUPT_TIMEOUT_MS = 5_000;
const TEXT_RUNTIME_MODE = "supervised" as const;
const TEXT_MODEL = "gpt-5.6-luna";
const TEXT_EFFORT = "low";

const BTW_READ_TOOL = {
  name: "monocode_read_context",
  description: "Read saved conversation messages/blocks, only for the selected sources. Parent history ends at the fixed as-of boundary. Paginate with nextBefore or continue a long block with nextOffset/readVersion. No writes or controls.",
  inputSchema: { type: "object", properties: {
    sessionId: { type: "string" }, view: { type: "string", enum: ["messages", "blocks"] },
    before: { type: "string" }, blockId: { type: "string" }, offset: { type: "integer", minimum: 0 },
    readVersion: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 30 },
    maxChars: { type: "integer", minimum: 200, maximum: 12000 },
    maxTotalChars: { type: "integer", minimum: 200, maximum: 8000 },
  }, required: ["sessionId", "view"], additionalProperties: false },
};

type LiveText = {
  rpc: JsonRpcClient;
  cwd: string;
  providerAccountId?: string;
  threadId: string;
  ephemeral: boolean;
  codexStore?: "mono";
  storeConfig?: Record<string, unknown>;
  model: string;
  effort: string;
  serviceTier?: string;
  collecting: boolean;
  output: string;
  closed: boolean;
  turnId?: string;
  turnCompleted?: boolean;
  turnStarted?: (turnId: string, activated?: boolean) => void;
  turnDone: (() => void) | null;
  turnFailed: ((error: Error) => void) | null;
  onEvent?: (event: HarnessEvent) => void;
  readContext?: TextPromptInput["readContext"];
  resumed?: boolean;
};

let live: LiveText | null = null;
let turns: Promise<void> = Promise.resolve();

function pickTextModel(requested?: string): string {
  const selected = requested?.trim();
  if (selected) return selected;
  const models = modelsFor("codex");
  const luna = models.find((model) =>
    /5\.6-luna/i.test(`${model.nativeId ?? ""} ${model.name} ${model.id}`),
  );
  return luna?.nativeId ?? TEXT_MODEL;
}

function pickTextEffort(
  modelId: string,
  modelSettings?: Record<string, string>,
): string {
  const requested =
    modelSettings?.reasoningEffort?.trim() || modelSettings?.effort?.trim();
  const model = modelsFor("codex").find((entry) => entry.nativeId === modelId);
  const setting = model?.settings?.find(
    (entry) => entry.id === "reasoningEffort",
  );
  const options = setting?.options?.map((option) => option.value) ?? [];
  if (requested && (options.length === 0 || options.includes(requested))) {
    return requested;
  }
  if (options.includes("low")) return "low";
  if (options.includes("none")) return "none";
  if (setting?.value && options.includes(setting.value)) return setting.value;
  return TEXT_EFFORT;
}

function pickTextServiceTier(
  modelSettings?: Record<string, string>,
): string | undefined {
  const value = modelSettings?.serviceTier?.trim();
  return value || undefined;
}

export async function stopCodexTextPrompt(): Promise<void> {
  await dropLive();
}

/** Start the shared Codex app-server in the background so the first prompt is fast. */
export function warmupCodexText(cwd: string): Promise<void> {
  if (!cwd || cwd === "~") return Promise.resolve();
  const run = turns
    .catch(() => undefined)
    .then(async () => {
      await ensureLive({ cwd });
    });
  turns = run.then(
    () => undefined,
    () => undefined,
  );
  return run.catch(() => undefined);
}

/** Codex app-server turn that reuses a warm process, like Cursor text generation. */
export async function runCodexTextPrompt(
  input: TextPromptInput,
): Promise<string> {
  if (input.model !== undefined && !input.model.trim()) {
    throw new Error("The selected Codex model is unavailable.");
  }
  const queued = enqueueTextPrompt(turns, input, () => promptOnLive(input));
  turns = queued.tail;
  return queued.result;
}

async function promptOnLive(input: TextPromptInput): Promise<string> {
  input.signal?.throwIfAborted();
  const session = await ensureLive(input);
  if (input.signal?.aborted) {
    await dropLive();
    input.signal.throwIfAborted();
  }
  session.output = "";
  session.collecting = true;
  session.turnId = undefined;
  session.turnCompleted = false;
  session.onEvent = input.onEvent;
  session.readContext = input.readContext;
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let turnStart: Promise<unknown> | undefined;
  let resolveTurnId!: () => void;
  let resolveTurnActive!: () => void;
  const turnIdReady = new Promise<void>((resolve) => { resolveTurnId = resolve; });
  const turnActive = new Promise<void>((resolve) => { resolveTurnActive = resolve; });
  session.turnStarted = (turnId, activated = false) => {
    if (session.turnId && session.turnId !== turnId) return;
    if (!session.turnId) {
      session.turnId = turnId;
      resolveTurnId();
    }
    if (activated) {
      resolveTurnActive();
    }
  };
  const turnPromise = new Promise<void>((resolve, reject) => {
    session.turnDone = resolve;
    session.turnFailed = reject;
  });
  // Notifications can fail/complete the turn before turn/start returns.
  void turnPromise.catch(() => undefined);
  let abortHandler: (() => void) | undefined;
  const abortPromise = input.signal
    ? new Promise<void>((_, reject) => {
        abortHandler = () => {
          reject(new Error("By-the-way request cancelled"));
        };
        input.signal!.addEventListener("abort", abortHandler, { once: true });
        if (input.signal!.aborted) abortHandler();
      })
    : null;

  try {
    input.signal?.throwIfAborted();
    turnStart = session.rpc.request<{ turn?: { id?: string } }>(
      "turn/start",
      { ...buildTurnStartParams({
        threadId: session.threadId,
        runtimeMode: TEXT_RUNTIME_MODE,
        prompt: session.resumed && input.resumePrompt ? input.resumePrompt : input.prompt,
        model: session.model || undefined,
        effort: session.effort,
        serviceTier: session.serviceTier,
        intent: "plan",
      }),
        sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" },
      timeoutMs,
    ).then((started) => {
      const turnId = started.turn?.id?.trim();
      if (!turnId) throw new Error("Codex did not return the side turn id");
      if (session.turnId && session.turnId !== turnId)
        throw new Error("Codex side turn id differs from its start notification");
      session.turnStarted?.(turnId);
      return started;
    });
    await Promise.race([turnStart, ...(abortPromise ? [abortPromise] : [])]);

    await Promise.race([
      turnPromise,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Codex text generation timed out")),
          timeoutMs,
        );
      }),
      ...(abortPromise ? [abortPromise] : []),
    ]);

    return session.output;
  } catch (error) {
    session.collecting = false;
    if (turnStart && !session.turnCompleted) {
      // Cancellation must not lose a late start. The provider queue remains
      // held while we wait for either the response or the matching notification.
      if (!session.turnId) await Promise.race([
        turnIdReady,
        turnStart.then(() => undefined, () => undefined),
      ]);
      let cancellationError: Error | undefined;
      if (!session.turnId && !session.turnCompleted) {
        cancellationError = new Error("Codex side turnId is unavailable; no interrupt was sent. The dedicated text process was closed; native cancellation is unconfirmed.");
      } else if (!session.turnCompleted) {
        try {
          const interrupt = () => session.rpc.request("turn/interrupt", {
            threadId: session.threadId, turnId: session.turnId,
          }, INTERRUPT_TIMEOUT_MS);
          try { await interrupt(); }
          catch (failure) {
            // Installed Codex can return turn/start before registering its
            // active turn. Retry this specific race only after its notification.
            if (!(failure instanceof Error) || !/no active turn to interrupt/i.test(failure.message))
              throw failure;
            await waitForInterruptedTurn(Promise.race([turnActive, turnPromise]));
            if (!session.turnCompleted) await interrupt();
          }
          await waitForInterruptedTurn(turnPromise);
        } catch (failure) {
          cancellationError = new Error(`Codex side interrupt failed (${session.threadId}/${session.turnId}): ${failure instanceof Error ? failure.message : String(failure)}`);
        }
      }
      if (cancellationError) {
        input.onCancelError?.(cancellationError);
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${cancellationError.message}`);
      }
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortHandler && input.signal) {
      input.signal.removeEventListener("abort", abortHandler);
    }
    session.collecting = false;
    session.turnDone = null;
    session.turnFailed = null;
    session.turnStarted = undefined;
    session.onEvent = undefined;
    session.readContext = undefined;
    await dropLive();
  }
}

async function waitForInterruptedTurn(turn: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([turn, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Codex interrupt completion was not confirmed")), INTERRUPT_TIMEOUT_MS);
    })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
async function ensureLive(input: {
  cwd: string;
  providerAccountId?: string;
  model?: string;
  modelSettings?: Record<string, string>;
  ephemeral?: boolean;
  codexStore?: "mono";
  threadId?: string;
  onThreadId?: (threadId: string) => void;
  readContext?: TextPromptInput["readContext"];
}): Promise<LiveText> {
  const model = pickTextModel(input.model);
  const effort = pickTextEffort(model, input.modelSettings);
  const serviceTier = pickTextServiceTier(input.modelSettings);
  // Titles, commit messages, branch names, and PR content must never become
  // saved Codex conversations. Only resumable side questions opt into storage.
  const ephemeral = input.ephemeral ?? true;
  const requestedThreadId = ephemeral
    ? undefined
    : input.threadId?.trim() || undefined;
  if (live && !live.closed) {
    if (
      live.cwd === input.cwd &&
      live.model === model &&
      live.effort === effort &&
      live.serviceTier === serviceTier &&
      live.providerAccountId === input.providerAccountId &&
      live.ephemeral === ephemeral &&
      live.codexStore === input.codexStore &&
      (!requestedThreadId || live.threadId === requestedThreadId)
    ) {
      input.onThreadId?.(live.threadId);
      return live;
    }
    if (
      live.providerAccountId !== input.providerAccountId ||
      live.codexStore !== input.codexStore
    ) {
      await dropLive();
      const started = await startLive(
        input.cwd,
        input.providerAccountId,
        model,
        effort,
        serviceTier,
        requestedThreadId,
        ephemeral,
        input.codexStore,
      );
      input.onThreadId?.(started.threadId);
      return started;
    }
    try {
      live.model = model;
      live.effort = effort;
      live.serviceTier = serviceTier;
      await openThread(live, input.cwd, requestedThreadId, ephemeral);
      input.onThreadId?.(live.threadId);
      return live;
    } catch (error) {
      await dropLive();
      throw error;
    }
  }
  const started = await startLive(
    input.cwd,
    input.providerAccountId,
    model,
    effort,
    serviceTier,
    requestedThreadId,
    ephemeral,
    input.codexStore,
  );
  input.onThreadId?.(started.threadId);
  return started;
}

async function startLive(
  cwd: string,
  providerAccountId?: string,
  model = pickTextModel(),
  effort = pickTextEffort(model),
  serviceTier?: string,
  requestedThreadId?: string,
  ephemeral = true,
  codexStore?: "mono",
): Promise<LiveText> {
  await dropLive();
  const { path } = await resolveCodexBinary();
  const store =
    codexStore === "mono"
      ? await prepareCodexMonoContext({
          sessionId: TEXT_CHILD_ID,
          path,
          cwd,
          providerAccountId,
          threadId: requestedThreadId,
        })
      : undefined;
  const sessionRef: { session: LiveText | null } = { session: null };
  const rpc = new JsonRpcClient(
    TEXT_CHILD_ID,
    {
      onNotification: (method, params) => {
        handleNotification(sessionRef.session, method, params);
      },
      onRequest: (id, method, params) => {
        void handleServerRequest(rpc, id, method, params, sessionRef.session);
      },
    },
    { includeJsonrpc: false, label: "codex-text" },
  );

  const session: LiveText = {
    rpc,
    cwd,
    providerAccountId,
    threadId: "",
    ephemeral,
    codexStore,
    model,
    effort,
    serviceTier,
    collecting: false,
    output: "",
    closed: false,
    turnDone: null,
    turnFailed: null,
  };

  sessionRef.session = session;

  watchChild(
    TEXT_CHILD_ID,
    (line) => rpc.pushLine(line),
    () => {
      session.closed = true;
      if (live === session) live = null;
      session.turnFailed?.(new Error("Codex text generator exited"));
      session.turnDone = null;
      session.turnFailed = null;
      rpc.close(new Error("Codex text generator exited"));
    },
  );

  try {
    await spawnChild(
      TEXT_CHILD_ID,
      path,
      ["app-server"],
      cwd,
      {
        provider: "codex",
        id: providerAccountId ?? "default",
      },
      "codex",
      codexStore,
    );
    await rpc.request(
      "initialize",
      {
        clientInfo: {
          name: "monocode-text",
          title: "MonoCode",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
      INIT_TIMEOUT_MS,
    );
    await rpc.notify("initialized", undefined);
    await openThread(session, cwd, requestedThreadId, ephemeral, store);
    live = session;
    return session;
  } catch (error) {
    session.closed = true;
    rpc.close(error instanceof Error ? error : new Error(String(error)));
    unwatchChild(TEXT_CHILD_ID);
    await killChild(TEXT_CHILD_ID).catch(() => undefined);
    throw error;
  }
}

async function openThread(
  session: LiveText,
  cwd: string,
  requestedThreadId: string | undefined,
  ephemeral: boolean,
  preparedStore?: Awaited<ReturnType<typeof prepareCodexMonoContext>>,
): Promise<void> {
  let opened: { thread?: { id?: string } } | undefined;
  if (session.codexStore === "mono") {
    const { path } = await resolveCodexBinary();
    const store =
      preparedStore ??
      (await prepareCodexMonoContext({
        sessionId: TEXT_CHILD_ID,
        path,
        cwd,
        providerAccountId: session.providerAccountId,
        threadId: requestedThreadId,
      }));
    session.storeConfig = store.config;
    if (requestedThreadId && store.hasThread)
      await restoreMonoCodexAgentState(
        session.providerAccountId,
        requestedThreadId,
      );
  }
  const params = buildThreadStartParams({
    cwd,
    runtimeMode: TEXT_RUNTIME_MODE,
    model: session.model || undefined,
    serviceTier: session.serviceTier,
  });
  params.sandbox = "read-only";
  params.approvalPolicy = "never";
  if (session.storeConfig)
    params.config = {
      ...session.storeConfig,
      ...(params.config as Record<string, unknown> | undefined),
    };
  if (requestedThreadId) {
    try {
      opened = await session.rpc.request<{ thread?: { id?: string } }>(
        "thread/resume",
        {
          threadId: requestedThreadId,
          ...params,
        },
        INIT_TIMEOUT_MS,
      );
    } catch (error) {
      throw new Error(`Saved side thread could not be resumed. Start a new discussion explicitly. ${error instanceof Error ? error.message : String(error)}`);
    }
    if (opened?.thread?.id?.trim() !== requestedThreadId) throw new Error("Codex did not resume the requested saved side thread; no context was reinjected.");
  }
  if (!opened) {
    opened = await session.rpc.request<{ thread?: { id?: string } }>(
      "thread/start",
      {
        ...params,
        ...(ephemeral ? { ephemeral: true } : {}),
        dynamicTools: [BTW_READ_TOOL],
      },
      INIT_TIMEOUT_MS,
    );
  }
  const threadId = opened.thread?.id?.trim();
  if (!threadId) throw new Error("Codex did not return a thread id");
  session.cwd = cwd;
  session.threadId = threadId;
  session.ephemeral = ephemeral;
  session.resumed = !!requestedThreadId;
}
async function dropLive(): Promise<void> {
  const current = live;
  live = null;
  if (current) {
    current.closed = true;
    current.rpc.close();
  }
  unwatchChild(TEXT_CHILD_ID);
  await killChild(TEXT_CHILD_ID).catch(() => undefined);
}

function handleNotification(
  session: LiveText | null,
  method: string,
  params: unknown,
): void {
  if (!session || session.closed) return;
  const record = asRecord(params);
  if (stringField(record, "threadId") !== session.threadId) return;
  const turn = asRecord(record?.turn);
  const turnId = stringField(turn, "id");
  if (method === "turn/started" && turnId) session.turnStarted?.(turnId, true);
  if (method === "turn/completed") {
    if (!turnId || (session.turnId && session.turnId !== turnId)) return;
    session.turnStarted?.(turnId, true);
    session.turnCompleted = true;
    const status = stringField(turn, "status") ?? "completed";
    if (status === "failed") {
      const message = stringField(asRecord(turn?.error), "message") ?? "Codex turn failed";
      session.turnFailed?.(new Error(message));
    } else {
      session.turnDone?.();
    }
    session.turnDone = null;
    session.turnFailed = null;
  }
  if (!session.collecting) return;
  const itemTurnId = stringField(record, "turnId");
  if (itemTurnId && session.turnId && itemTurnId !== session.turnId) return;

  const mapped = mapCodexNotification(method, params);
  for (const event of mapped.events) {
    session.onEvent?.(event);
  }

  if (method === "item/agentMessage/delta") {
    const delta = streamTextDelta(asRecord(params)?.delta);
    if (delta) session.output = mergeStream(session.output, delta);
    return;
  }

}

async function handleServerRequest(
  rpc: JsonRpcClient,
  id: JsonRpcId,
  method: string,
  params: unknown,
  session?: LiveText | null,
): Promise<void> {
  if (method === "item/tool/call") {
    const call = asRecord(params);
    let success = false;
    let text: string;
    try {
      if (call?.tool !== BTW_READ_TOOL.name || !session?.readContext || call.threadId !== session.threadId)
        throw new Error("Only selected read-only conversation sources are available.");
      text = JSON.stringify(await session.readContext(call.arguments as Parameters<NonNullable<TextPromptInput["readContext"]>>[0]));
      success = true;
    } catch (error) { text = JSON.stringify({ error: error instanceof Error ? error.message : String(error), readOnly: true }); }
    await rpc.respond(id, { success, contentItems: [{ type: "inputText", text }] }).catch(() => undefined);
    return;
  }
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    await rpc.respond(id, { decision: "decline" }).catch(() => undefined);
    return;
  }
  if (method === "item/permissions/requestApproval") {
    await rpc.respond(id, { permissions: {} }).catch(() => undefined);
    return;
  }
  await rpc.respond(id, {}).catch(() => undefined);
}

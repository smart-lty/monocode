// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  newSession,
  type Session,
} from "../../../features/sessions/model/session";
import { createEditedResendAttempt } from "../../../features/sessions/model/editLastTurn";
import {
  enqueueQueuedMessage,
  dequeueQueuedMessage,
  canDispatchQueuedHead,
} from "../../../features/sessions/model/messageQueue";
import { referencesRequireNewTurn } from "../../../features/sessions/model/sessionReferenceDelivery";
import {
  prepareSessionReferenceTurn,
  referencedSessionIds,
  type SessionReference,
} from "../../../features/sessions/model/sessionReferences";
import { upsertSession } from "../../../features/sessions/data/sessionStore";
import { appendUser } from "./apply";
import {
  registerHarness,
  resetHarnessIdlePark,
  rewindHarnessLastTurn,
  sendHarnessTurn,
  type HarnessAdapter,
} from "./registry";
import type { SendTurnInput } from "./types";

const rpc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: rpc.invoke,
  isTauri: () => true,
}));
const ref = (sessionId: string): SessionReference => ({
  sessionId,
  title: sessionId,
  cwd: "/external",
  harness: "codex",
});
const sourceHost = {
  cliPath: async () => "/Applications/MonoCode.app/Contents/MacOS/monocode",
  snapshot: async (id: string) => ({
    id,
    title: id,
    cwd: "/external",
    harness: "codex" as const,
    model: "codex:test",
    updatedAt: 1,
    readVersion: "v1",
    blocks: [
      { id: `source-${id}`, role: "user" as const, text: `requirement-${id}` },
    ],
  }),
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function adapter(
  sendTurn: HarnessAdapter["sendTurn"],
  extra: Partial<HarnessAdapter> = {},
): HarnessAdapter {
  return {
    id: "codex",
    live: true,
    sendTurn,
    steerTurn: vi.fn(async () => {}),
    cancelTurn: vi.fn(async () => {}),
    respondApproval() {},
    stopSession: vi.fn(async () => {}),
    forgetSession: vi.fn(async () => {}),
    bindSession() {},
    ...extra,
  };
}
function input(
  session: Session,
  text: string,
): SendTurnInput & { harness: "codex" } {
  return {
    harness: "codex",
    sessionId: session.id,
    cwd: session.cwd,
    model: session.model,
    runtimeMode: "auto",
    text,
    appAccess: false,
    onEvent: vi.fn(),
  };
}

// Mock the native RPC boundary only. Use the real persistence sanitizer/write
// queue, edit/append operations and harness dispatch. Rust tests separately run
// the actual DB-derived authorization and server wait/recheck path.
let records: Map<string, Session>;
let trace: {
  action: string;
  pending?: boolean;
  ids?: string[];
  turnId?: string;
}[];
let blockedSave: ReturnType<typeof deferred> | undefined;
beforeEach(() => {
  localStorage.clear();
  records = new Map();
  trace = [];
  blockedSave = undefined;
  rpc.invoke
    .mockReset()
    .mockImplementation(
      async (action: string, args: Record<string, unknown>) => {
        if (action === "session_upsert") {
          const session = args.session as Session;
          trace.push({
            action: "save:start",
            ids: referencedSessionIds(session.blocks),
          });
          await blockedSave?.promise;
          records.set(session.id, structuredClone(session));
          trace.push({
            action: "save:done",
            ids: referencedSessionIds(session.blocks),
          });
          return {
            ...session,
            hasUserMessage: true,
            hasDraft: false,
            archived: false,
            createdAt: 1,
            updatedAt: 1,
          };
        }
        if (action === "control_authorize_turn") {
          trace.push({
            action,
            pending: args.referencesPending === true,
            ids: referencedSessionIds(
              records.get(args.sessionId as string)!.blocks,
            ),
          });
          return "native-reference-turn-id";
        }
        if (action === "control_refresh_references") {
          trace.push({
            action,
            ids: referencedSessionIds(
              records.get(args.sessionId as string)!.blocks,
            ),
            turnId: args.turnId as string,
          });
          return true;
        }
        if (action === "control_turn_finished") {
          trace.push({ action });
          return;
        }
        throw new Error(`Unexpected native call: ${action}`);
      },
    );
});
afterEach(() => {
  resetHarnessIdlePark();
});

describe("reference send boundaries (mock provider/native RPC)", () => {
  it.each([
    {
      name: "replace old by new",
      added: [ref("new")],
      prefix: [],
      expected: ["new"],
    },
    { name: "remove all", added: [], prefix: [], expected: [] },
    {
      name: "retain earlier source and replace latest",
      added: [ref("new")],
      prefix: [ref("kept")],
      expected: ["kept", "new"],
    },
  ])(
    "gates the actual edited resend through acceptance and durable save: $name",
    async ({ added, prefix, expected }) => {
      let current: Session = {
        ...newSession("codex", "/project", "codex:test"),
        id: `edit-${expected.join("-") || "none"}`,
        blocks: [
          {
            id: "prefix",
            role: "user" as const,
            text: "earlier",
            providerTurnId: "previous",
            sessionReferences: prefix,
          },
          {
            id: "old",
            role: "user" as const,
            text: "old prompt",
            providerTurnId: "old-native-turn",
            sessionReferences: [ref("old")],
          },
        ],
      };
      await upsertSession(current);
      trace = [];
      const attempt = createEditedResendAttempt(current)!;
      let sendingInput!: SendTurnInput;
      const done = deferred();
      const rewind = vi.fn(async () => ({ submitted: false }));
      registerHarness(
        adapter(
          async (value) => {
            sendingInput = value;
            await done.promise;
          },
          { rewindLastTurn: rewind },
        ),
      );
      await rewindHarnessLastTurn({
        ...input(current, ""),
        providerTurnId: attempt.providerTurnId,
      });
      attempt.markProviderRewound();
      expect(rewind).toHaveBeenCalledOnce();
      const prepared = await prepareSessionReferenceTurn(
        {
          sessionId: current.id,
          blocks: attempt.blocks,
          added,
          prompt: "replacement",
        },
        sourceHost,
      );
      const prompt = prepared.context
        ? `replacement\n\n${prepared.context}`
        : "replacement";
      const save = (blockedSave = deferred());
      let finished = false;
      const sending = sendHarnessTurn({
        ...input(current, prompt),
        sessionReferenceAccess: prepared.references.length > 0,
        sessionReferenceAuthorizationPending: true,
        onAccepted: () => {
          current = appendUser(attempt.replace(current), "replacement", [], {
            sessionReferences: added,
          });
          attempt.markAccepted();
          return upsertSession(current).then((saved) => {
            if (!saved) throw new Error("save rejected");
          });
        },
      }).then(() => {
        finished = true;
      });
      await vi.waitFor(() => expect(sendingInput).toBeDefined());
      expect(trace[0]).toEqual({
        action: "control_authorize_turn",
        pending: true,
        ids: [...prefix.map((item) => item.sessionId), "old"],
      });
      expect(sendingInput.text).not.toContain("来源 ID=old");
      for (const id of expected)
        expect(sendingInput.text).toContain(`来源 ID=${id}`);
      if (!expected.length) expect(sendingInput.text).toBe("replacement");
      sendingInput.onAccepted!();
      await vi.waitFor(() =>
        expect(trace.some((item) => item.action === "save:start")).toBe(true),
      );
      expect(referencedSessionIds(current.blocks)).toEqual(expected);
      expect(referencedSessionIds(records.get(current.id)!.blocks)).toEqual([
        ...prefix.map((item) => item.sessionId),
        "old",
      ]);
      expect(
        trace.some((item) => item.action === "control_refresh_references"),
      ).toBe(false);
      // Provider completion cannot clear the gate or race the acceptance save.
      done.resolve();
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(
        trace.some((item) => item.action === "control_turn_finished"),
      ).toBe(false);
      save.resolve();
      await sending;
      expect(trace.map((item) => item.action)).toEqual([
        "control_authorize_turn",
        "save:start",
        "save:done",
        "control_refresh_references",
        "control_turn_finished",
      ]);
      expect(trace.at(-2)).toEqual({
        action: "control_refresh_references",
        ids: expected,
        turnId: "native-reference-turn-id",
      });
      expect(referencedSessionIds(records.get(current.id)!.blocks)).toEqual(
        expected,
      );
    },
  );

  it("keeps a first reference unsent in the real queue path, then persists before starting a fresh CLI-capable turn", async () => {
    let current: Session = {
      ...newSession("codex", "/project", "codex:test"),
      id: "first-steer-reference",
      busy: true,
      blocks: [
        {
          id: "running",
          role: "user" as const,
          text: "running without references",
        },
      ],
    };
    const send = vi.fn(async (_value: SendTurnInput) => {}),
      steer = vi.fn(async () => {});
    registerHarness(adapter(send, { steerTurn: steer }));
    expect(referencesRequireNewTurn(current.blocks, [ref("new")], false)).toBe(
      true,
    );
    current = enqueueQueuedMessage(current, {
      id: "queued-reference",
      text: "use this",
      attachments: [],
      sessionReferences: [ref("new")],
    });
    await upsertSession(current);
    expect(referencedSessionIds(records.get(current.id)!.blocks)).toEqual([]);
    expect(canDispatchQueuedHead(current)).toBe(false);
    expect(current.queuedMessages).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(trace.some((item) => item.action.startsWith("control_"))).toBe(
      false,
    );
    current = { ...current, busy: false };
    expect(canDispatchQueuedHead(current)).toBe(true);
    const message = current.queuedMessages![0];
    const prepared = await prepareSessionReferenceTurn(
      {
        sessionId: current.id,
        blocks: current.blocks,
        added: message.sessionReferences,
        prompt: message.text,
      },
      sourceHost,
    );
    current = appendUser(
      dequeueQueuedMessage(current, message.id),
      message.text,
      message.attachments,
      { sessionReferences: message.sessionReferences },
    );
    await upsertSession(current);
    await sendHarnessTurn({
      ...input(current, `${message.text}\n\n${prepared.context}`),
      sessionReferenceAccess: true,
    });
    expect(
      trace.find((item) => item.action === "control_authorize_turn"),
    ).toEqual({
      action: "control_authorize_turn",
      pending: false,
      ids: ["new"],
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        controlsAgents: true,
        appAccess: false,
        text: expect.stringContaining("来源 ID=new"),
      }),
    );
    expect(steer).not.toHaveBeenCalled();
    expect(records.get(current.id)!.queuedMessages).toBeUndefined();
  });

  it("allows existing transport scopes to steer, but drafts and queued selections cannot stand in for a sent reference", () => {
    const sent = {
      id: "u",
      role: "user" as const,
      text: "sent",
      sessionReferences: [ref("old")],
    };
    expect(referencesRequireNewTurn([sent], [ref("new")], false)).toBe(false);
    expect(
      referencesRequireNewTurn([{ ...sent, draft: true }], [ref("new")], false),
    ).toBe(true);
    expect(
      referencesRequireNewTurn(
        [{ ...sent, internal: true }],
        [ref("new")],
        false,
      ),
    ).toBe(true);
    expect(referencesRequireNewTurn([], [ref("new")], true)).toBe(false);
  });

  it("fails closed and awaits cancellation when an accepted replacement cannot be saved", async () => {
    const current = {
      ...newSession("codex", "/project", "codex:test"),
      id: "save-failure",
      blocks: [
        {
          id: "old",
          role: "user" as const,
          text: "old",
          sessionReferences: [ref("old")],
        },
      ],
    };
    await upsertSession(current);
    trace = [];
    const cancelled = vi.fn(async () => {});
    registerHarness(
      adapter(
        async (value) => {
          value.onAccepted!();
        },
        { cancelTurn: cancelled },
      ),
    );
    await expect(
      sendHarnessTurn({
        ...input(current, "new"),
        sessionReferenceAuthorizationPending: true,
        onAccepted: async () => {
          throw new Error("DB save failed");
        },
      }),
    ).rejects.toThrow("DB save failed");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(trace.map((item) => item.action)).toEqual([
      "control_authorize_turn",
      "control_turn_finished",
    ]);
    expect(referencedSessionIds(records.get(current.id)!.blocks)).toEqual([
      "old",
    ]);
  });

  it("keeps the saved references unchanged when the provider rejects before accepting the edit", async () => {
    const current: Session = {
      ...newSession("codex", "/project", "codex:test"),
      id: "rejected-edit",
      blocks: [
        {
          id: "old",
          role: "user",
          text: "old",
          sessionReferences: [ref("old")],
        },
      ],
    };
    await upsertSession(current);
    trace = [];
    const accepted = vi.fn();
    const cancelled = vi.fn(async () => {});
    registerHarness(
      adapter(
        async () => {
          throw new Error("provider rejected before acceptance");
        },
        { cancelTurn: cancelled },
      ),
    );
    await expect(
      sendHarnessTurn({
        ...input(current, "replacement with new source"),
        sessionReferenceAccess: true,
        sessionReferenceAuthorizationPending: true,
        onAccepted: accepted,
      }),
    ).rejects.toThrow("provider rejected before acceptance");
    expect(accepted).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
    expect(trace.map((item) => item.action)).toEqual([
      "control_authorize_turn",
      "control_turn_finished",
    ]);
    expect(referencedSessionIds(records.get(current.id)!.blocks)).toEqual([
      "old",
    ]);
  });
});

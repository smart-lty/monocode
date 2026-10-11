import { expect, it, vi } from "vitest";
import { btwContextReader } from "./btwContext";
import { newSession, type BtwThread } from "../../sessions/model/session";
import { sanitizeSessionForPersist } from "../../sessions/data/sessionStore";
import { buildBtwPrompt, buildBtwResumePrompt, btwReturnDraftText, cancelBtwThread, queueBtwThread } from "../../sessions/model/btw";
import { appendComposerInsert } from "../../sessions/model/quoteDraft";
import { enqueueTextPrompt } from "../../../integrations/harness/core/textQueue";

const reference = (sessionId: string) => ({ sessionId, title: sessionId, cwd: `/${sessionId}`, harness: "codex" as const });
const thread = (): BtwThread => ({ id: "side1", sourceEndBlockId: "a1", createdAt: 1, updatedAt: 2,
  status: "queued", harness: "codex", contextScope: "as-of a1; read-only supplementation", readSources: [reference("before_ref")],
  messages: [{ id: "q1", role: "user", text: "Question", createdAt: 1 },
    { id: "answer", role: "assistant", text: "Selected conclusion. Other discussion.", createdAt: 2 },
    { id: "q2", role: "user", text: "Follow-up", createdAt: 3 }] });
function source() {
  const src = newSession("codex", "/repo", "gpt-6.1-sol", "full-access"); src.id = "parent";
  src.blocks = [{ id: "u1", role: "user", text: "BEFORE_ALPHA", durationMs: 1, sessionReferences: [reference("before_ref")], btwThreads: [thread()] },
    { id: "a1", role: "assistant", text: "FIRST_ANSWER" },
    { id: "u2", role: "user", text: "AFTER_OMEGA", sessionReferences: [reference("later_ref")] }];
  return src;
}
it("bounds parent supplement reads to as-of and authorizes only selected sent-before sources", async () => {
  const src = source();
  const saved = async (id: string) => ({ id, title: id, cwd: "/repo", updatedAt: 99, readVersion: "saved-v1",
    blocks: id === src.id ? src.blocks : [{ id: "r1", role: "user" as const, text: "Reference" }] });
  const read = btwContextReader(src, thread(), saved);
  const page = await read({ sessionId: src.id, view: "messages" });
  expect(JSON.stringify(page)).toContain("BEFORE_ALPHA"); expect(JSON.stringify(page)).not.toContain("AFTER_OMEGA");
  await expect(read({ sessionId: src.id, view: "blocks", blockId: "u2" })).rejects.toThrow();
  await expect(read({ sessionId: "later_ref", view: "messages" })).rejects.toThrow("仅可只读");
  await expect(read({ sessionId: "arbitrary", view: "messages" })).rejects.toThrow();
  await expect(read({ sessionId: "before_ref", view: "messages" })).resolves.toMatchObject({ readOnly: true });
  await expect(read({ sessionId: src.id, view: "messages", action: "write" } as never)).rejects.toThrow("写入");
  const revision = page.readVersion;
  src.blocks.push({ id: "u3", role: "user", text: "STILL_LATER" });
  expect((await read({ sessionId: src.id, view: "messages", readVersion: revision })).readVersion).toBe(revision);
  src.blocks[0].text = "Edited old prefix";
  await expect(read({ sessionId: src.id, view: "messages", readVersion: revision })).rejects.toThrow("changed");
});
it("supports lossless UTF-16 continuation in the bounded parent without leaking later blocks", async () => {
  const src = source(); src.blocks[0].text = "中文😀".repeat(900);
  const read = btwContextReader(src, thread(), async () => ({ id: src.id, title: "Parent", cwd: src.cwd,
    updatedAt: 1, readVersion: "saved-v1", blocks: src.blocks }));
  let page = await read({ sessionId: src.id, view: "messages", blockId: "u1", maxChars: 201 });
  let text = page.blocks[0].text;
  while (page.blocks[0].nextOffset != null) {
    page = await read({ sessionId: src.id, view: "messages", blockId: "u1", maxChars: 201,
      offset: page.blocks[0].nextOffset, readVersion: page.readVersion });
    text += page.blocks[0].text;
  }
  expect(text).toBe(src.blocks[0].text);
  expect(text).not.toContain("AFTER_OMEGA");
});
it("preserves queued discussion/scope and exposes an append-only conclusion draft without execution", () => {
  const src = source();
  const persisted = sanitizeSessionForPersist(src).blocks[0].btwThreads![0];
  expect(persisted.status).toBe("queued"); expect(persisted.readSources).toEqual(thread().readSources);
  expect(persisted.contextScope).toContain("as-of");
  const prompt = buildBtwPrompt({ blocks: src.blocks, thread: thread() });
  expect(prompt).not.toContain("AFTER_OMEGA"); expect(prompt).not.toContain("later_ref");
  expect(prompt).toContain("finite excerpts");
  const resume = buildBtwResumePrompt(thread());
  expect(resume).toContain("Follow-up"); expect(resume).not.toContain("Selected conclusion.");
  const returned = btwReturnDraftText(src, { sessionId: src.id, threadId: "side1", messageId: "answer", text: "Selected conclusion." });
  const draft = appendComposerInsert("Existing main draft", returned);
  expect(draft).toContain("Existing main draft"); expect(draft).toContain("as-of a1");
  expect(draft).not.toContain("Other discussion");
  expect(() => btwReturnDraftText(src, { sessionId: "wrong", threadId: "side1", messageId: "answer", text: "Selected conclusion." })).toThrow();
  expect(() => btwReturnDraftText(src, { sessionId: src.id, threadId: "side1", messageId: "missing", text: "invented" })).toThrow();
  expect(src.blocks).toHaveLength(3); // Producing the editable draft never submits a main turn.
});

it("accepts rendered selections across formatting and links with verified assistant message provenance", () => {
  const src = source(), side = src.blocks[0].btwThreads![0];
  side.messages[1].text = "结论：**保留缓存**，再重试。阅读[原文](https://example.com/context)之后继续。";
  for (const text of ["结论：保留缓存，再重试。", "再重试。阅读原文之后继续。"])
    expect(btwReturnDraftText(src, { sessionId: src.id, threadId: side.id, messageId: "answer", text })).toContain(text);
  expect(() => btwReturnDraftText(src, { sessionId: src.id, threadId: side.id, messageId: "q1", text: "Question" })).toThrow();
  expect(() => btwReturnDraftText(src, { sessionId: src.id, threadId: side.id, messageId: "answer", text: "  " })).toThrow();
});

it("cancels a queued Btw without inventing an answer or cancelling other provider requests", async () => {
  let release!: () => void;
  const otherController = new AbortController();
  const first = enqueueTextPrompt(Promise.resolve(), { signal: otherController.signal },
    () => new Promise<string>((resolve) => { release = () => resolve("other answer"); }));
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  let side: BtwThread = { ...thread(), providerThreadId: "saved_side" };
  const messages = side.messages;
  const controller = new AbortController(), execute = vi.fn(async () => "must not run");
  const waiting = enqueueTextPrompt(first.tail, { signal: controller.signal,
    onQueueState: (status) => { side = { ...side, status }; } }, execute);
  controller.abort();
  side = cancelBtwThread(side, 10);
  await expect(waiting.result).rejects.toThrow("cancelled");
  expect(side).toMatchObject({ status: "cancelled", updatedAt: 10, providerThreadId: "saved_side", sourceEndBlockId: "a1" });
  expect(side.messages).toBe(messages); expect(side.error).toBeUndefined();
  expect(otherController.signal.aborted).toBe(false); expect(execute).not.toHaveBeenCalled();
  release(); await expect(first.result).resolves.toBe("other answer"); await waiting.tail;
  expect(execute).not.toHaveBeenCalled();
});

it("keeps a running Btw's partial output when cancelled and resets cancellation on its next request", async () => {
  let cleanup!: () => void;
  const controller = new AbortController();
  let side: BtwThread = { ...thread(), providerThreadId: "saved_side", pendingBlocks: [
    { id: "partial", role: "assistant", text: "Partial answer", streaming: true },
  ] };
  const active = enqueueTextPrompt(Promise.resolve(), { signal: controller.signal,
    onQueueState: (status) => { side = { ...side, status }; } },
    () => new Promise<string>((resolve) => { cleanup = () => resolve("late completion"); }));
  await vi.waitFor(() => expect(side.status).toBe("running"));
  const nextController = new AbortController(), nextExecute = vi.fn(async () => "next answer");
  const next = enqueueTextPrompt(active.tail, { signal: nextController.signal }, nextExecute);
  controller.abort(); side = cancelBtwThread(side, 20);
  await expect(active.result).rejects.toThrow("cancelled");
  expect(side.status).toBe("cancelled"); expect(side.pendingBlocks).toBeUndefined();
  expect(side.messages.at(-1)).toMatchObject({ role: "assistant", text: "Partial answer", createdAt: 20 });
  expect(side.messages.at(-1)?.blocks?.[0].streaming).toBeFalsy();
  expect(cancelBtwThread(side, 21)).toBe(side); // Repeated Stop never duplicates the partial answer.
  expect(nextController.signal.aborted).toBe(false); expect(nextExecute).not.toHaveBeenCalled();
  const question = queueBtwThread(side, 30);
  expect(question).toMatchObject({ status: "queued", updatedAt: 30, providerThreadId: "saved_side", sourceEndBlockId: "a1", pendingBlocks: [] });
  expect(question.messages).toBe(side.messages); expect(question.error).toBeUndefined();
  expect(question.readSources).toEqual(side.readSources); expect(side.status).toBe("cancelled");
  cleanup(); await expect(next.result).resolves.toBe("next answer");
});

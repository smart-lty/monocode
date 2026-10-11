import { sessionBlocksPage, type SessionBlocksOptions, type SessionBlocksSource } from "./sessionBlocks";
import { sentSessionReferences } from "../../sessions/model/sessionReferences";
import type { BtwThread, Session } from "../../sessions/model/session";

export type BtwReadRequest = SessionBlocksOptions & { sessionId: string };

/** This closure is the complete tool authority; it never uses the parent's CLI token. */
export function btwContextReader(source: Session, thread: BtwThread,
  saved: (id: string) => Promise<SessionBlocksSource | null>) {
  const end = source.blocks.findIndex((block) => block.id === thread.sourceEndBlockId);
  if (end < 0) throw new Error("侧聊截止点不存在；无法补读上下文。");
  const prefix = source.blocks.slice(0, end + 1);
  const available = new Set(sentSessionReferences(prefix).map((reference) => reference.sessionId));
  const selected = thread.readSources ?? sentSessionReferences(prefix);
  if (selected.some((reference) => !available.has(reference.sessionId)))
    throw new Error("侧聊所选来源未在截止点以前发送。");
  const allowed = new Set([source.id, ...selected.map((reference) => reference.sessionId)]);
  return async (request: BtwReadRequest) => {
    if (!request || typeof request !== "object" || !allowed.has(request.sessionId))
      throw new Error("侧聊仅可只读补读截止点内主对话及所选来源。");
    const keys = ["sessionId", "view", "before", "blockId", "offset", "readVersion", "limit", "maxChars", "maxTotalChars"];
    if (Object.keys(request).some((key) => !keys.includes(key))) throw new Error("侧聊补读不接受写入或控制字段。");
    const record = await saved(request.sessionId);
    if (!record) throw new Error("所选来源不可读；侧聊仅拥有已展示的有限摘录。");
    let target = record;
    if (request.sessionId === source.id) {
      const savedEnd = record.blocks.findIndex((block) => block.id === thread.sourceEndBlockId);
      if (savedEnd < 0) throw new Error("保存的侧聊截止点已移除；请重新发起讨论。");
      // Never read the parent's later saved messages, even after a restart.
      const blocks = record.blocks.slice(0, savedEnd + 1);
      // Bound the revision to prefix content, so parent appends do not break paging.
      const content = JSON.stringify(blocks.map(({ btwThreads: _side, ...block }) => block));
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
      target = { ...record, blocks, updatedAt: thread.createdAt,
        readVersion: `btw:${thread.id}:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}` };
    }
    return { ...sessionBlocksPage(target, { ...request, maxTotalChars: Math.min(request.maxTotalChars ?? 8000, 8000) }),
      scope: request.sessionId === source.id ? `as-of ${thread.sourceEndBlockId}（含该轮）` : "所选来源的最新已保存版本；属于主动补读", readOnly: true };
  };
}

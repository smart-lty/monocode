import { expect, it } from "vitest";
import { openCodeForkPrefix } from "./opencode";
import type { ForkSessionInput } from "../../core/types";

const input = (): ForkSessionInput => ({ sessionId: "child", sourceProviderSessionId: "parent", cwd: "/repo", model: "openai/gpt-6.1-sol",
  runtimeMode: "full-access", nativeTurns: [{ harness: "opencode", sessionId: "parent", userMessageId: "msg1", messageIds: ["msg1", "msg2"], source: "provider" }] });
const source = () => [{ info: { id: "msg1", role: "user", summary: { title: "normal metadata" } }, parts: [{ type: "text", text: "BEFORE" }] },
  { info: { id: "msg2", role: "assistant", parentID: "msg1" }, parts: [{ type: "tool", callID: "old_call", state: { status: "completed", input: { command: "OLD" }, output: "DONE" } }] },
  { info: { id: "msg3", role: "user" }, parts: [{ type: "text", text: "AFTER" }] }];
it("maps a complete application turn to the prefix ending before the next native message", () => {
  const messages = source(), before = JSON.stringify(messages);
  const prefix = openCodeForkPrefix(messages, input());
  expect(prefix.map((message) => message.info?.id)).toEqual(["msg1", "msg2"]);
  expect(messages[prefix.length].info.id).toBe("msg3");
  expect(JSON.stringify(prefix)).not.toContain("AFTER"); expect(JSON.stringify(messages)).toBe(before);
});
it("rejects lost IDs, partial tool results and compaction after the requested cutoff", () => {
  const messages = source();
  expect(() => openCodeForkPrefix(messages.slice(1), input())).toThrow("mapping");
  messages[1].parts = [{ type: "tool", callID: "old_call", state: { status: "running", input: { command: "OLD" }, output: "" } }];
  expect(() => openCodeForkPrefix(messages, input())).toThrow("unfinished");
  const compacted = source(); compacted.push({ info: { id: "msg4", role: "assistant", summary: true } as never, parts: [] });
  expect(() => openCodeForkPrefix(compacted, input())).toThrow("compacted");
});

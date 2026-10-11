import { expect, it, vi } from "vitest";
import { enqueueTextPrompt } from "./textQueue";

it("reports the actual provider queue, cancels one waiting request promptly and lets others continue", async () => {
  let release!: () => void;
  const states: string[] = [];
  const first = enqueueTextPrompt(Promise.resolve(), { onQueueState: (state) => states.push(`first:${state}`) },
    () => new Promise<string>((resolve) => { release = () => resolve("first"); }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const abort = new AbortController(), operation = vi.fn(async () => "never");
  const cancelled = enqueueTextPrompt(first.tail, { signal: abort.signal, onQueueState: (state) => states.push(`cancelled:${state}`) }, operation);
  const last = enqueueTextPrompt(cancelled.tail, { onQueueState: (state) => states.push(`last:${state}`) }, async () => "last");
  abort.abort(); await expect(cancelled.result).rejects.toThrow("cancelled");
  expect(states).toEqual(["first:queued", "first:running", "cancelled:queued", "last:queued"]);
  expect(operation).not.toHaveBeenCalled(); release();
  await expect(first.result).resolves.toBe("first"); await expect(last.result).resolves.toBe("last");
  expect(states).toContain("last:running"); expect(operation).not.toHaveBeenCalled();
});
it("keeps the provider tail locked until an actively cancelled runner has cleaned up", async () => {
  let cleanup!: () => void;
  const abort = new AbortController();
  const first = enqueueTextPrompt(Promise.resolve(), { signal: abort.signal }, () => new Promise<string>((resolve) => { cleanup = () => resolve("cancelled cleanup"); }));
  await new Promise((resolve) => setTimeout(resolve, 0)); const next = vi.fn(async () => "next");
  const second = enqueueTextPrompt(first.tail, {}, next);
  abort.abort(); await expect(first.result).rejects.toThrow("cancelled");
  expect(next).not.toHaveBeenCalled(); cleanup();
  await expect(second.result).resolves.toBe("next");
});

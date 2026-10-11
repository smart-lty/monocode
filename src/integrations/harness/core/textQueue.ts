import { btwTextCancelled } from "./abortTextPrompt";

/** Instrument the existing provider tail, including work queued by title helpers. */
export function enqueueTextPrompt<T>(tail: Promise<void>, input: {
  signal?: AbortSignal; onQueueState?: (state: "queued" | "running") => void;
}, operation: () => Promise<T>): { result: Promise<T>; tail: Promise<void> } {
  input.onQueueState?.("queued");
  const work = tail.catch(() => undefined).then(() => {
    if (input.signal?.aborted) throw btwTextCancelled();
    input.onQueueState?.("running");
    return operation();
  });
  const settled = work.then(() => undefined, () => undefined);
  if (!input.signal) return { result: work, tail: settled };
  const signal = input.signal;
  let abort: () => void = () => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(btwTextCancelled());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  const result = Promise.race([work, cancelled]).finally(() => signal.removeEventListener("abort", abort));
  // The tail follows provider cleanup, not the caller's early cancellation.
  return { result, tail: settled };
}

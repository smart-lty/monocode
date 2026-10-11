// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";

let container: HTMLDivElement;
let root: Root;
const blocked =
  "While the session runs, side questions start from its latest finished turn.";
const label = "Side question about this turn";
const blocks: Block[] = [
  { id: "u1", role: "user", text: "First question", durationMs: 100 },
  { id: "a1", role: "assistant", text: "First answer" },
  { id: "u2", role: "user", text: "Latest question", durationMs: 100 },
  { id: "a2", role: "assistant", text: "Latest answer" },
];
const button = () =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each(["pointer", "keyboard"])(
  "updates a %s user's existing side-question button when the session becomes idle",
  (input) => {
    let busy = true;
    const open = vi.fn();
    // Keep the same callbacks, as useBtw does while reading the latest session.
    const sideQuestion = { open, unavailable: () => (busy ? blocked : undefined) };
    const render = () =>
      act(() => root.render(createElement(AgentTranscript, { blocks, busy, sideQuestion })));
    render();
    const original = button();
    act(() => {
      if (input === "pointer")
        original.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      else original.focus();
    });
    expect(original.getAttribute("aria-disabled")).toBe("true");
    expect(original.title).toBe(blocked);

    busy = false;
    render();
    expect(button()).toBe(original);
    if (input === "keyboard") expect(document.activeElement).toBe(original);
    expect(original.getAttribute("aria-disabled")).toBe("false");
    expect(original.title).toBe(label);
    expect(original.classList).not.toContain("cursor-default");
    act(() => original.click());
    expect(open).toHaveBeenCalledOnce();

    busy = true;
    render();
    expect(original.getAttribute("aria-disabled")).toBe("true");
    expect(original.title).toBe(blocked);
    act(() => original.click());
    expect(open).toHaveBeenCalledOnce();
  },
);

it("rechecks current availability on click even if it changed since the render", () => {
  let busy = false;
  const open = vi.fn();
  act(() =>
    root.render(
      createElement(AgentTranscript, {
        blocks,
        sideQuestion: { open, unavailable: () => (busy ? blocked : undefined) },
      }),
    ),
  );
  busy = true;
  act(() => button().click());
  expect(open).not.toHaveBeenCalled();
  busy = false;
  act(() => button().click());
  expect(open).toHaveBeenCalledOnce();
});

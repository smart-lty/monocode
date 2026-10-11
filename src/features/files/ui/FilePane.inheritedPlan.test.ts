// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newEditorPane, newPlanTab } from "../../workspace/model/layout";
import { newSession, type Block, type PlanBlockMeta } from "../../sessions/model/session";
import { FilePane } from "./FilePane";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  isTauri: () => false,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const TEXT = "# Roll out the cache\n\n1. Warm it";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function open(status: PlanBlockMeta["status"], inherited: boolean) {
  const session = newSession("codex", "/repo", "gpt-5", "supervised");
  const block: Block = { id: "plan1", role: "plan", text: TEXT, plan: { status }, ...(inherited ? { inherited: true } : {}) };
  session.blocks = [block];
  const before = JSON.stringify(block);
  const onBuildPlan = vi.fn();
  const onUpdatePlan = vi.fn();
  const noop = () => {};
  const props: ComponentProps<typeof FilePane> = {
    pane: newEditorPane(newPlanTab(session.id, block.id, "Roll out the cache", "/repo")),
    focused: true,
    showTabs: false,
    dirtyFileIds: new Set(),
    fileErrorCounts: new Map(),
    sessions: [session],
    onFocus: noop,
    onSelectFile: noop,
    onCloseFile: noop,
    onCloseOtherFiles: noop,
    onDirtyChange: noop,
    onErrorCountChange: noop,
    onReorderFiles: noop,
    onOpenFile: noop,
    onUpdatePlan,
    onBuildPlan,
  };
  await act(async () => root.render(createElement(FilePane, props)));
  const buttons = Array.from(container.querySelectorAll("button"));
  const build = buttons.find((button) => /Build|Built|Historical plan/.test(button.textContent ?? ""))!;
  const target = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  const source = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Plan markdown"]')!;
  return { block, before, build, target, source, onBuildPlan, onUpdatePlan };
}

async function type(source: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(source, value);
    source.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("plan pane", () => {
  it("builds and edits an ordinary ready plan", async () => {
    const view = await open("ready", false);
    expect(view.build.textContent).toBe("Build");
    expect(view.build.disabled).toBe(false);
    expect(view.target.disabled).toBe(false);
    expect(view.source.readOnly).toBe(false);
    expect(view.source.disabled).toBe(false);
    await act(async () => view.build.click());
    expect(view.onBuildPlan).toHaveBeenCalledWith(expect.any(String), "plan1");
    await type(view.source, `${TEXT}\n2. Switch`);
    expect(view.onUpdatePlan).toHaveBeenCalledWith(expect.any(String), "plan1", `${TEXT}\n2. Switch`);
  });

  it("keeps an ordinary built plan built", async () => {
    const view = await open("built", false);
    expect(view.build.textContent).toBe("Built");
    expect(view.build.disabled).toBe(true);
    expect(view.source.disabled).toBe(true);
  });

  for (const [status, label] of [
    ["ready", "Historical plan · not built"],
    ["built", "Historical plan · built in source"],
  ] as const) {
    it(`shows an inherited ${status} plan as history: no Build, no rewrite, still selectable`, async () => {
      const view = await open(status, true);
      expect(view.build.textContent).toBe(label);
      expect(view.build.disabled).toBe(true);
      expect(view.build.title).toMatch(/inherited from the source session/);
      expect(view.target.disabled).toBe(true);
      // Read-only rather than disabled, so the text can be selected and copied.
      expect(view.source.readOnly).toBe(true);
      expect(view.source.disabled).toBe(false);
      expect(view.source.value).toBe(TEXT);

      await act(async () => {
        view.build.click();
        view.target.click();
      });
      await type(view.source, "rewritten");
      expect(view.onBuildPlan).not.toHaveBeenCalled();
      expect(view.onUpdatePlan).not.toHaveBeenCalled();
      expect(JSON.stringify(view.block)).toBe(view.before);
      expect(view.block.plan?.status).toBe(status);
    });
  }
});

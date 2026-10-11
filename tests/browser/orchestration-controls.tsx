import { useState } from "react";
import { createRoot } from "react-dom/client";
import { orchestrator, type OrchestrationRun } from "../../src/features/orchestration/model/orchestration";
import { OrchestrationSidebarAgents } from "../../src/features/orchestration/ui/OrchestrationSidebarAgents";

const run: OrchestrationRun = {
  version: 2, leadId: "lead", cwd: "/repo", status: "paused",
  allowedHarnesses: ["codex"], maxWorkers: 1, cli: "monocode",
  tasks: [], requests: {}, continuations: 0,
};
const runs = [run];

function Fixture() {
  const [result, setResult] = useState("idle");
  const [captures, setCaptures] = useState(0);
  const [selections, setSelections] = useState(0);
  Object.assign(orchestrator, {
    subscribe: () => () => {},
    snapshot: () => runs,
    resumeBlocker: () => undefined,
    resumeLeadBusy: () => false,
    start: async () => setResult("resumed"),
    stopRun: async () => setResult("stopped"),
  });
  return <>
    <div
      data-testid="session-card"
      style={{ width: 320, padding: 20, border: "1px solid" }}
      // Reproduce Sidebar's drag capture. A real pointer click is retargeted
      // to this parent if the child allows pointerdown to bubble here.
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setCaptures((value) => value + 1);
      }}
      onClick={() => setSelections((value) => value + 1)}
    >
      <div data-testid="session-header">Session header</div>
      <OrchestrationSidebarAgents leadId="lead" summary={{ status: "paused", live: true, tasks: [] }} />
    </div>
    <output data-testid="result">{result}</output>
    <output data-testid="captures">{captures}</output>
    <output data-testid="selections">{selections}</output>
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);

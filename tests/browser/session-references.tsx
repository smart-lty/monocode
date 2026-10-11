import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { Composer } from "../../src/features/sessions/ui/Composer";
import { SessionReferenceChips } from "../../src/features/sessions/ui/SessionReferenceChip";
import { SessionCard } from "../../src/app/shell/Sidebar";
import {
  getComposerDraft,
  getComposerSessionReferences,
  setComposerDraft,
  setComposerSessionReferences,
} from "../../src/features/sessions/model/draftCache";
import {
  listSessionReferenceCandidates,
  type SessionReferenceCandidate,
} from "../../src/features/sessions/data/sessionStore";
import type { SessionReference } from "../../src/features/sessions/model/sessionReferences";
import type { ComposerTurnOptions } from "../../src/features/sessions/model/session";
import "../../src/styles/index.css";

// Mocked IPC only: a synthetic store with the backend's ordering contract
// (relevance tier, then activity, then id). Not the real Rust command.
const PROJECTS = ["/work/monocode", "/work/synara", "/work/notes-app"];
const now = Date.now();
const store: (SessionReferenceCandidate & { body: string })[] = [];
for (let index = 0; index < 1200; index++) {
  const cwd = PROJECTS[index % 3]!;
  store.push({
    sessionId: `s${String(index).padStart(4, "0")}`,
    cwd,
    title:
      index === 1199
        ? "Needle in the oldest session"
        : index === 7
          ? "修复 Composer 中文输入法回车"
          : index === 21
            ? "abc tracker"
            : index === 24
              ? "abcdef palette"
              : index === 27
                ? "cafe menu"
                : // Same title twice in /work/monocode and once in /work/synara.
                  index === 12 || index === 15 || index === 13
                  ? "Refactor auth"
                  : `Session ${index}`,
    harness: index % 2 ? "codex" : "claude",
    model: index % 2 ? "gpt-5" : "claude-opus-4-5",
    updatedAt: now - index * 60_000,
    userTurnCount: (index % 9) + 1,
    relevance: 0,
    body: index === 900 ? "we discussed the zebra-crossing bug here" : "",
  });
}

const fixture = window as unknown as {
  calls: {
    scope: string;
    query: string;
    search: string;
    cursor: string | null;
  }[];
  submitted: { text: string; options?: ComposerTurnOptions }[];
  /** Sidebar callbacks that would select, split or move sessions. */
  sidebarCalls: string[];
};
fixture.calls = [];
fixture.submitted = [];
fixture.sidebarCalls = [];

function score(title: string, query: string) {
  const lower = title.toLowerCase();
  if (lower === query) return 6000;
  if (lower.startsWith(query)) return 5000;
  return lower.includes(query) ? 3000 : 0;
}

mockWindows("main");
mockIPC(
  (command, args) => {
    if (command === "session_reference_candidates") {
      const options = (args as { options: Record<string, unknown> }).options;
      const query = String(options.query ?? "").toLowerCase();
      const search = String(options.search);
      fixture.calls.push({
        scope: options.cwd ? "project" : "all",
        query,
        search,
        cursor: (options.cursor as string | null) ?? null,
      });
      const rows = store
        .filter(
          (item) =>
            item.sessionId !== options.currentSessionId &&
            (!options.cwd || item.cwd === options.cwd),
        )
        .flatMap((item) => {
          if (!query) return [{ ...item, relevance: 0 }];
          if (search === "content") {
            const at = item.body.toLowerCase().indexOf(query);
            return at < 0
              ? []
              : [{ ...item, relevance: 1, snippet: item.body }];
          }
          const relevance = score(item.title, query);
          return relevance ? [{ ...item, relevance }] : [];
        })
        .sort(
          (a, b) =>
            b.relevance - a.relevance ||
            b.updatedAt - a.updatedAt ||
            a.sessionId.localeCompare(b.sessionId),
        );
      const start = Number(options.cursor ?? 0);
      const limit = Number(options.limit ?? 100);
      const page = rows.slice(start, start + limit);
      // Slow first pages for short queries, to exercise stale responses.
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              items: page.map(({ body: _body, ...item }) => item),
              nextCursor:
                start + limit < rows.length ? String(start + limit) : null,
            }),
          query.length === 1 ? 1500 : 20,
        ),
      );
    }
    if (command === "session_reference_snapshot") {
      const item = store.find(
        (entry) =>
          entry.sessionId === (args as { sessionId: string }).sessionId,
      );
      // Slow on purpose: typing continues while a drop is being checked.
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              item
                ? {
                    id: item.sessionId,
                    title: item.title,
                    cwd: item.cwd,
                    harness: item.harness,
                    model: item.model,
                    updatedAt: item.updatedAt,
                    readVersion: "v1",
                    blocks: [],
                  }
                : null,
            ),
          200,
        ),
      );
    }
    if (command === "list_project_files")
      return [
        {
          name: "README.md",
          path: "/work/monocode/README.md",
          relative: "README.md",
        },
        {
          name: "App.tsx",
          path: "/work/monocode/src/App.tsx",
          relative: "src/App.tsx",
        },
      ];
    if (command === "git_branches")
      return { current: "main", detached: false, branches: [] };
    if (command === "read_text_file") return "";
    return [];
  },
  { shouldMockEvents: true },
);

/** The SessionPane contract: per-session draft text and references in the
 * draft cache, Composer keyed by session so switching remounts it. */
function Pane({ sessions, label }: { sessions: string[]; label: string }) {
  const [sessionId, setSessionId] = useState(sessions[0]!);
  const [references, setReferences] = useState<SessionReference[]>(() =>
    getComposerSessionReferences(sessions[0]!),
  );
  const change = useCallback(
    (next: SessionReference[]) => {
      const clean = next.filter((ref) => ref.sessionId !== sessionId);
      setComposerSessionReferences(sessionId, clean);
      setReferences(clean);
    },
    [sessionId],
  );
  const switchTo = (next: string) => {
    setSessionId(next);
    setReferences(getComposerSessionReferences(next));
  };
  return (
    <section
      data-pane-id={sessionId}
      data-testid={`pane-${label}`}
      className="flex min-w-0 flex-1 flex-col justify-end gap-2 border-l border-content/10 p-3"
    >
      <div className="flex gap-2 text-xs text-content/50">
        <span data-testid={`session-${label}`}>{sessionId}</span>
        {sessions.map((id) => (
          <button key={id} type="button" onClick={() => switchTo(id)}>
            Open {id}
          </button>
        ))}
      </div>
      <ul data-testid={`sent-${label}`}>
        {fixture.submitted
          .filter((entry) => entry.text.startsWith(`[${label}]`))
          .map((entry, index) => (
            <li key={index}>
              <SessionReferenceChips
                references={entry.options?.sessionReferences ?? []}
              />
            </li>
          ))}
      </ul>
      <Composer
        key={sessionId}
        sessionId={sessionId}
        cwd="/work/monocode"
        executionCwd="/work/monocode"
        focused={false}
        harness="codex"
        model="gpt-5"
        runtimeMode="supervised"
        hideBranchPicker
        initialDraft={getComposerDraft(sessionId)}
        onDraftChange={(text) => setComposerDraft(sessionId, text)}
        sessionReferences={references}
        onSessionReferencesChange={change}
        onSearchSessionReferences={listSessionReferenceCandidates}
        onFocus={() => {}}
        onCwdChange={() => {}}
        onModelChange={() => {}}
        onRuntimeModeChange={() => {}}
        onSubmit={(text, _files, options) => {
          fixture.submitted.push({ text: `[${label}] ${text}`, options });
          setReferences([]);
        }}
      />
    </section>
  );
}

/** The real Sidebar SessionCard, with every navigation callback recorded. */
function SidebarCard({ id }: { id: string }) {
  const item = store.find((entry) => entry.sessionId === id)!;
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      fixture.sidebarCalls.push(`${name}:${JSON.stringify(args[0])}`);
  return (
    <div data-testid={`card-${id}`}>
      <SessionCard
        session={{
          id,
          cwd: item.cwd,
          harness: item.harness,
          model: item.model,
          runtimeMode: "supervised",
          title: item.title,
          createdAt: item.updatedAt,
          updatedAt: item.updatedAt,
        }}
        isActive={false}
        isSelected={false}
        busy={false}
        done={false}
        linkedUpdate={false}
        needsApproval={false}
        now={now}
        onSelect={record("select")}
        onPlaceOnPane={record("placeOnPane")}
        onListDrop={record("listDrop")}
      />
    </div>
  );
}

function Fixture() {
  return (
    <main className="flex h-screen min-w-0 bg-surface text-content">
      <aside className="flex w-48 shrink-0 flex-col gap-2 p-3 max-[500px]:w-24">
        <SidebarCard id="s0003" />
        <SidebarCard id="s0006" />
        <SidebarCard id="left-1" />
      </aside>
      <Pane label="left" sessions={["left-1", "left-2"]} />
      <Pane label="right" sessions={["right-1"]} />
    </main>
  );
}

store.push({
  sessionId: "left-1",
  cwd: "/work/monocode",
  title: "Left pane session",
  harness: "codex",
  model: "gpt-5",
  updatedAt: now,
  userTurnCount: 2,
  relevance: 0,
  body: "",
});
createRoot(document.getElementById("root")!).render(<Fixture />);

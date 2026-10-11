import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Check, Search } from "../../../shared/ui/icons";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { MatchText } from "../../../shared/ui/MatchText";
import { formatRelative } from "../../../shared/lib/relativeTime";
import {
  ProjectIdentityIcon,
  projectDisplayName,
  useProjectAppearance,
} from "../../projects/ui/ProjectIdentityIcon";
import type { SessionReferenceCandidate } from "../data/sessionStore";
import { resolveModel } from "../model/models";
import { sessionDisplayTitle } from "../model/session";
import {
  sessionTitleMatch,
  type SessionReferenceScope,
} from "../model/sessionPicker";
import { HarnessIcon } from "./HarnessIcon";
import type { SessionPickerSearch } from "./useSessionReferencePicker";

type Props = {
  id: string;
  scope: SessionReferenceScope;
  search: SessionPickerSearch;
  query: string;
  items: SessionReferenceCandidate[];
  ready: boolean;
  loading: boolean;
  hasMore: boolean;
  error: string | null;
  /** Index into items; items.length is the content-search row. */
  active: number;
  referencedIds: ReadonlySet<string>;
  onActive: (index: number) => void;
  onPick: (index: number) => void;
  onScope: (scope: SessionReferenceScope) => void;
  onSearchTitles: () => void;
  onLoadMore: () => void;
};

export const sessionPickerOptionId = (id: string, index: number) =>
  `${id}-option-${index}`;

/** `#`/`##` session picker, in the same slot as the `@` file picker. */
export function SessionReferencePicker({
  id,
  scope,
  search,
  query,
  items,
  ready,
  loading,
  hasMore,
  error,
  active,
  referencedIds,
  onActive,
  onPick,
  onScope,
  onSearchTitles,
  onLoadMore,
}: Props) {
  const appearance = useProjectAppearance();
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const listRef = useRef<HTMLDivElement | null>(null);
  const setList = useCallback(
    (element: HTMLDivElement | null) => {
      listRef.current = element;
      lockOverscroll(element);
    },
    [lockOverscroll],
  );
  const pointer = useRef({ x: Number.NaN, y: Number.NaN, allow: false });
  const fromPointer = useRef(false);
  const typed = query.trim();
  const contentRow = search === "title" && typed.length > 0;
  const now = Date.now();
  const duplicateTitles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const title = `${scope === "all" ? item.cwd : ""}\0${item.title}`;
      counts.set(title, (counts.get(title) ?? 0) + 1);
    }
    return counts;
  }, [items, scope]);

  useEffect(() => {
    pointer.current.allow = false;
  }, [items]);

  useEffect(() => {
    if (fromPointer.current) {
      fromPointer.current = false;
      return;
    }
    pointer.current.allow = false;
    if (active < 0) return;
    listRef.current
      ?.querySelector(`#${CSS.escape(sessionPickerOptionId(id, active))}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, id]);

  const onListMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.clientX === pointer.current.x && e.clientY === pointer.current.y)
      return;
    pointer.current = { x: e.clientX, y: e.clientY, allow: true };
  };
  // Rows left from an older query or scope are shown dimmed until the new
  // results land; they can't be highlighted or picked.
  const choose = (index: number) => {
    if (ready) onPick(index);
  };
  const onRowEnter = (index: number) => {
    if (!pointer.current.allow || !ready) return;
    fromPointer.current = true;
    onActive(index);
  };

  const status = error
    ? error
    : !ready || (loading && items.length === 0)
      ? "Searching…"
      : items.length === 0
        ? search === "content"
          ? "No sessions mention this"
          : scope === "project"
            ? typed
              ? "No matching sessions in this project. Type ## to search all projects."
              : "No other sessions in this project. Type ## to see all projects."
            : "No matching sessions"
        : `${items.length}${hasMore ? "+" : ""} session${items.length === 1 && !hasMore ? "" : "s"}`;

  return (
    <div
      data-session-reference-picker
      className="overflow-hidden rounded-lg border border-content/10 bg-content/5 backdrop-blur-xl"
    >
      <div className="flex min-w-0 items-center gap-1 border-b border-content/8 px-1.5 py-1 text-[11px]">
        {search === "content" ? (
          <>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onSearchTitles}
              className="shrink-0 rounded px-1.5 py-0.5 text-content/55 hover:bg-content/10 hover:text-content"
            >
              Titles
            </button>
            <span className="min-w-0 truncate text-content/70">
              Messages mentioning “{typed}”
            </span>
          </>
        ) : (
          (["project", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onScope(value)}
              className={`shrink-0 rounded px-1.5 py-0.5 ${
                scope === value
                  ? "bg-content/10 text-content"
                  : "text-content/50 hover:bg-content/8 hover:text-content"
              }`}
            >
              <span className="font-mono text-content/45">
                {value === "all" ? "##" : "#"}
              </span>{" "}
              {value === "all" ? "All projects" : "This project"}
            </button>
          ))
        )}
        <span
          role="status"
          aria-live="polite"
          className="ml-auto min-w-0 truncate pl-2 text-content/45"
        >
          {status}
        </span>
      </div>
      <div
        ref={setList}
        id={id}
        role="listbox"
        aria-label={
          scope === "all"
            ? "Sessions in all projects"
            : "Sessions in this project"
        }
        aria-busy={loading || !ready}
        onMouseMove={onListMouseMove}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 160)
            onLoadMore();
        }}
        className={`max-h-[min(320px,45vh)] overflow-y-auto overscroll-none px-1 py-1 ${
          ready ? "" : "opacity-60"
        }`}
      >
        {items.map((item, index) => {
          const highlighted = index === active;
          const title = sessionDisplayTitle(item.title, item.harness);
          const project = projectDisplayName(item.cwd, appearance);
          const duplicate =
            (duplicateTitles.get(
              `${scope === "all" ? item.cwd : ""}\0${item.title}`,
            ) ?? 0) > 1;
          const added = referencedIds.has(item.sessionId);
          return (
            <div
              key={item.sessionId}
              id={sessionPickerOptionId(id, index)}
              role="option"
              aria-selected={highlighted}
              aria-disabled={!ready || undefined}
              aria-label={`${title}, ${project}, ${item.userTurnCount} turns${added ? ", already added" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onRowEnter(index)}
              onClick={() => choose(index)}
              className={`flex w-full cursor-default items-start gap-2 rounded-md px-2 py-1.5 text-left ${
                highlighted ? "bg-selection text-content" : "text-content"
              }`}
            >
              <ProjectIdentityIcon
                cwd={item.cwd}
                appearance={appearance}
                className="mt-0.5 size-4"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <HarnessIcon
                      harness={item.harness}
                      className="size-3.5 shrink-0"
                    />
                    <span
                      data-session-model
                      className="min-w-0 truncate text-[11px] text-content/50"
                    >
                      {resolveModel(item.harness, item.model).name}
                    </span>
                  </span>
                  <span
                    data-session-time
                    className="shrink-0 text-[11px] tabular-nums text-content/45"
                  >
                    {formatRelative(item.updatedAt, now)}
                  </span>
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  <span
                    data-session-title
                    className="min-w-0 truncate text-[13px] font-semibold leading-snug"
                  >
                    <MatchText
                      text={title}
                      positions={sessionTitleMatch(title, typed)}
                      active={search === "title" && Boolean(typed)}
                    />
                  </span>
                  {added ? (
                    <Check
                      aria-hidden
                      className="size-3 shrink-0 text-content/50"
                      strokeWidth={2}
                    />
                  ) : null}
                </span>
                {search === "content" && item.snippet ? (
                  <span className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-content/55">
                    {item.snippet}
                  </span>
                ) : null}
                <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-content/45">
                  <span className="shrink-0 tabular-nums">
                    {item.userTurnCount} turn
                    {item.userTurnCount === 1 ? "" : "s"}
                  </span>
                  {scope === "all" || duplicate ? (
                    <span data-session-project className="min-w-0 truncate">
                      · {project}
                    </span>
                  ) : null}
                  {duplicate ? (
                    <span className="shrink-0 font-mono">
                      · {item.sessionId.slice(-4)}
                    </span>
                  ) : null}
                </span>
              </span>
            </div>
          );
        })}
        {hasMore ? (
          <div className="px-2 py-1.5 text-[11px] text-content/40">
            {loading ? "Loading more…" : "Scroll for more"}
          </div>
        ) : null}
        {contentRow ? (
          <div
            id={sessionPickerOptionId(id, items.length)}
            role="option"
            aria-selected={active === items.length}
            aria-disabled={!ready || undefined}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onRowEnter(items.length)}
            onClick={() => choose(items.length)}
            className={`flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[12px] ${
              active === items.length
                ? "bg-selection text-content"
                : "text-content/65"
            }`}
          >
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate">
              Search message content for “{typed}”
            </span>
            <kbd className="shrink-0 font-sans text-[11px] text-content/40">
              ⌘↵
            </kbd>
          </div>
        ) : null}
      </div>
    </div>
  );
}

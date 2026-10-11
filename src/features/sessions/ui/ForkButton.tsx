import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { GitBranch } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import type { Block, SessionForkOrigin } from "../model/session";
import { forkInheritance, FORK_STRATEGY_TITLE, turnLabel, type ForkMenu, type ForkStrategy } from "./forkChoices";

const MENU_WIDTH = 320;

/** What a transcript needs to offer Fork on its completed turns. */
export type TurnFork = {
  checkout: string;
  menu: (userBlockId: string) => ForkMenu;
  run: (strategy: ForkStrategy, endBlockId: string) => Promise<unknown>;
};

/**
 * A fork whose native child was created but could not be bound or cleaned
 * up. The record has no provider binding: it is kept for a person to
 * recover or delete the native child, and nothing runs from it.
 */
export function ForkRecoveryNotice({
  origin,
  recovery,
  sourceTitle,
}: {
  origin: SessionForkOrigin;
  recovery: NonNullable<SessionForkOrigin["recovery"]>;
  sourceTitle?: string;
}) {
  return (
    <div
      role="note"
      data-fork-recovery
      title={`Source session ${origin.sourceSessionId}`}
      className="mx-4 my-2 rounded-[10px] border border-amber-300/25 bg-amber-300/5 px-3 py-2 font-sans text-[12px] leading-4.5 text-content/65"
    >
      <div className="flex min-w-0 items-center gap-1.5 font-medium text-amber-100/85">
        <GitBranch className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className="min-w-0 truncate">
          Fork not bound · needs recovery{sourceTitle ? ` · from ${sourceTitle}` : ""}
        </span>
      </div>
      <p className="mt-1">
        A {FORK_STRATEGY_TITLE[origin.strategy].toLowerCase()} created a provider thread that could not be bound or removed. This record is not a session you can continue: nothing is sent, resumed or cleaned up from here.
      </p>
      <p className="mt-1 text-content/55">
        Unbound native thread:{" "}
        <code className="select-all break-all font-mono text-[11px] text-content/75">{recovery.unboundNativeSessionId}</code>
      </p>
    </div>
  );
}

/**
 * The fork's origin, at the end of its inherited history: the source by
 * title, the included turn, and how the model actually inherited it.
 */
export function ForkOriginNotice({
  origin,
  blocks,
  inherited,
  sourceTitle,
  checkout,
}: {
  origin: SessionForkOrigin;
  blocks: Block[];
  /** The first inherited user block, which carries the native binding. */
  inherited?: Block;
  sourceTitle?: string;
  checkout?: string;
}) {
  const end = origin.blocks.find((pair) => pair.sourceId === origin.sourceEndBlockId)?.childId;
  const turn = turnLabel(blocks, end ?? inherited?.id);
  const coverage = origin.coverage;
  return (
    <div
      data-fork-origin={origin.strategy}
      title={`Source session ${origin.sourceSessionId}`}
      className="mx-4 my-2 rounded-[10px] border border-content/10 bg-content/5 px-3 py-2 font-sans text-[12px] leading-4.5 text-content/60"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-content/80">
        <GitBranch className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className="min-w-0 truncate">
          Forked from <span className="font-medium">{sourceTitle ?? "a session that is no longer available"}</span>
          {turn ? ` · through ${turn.label}` : ""}
        </span>
      </div>
      <p className="mt-1">
        <span className="font-medium text-content/75">{FORK_STRATEGY_TITLE[origin.strategy]}.</span>{" "}
        {forkInheritance(origin, inherited)} Everything above is inherited history; later source messages are not included.
      </p>
      {coverage ? (
        <p className="mt-1 text-content/50">
          {coverage.complete ? "Visible text complete" : "Partial"}: {coverage.visibleBlocks} blocks, {coverage.chars.toLocaleString()} characters.
          {coverage.omitted.length ? ` Not included: ${coverage.omitted.join("; ")}.` : ""}
        </p>
      ) : null}
      {origin.warnings.length ? (
        <ul className="mt-1 list-disc pl-4 text-amber-200/75">
          {origin.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1 text-content/45">
        Uses the current checkout{checkout ? <> <span className="break-all text-content/60">{checkout}</span></> : null}. Files were not rolled back, and this fork shares the workspace.
      </p>
    </div>
  );
}

/**
 * Fork a completed turn into an independent session beside this one. Each
 * way states what the child inherits; one that cannot run says why, and a
 * failure stays on screen instead of quietly trying another way.
 */
export function ForkButton({
  turnLabel,
  checkout,
  menu,
  onFork,
}: {
  turnLabel: string;
  checkout: string;
  /** Read when the menu opens, so it reflects the session as it is now. */
  menu: () => ForkMenu;
  onFork: (strategy: ForkStrategy, endBlockId: string) => Promise<unknown>;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ForkMenu | null>(null);
  const [pending, setPending] = useState<ForkStrategy | null>(null);
  const [error, setError] = useState<{ strategy: ForkStrategy; text: string } | null>(null);
  const open = state != null;

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const target =
        list.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ??
        list.current?.querySelector<HTMLElement>('[role="menuitem"]');
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const dismiss = (restoreFocus: boolean) => {
    setState(null);
    setError(null);
    if (restoreFocus) button.current?.focus();
  };

  const pick = (strategy: ForkStrategy) => {
    if (!state?.endBlockId || pending) return;
    setPending(strategy);
    setError(null);
    onFork(strategy, state.endBlockId).then(
      () => {
        setPending(null);
        setState(null);
      },
      (failure: unknown) => {
        setPending(null);
        // Reopen with a fresh read so the other ways reflect the session now.
        setState(menu());
        setError({ strategy, text: failure instanceof Error ? failure.message : String(failure) });
      },
    );
  };

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        title={pending ? "Forking…" : "Fork from this turn"}
        aria-label="Fork from this turn"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`rounded-md p-1 ${
          open || pending ? "bg-content/8 text-content/70" : "text-content/40 hover:bg-content/8 hover:text-content/70"
        }`}
        onClick={() => (open ? dismiss(false) : setState(menu()))}
      >
        <GitBranch className="size-3.5" strokeWidth={1.75} />
      </button>
      {state ? (
        <Popover
          anchor={button}
          side="top"
          align="center"
          width={MENU_WIDTH}
          autoFocus
          onDismiss={(reason) => dismiss(reason === "escape")}
          role="menu"
          tabIndex={-1}
          aria-label={`Fork from ${turnLabel}`}
          aria-busy={pending != null}
          onKeyDown={onKey}
          data-fork-menu
          className="p-1 font-sans"
        >
          <div className="px-1.5 pb-2 pt-1.5">
            <p className="truncate text-[12px] font-medium leading-4 text-content/85" title={turnLabel}>
              Fork from {turnLabel}
            </p>
            <p className="mt-0.5 text-[11px] leading-3.5 text-content/50">
              Includes this turn. Later messages stay out. The fork runs as its own session.
            </p>
          </div>
          <div className="mx-1 mb-1 h-px bg-content/10" />
          {state.blocked ? (
            <p role="note" className="px-2 py-1.5 text-[12px] leading-4 text-amber-200/80">
              {state.blocked}
            </p>
          ) : null}
          <div ref={list}>
            {state.choices.map((choice) => {
              const reason = state.blocked ? undefined : choice.unavailable;
              const disabled = !!state.blocked || !!reason || pending != null;
              return (
                <button
                  key={choice.strategy}
                  type="button"
                  role="menuitem"
                  aria-disabled={disabled}
                  data-fork-strategy={choice.strategy}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => (disabled ? undefined : pick(choice.strategy))}
                  className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:bg-selection ${
                    disabled ? "cursor-default" : "hover:bg-content/5"
                  }`}
                >
                  <span className={`text-[13px] leading-4 ${disabled && pending !== choice.strategy ? "text-content/40" : "text-content"}`}>
                    {pending === choice.strategy ? "Forking…" : choice.title}
                  </span>
                  <span className="text-[11px] leading-3.5 text-content/50">{choice.detail}</span>
                  {reason ? (
                    <span className="text-[11px] leading-3.5 text-amber-200/75">{reason}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {error ? (
            <div role="alert" className="mx-1 mt-1 rounded-md bg-red-300/10 px-2 py-1.5 text-[11px] leading-3.5 text-red-100/80">
              <span className="whitespace-pre-wrap break-words">{error.text}</span>
              <span className="mt-1 block text-red-100/55">Nothing was sent to this session. Pick a way above to try again.</span>
            </div>
          ) : null}
          <div className="mx-1 my-1 h-px bg-content/10" />
          <p className="px-1.5 pb-1 text-[11px] leading-3.5 text-content/45">
            Uses the current checkout <span className="break-all text-content/60">{checkout}</span>. Files are not rolled back, and the fork shares this workspace. Past tools and approvals do not run again.
          </p>
        </Popover>
      ) : null}
    </>
  );
}

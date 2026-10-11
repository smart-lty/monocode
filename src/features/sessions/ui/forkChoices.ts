import { HARNESS_TITLE, type Block, type Session, type SessionForkOrigin } from "../model/session";
import { completedSessionBoundary, forkNativeTurns, forkVisibleHistory } from "../model/sessionFork";
import { groupTurns } from "../model/transcriptActivity";

export type ForkStrategy = SessionForkOrigin["strategy"];

export type ForkChoice = {
  strategy: ForkStrategy;
  title: string;
  detail: string;
  /** The exact reason this way is unavailable; never silently replaced. */
  unavailable?: string;
};

export type ForkMenu = {
  /** The last block of the completed turn, which the fork includes. */
  endBlockId?: string;
  /** Applies to every way, such as an unfinished or non-latest turn. */
  blocked?: string;
  choices: ForkChoice[];
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function sentTurns(blocks: Block[]) {
  return groupTurns(blocks).filter((turn) =>
    turn.some((block) => block.role === "user" && !block.draft && !block.internal),
  );
}

/** "Turn 3 · first line of the question", counted like the fork boundary. */
export function turnLabel(blocks: Block[], blockId: string | undefined) {
  if (!blockId) return undefined;
  const turns = sentTurns(blocks);
  const index = turns.findIndex((turn) => turn.some((block) => block.id === blockId));
  if (index < 0) return undefined;
  const user = turns[index].find((block) => block.role === "user");
  const line = user?.text.trim().split("\n")[0]?.trim() ?? "";
  const text = line.length > 48 ? `${line.slice(0, 45)}…` : line;
  return { number: index + 1, text, label: text ? `Turn ${index + 1} · ${text}` : `Turn ${index + 1}` };
}

export const FORK_STRATEGY_TITLE: Record<ForkStrategy, string> = {
  native: "Native fork",
  "visible-history": "Rebuilt from visible history",
  handoff: "Handoff summary",
};

/**
 * The ways this turn can be forked. Checks mirror the ones the fork runs,
 * so the menu shows a refusal before the click rather than after it.
 * Codex goals and attachment files are only checked when the fork runs.
 */
export function forkMenu(session: Session, userBlockId: string): ForkMenu {
  // The boundary is the end of the turn in the session's own grouping, not
  // whatever subset of it the transcript happened to render.
  const turn = groupTurns(session.blocks).find((entry) =>
    entry.some((block) => block.id === userBlockId),
  );
  const endBlockId = turn?.[turn.length - 1]?.id;
  const harness = HARNESS_TITLE[session.harness];
  let blocked: string | undefined;
  let blocks: Block[] = [];
  try {
    if (!endBlockId) throw new Error("请选择已完成轮次的末尾；该分支点不存在或尚未完成。");
    blocks = completedSessionBoundary(session, endBlockId).blocks;
  } catch (error) {
    blocked = message(error);
  }
  const check = (run: () => unknown) => {
    if (blocked) return undefined;
    try {
      run();
      return undefined;
    } catch (error) {
      return message(error);
    }
  };
  return {
    endBlockId,
    blocked,
    choices: [
      {
        strategy: "native",
        title: FORK_STRATEGY_TITLE.native,
        detail: `${harness} continues from its own saved context through this turn.`,
        unavailable: check(() => forkNativeTurns(session, blocks)),
      },
      {
        strategy: "visible-history",
        title: "Rebuild from visible history",
        detail: "A new thread gets this transcript’s text and tool records. Hidden provider state is not carried over.",
        unavailable: check(() => forkVisibleHistory(blocks)),
      },
      {
        strategy: "handoff",
        title: FORK_STRATEGY_TITLE.handoff,
        detail: "A new thread starts from a short summary. Lossy: details can be missing.",
      },
    ],
  };
}

/**
 * What the child actually inherited, worded for its origin card. The native
 * provider comes from the saved inherited turn, so switching the child to
 * another harness later does not rewrite who inherited what.
 */
export function forkInheritance(origin: SessionForkOrigin, inherited: Block | undefined): string {
  const harness = inherited?.nativeContext?.harness;
  if (origin.strategy === "native")
    return `${harness ? HARNESS_TITLE[harness] : "The provider"} kept its native context through this turn${
      origin.nativeCutoff === "exclusive-message" ? " (cut before the next message)" : ""
    }.`;
  if (origin.strategy === "visible-history")
    return "Rebuilt from the visible transcript. The model did not inherit hidden provider state.";
  return "Started from a lossy Handoff summary, not the full transcript or native context.";
}

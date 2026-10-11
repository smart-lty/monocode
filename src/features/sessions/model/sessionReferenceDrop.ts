import type { SessionReference } from "./sessionReferences";

/** Dispatched on the target composer box when a Sidebar card is dropped. */
export const SESSION_REFERENCE_DROP = "monocode:session-reference-drop";
let highlighted: HTMLElement | null = null;

/** The visible composer under the pointer that accepts references, unless it
 * belongs to the dragged session itself. */
export function sessionReferenceDropTarget(
  x: number,
  y: number,
  sourceId: string,
): HTMLElement | null {
  const target =
    document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-session-reference-target]") ?? null;
  return target && target.dataset.sessionReferenceTarget !== sourceId
    ? target
    : null;
}

export function highlightSessionReferenceTarget(target: HTMLElement | null) {
  if (highlighted === target) return;
  highlighted?.removeAttribute("data-session-reference-over");
  highlighted = target;
  highlighted?.setAttribute("data-session-reference-over", "true");
}

export function dropSessionReference(
  target: HTMLElement,
  reference: SessionReference,
) {
  target.dispatchEvent(
    new CustomEvent<SessionReference>(SESSION_REFERENCE_DROP, {
      detail: reference,
    }),
  );
}

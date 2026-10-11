import { X } from "../../../shared/ui/icons";
import {
  ProjectIdentityIcon,
  projectDisplayName,
  useProjectAppearance,
} from "../../projects/ui/ProjectIdentityIcon";
import { sessionDisplayTitle } from "../model/session";
import type { SessionReference } from "../model/sessionReferences";

/** Referenced sessions, shown like attachments in the composer and on sent
 * messages. Cards never open the source; that would switch projects. */
export function SessionReferenceChips({
  references,
  onRemove,
  className = "",
}: {
  references: readonly SessionReference[];
  onRemove?: (sessionId: string) => void;
  className?: string;
}) {
  const appearance = useProjectAppearance();
  if (!references.length) return null;
  return (
    <ul
      aria-label={`Referenced sessions (${references.length})`}
      data-session-reference-chips
      className={`flex flex-wrap gap-1.5 ${className}`}
    >
      {references.map((reference) => {
        const title = sessionDisplayTitle(reference.title, reference.harness);
        const project = projectDisplayName(reference.cwd, appearance);
        return (
          <li
            key={reference.sessionId}
            title={`${title}\n${reference.cwd}`}
            className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-content/10 py-0.5 pl-1 pr-1"
          >
            <ProjectIdentityIcon
              cwd={reference.cwd}
              appearance={appearance}
              className="size-4"
            />
            <span className="min-w-0 max-w-[180px] truncate text-[11px] leading-none text-content/80">
              {title}
            </span>
            <span className="min-w-0 max-w-[90px] shrink-[4] truncate text-[11px] leading-none text-content/40">
              {project}
            </span>
            {onRemove ? (
              <button
                type="button"
                title="Remove"
                aria-label={`Remove reference ${title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(reference.sessionId);
                }}
                className="grid size-4 shrink-0 place-items-center rounded-full text-content/40 hover:bg-content/15 hover:text-content"
              >
                <X className="size-3" strokeWidth={2} />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

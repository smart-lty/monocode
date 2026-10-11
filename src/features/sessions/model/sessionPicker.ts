import { isMarkdownBlockquotePosition } from "./quoteDraft";

export type SessionReferenceScope = "project" | "all";

/** `#query` (current project) or `##query` (all projects) at the caret. */
export type SessionToken = {
  start: number;
  end: number;
  scope: SessionReferenceScope;
  query: string;
};

const MAX_QUERY = 120;
const isSpace = (char: string) => /\s/.test(char);

/** The `#`/`##` token containing `cursor`. Markdown headings (`# `), `###`,
 * `a#b`, quotes, fenced code and inline code never open the picker. */
export function sessionTokenAt(
  text: string,
  cursor: number,
): SessionToken | null {
  const i = Math.max(0, Math.min(cursor, text.length));
  let start = i;
  while (start > 0 && !isSpace(text[start - 1]!)) start -= 1;
  if (text[start] !== "#") return null;
  const hashes = text[start + 1] === "#" ? 2 : 1;
  if (text[start + hashes] === "#") return null;
  if (i < start + hashes) return null;
  if (isMarkdownBlockquotePosition(text, start)) return null;
  if (insideCode(text, start)) return null;
  const query = text.slice(start + hashes, i);
  if (query.includes("#") || query.length > MAX_QUERY) return null;
  let end = start + hashes;
  while (end < text.length && !isSpace(text[end]!)) end += 1;
  return { start, end, scope: hashes === 2 ? "all" : "project", query };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Inside an open ``` / ~~~ fence, or inside an inline code span. Spans
 * follow CommonMark: a run of N backticks is closed by the next run of exactly
 * N, may continue across lines of the same paragraph, and `\`` outside code is
 * a literal backtick. An opener with no closer yet counts as code only on the
 * caret's own line, where the user is still typing it. */
function insideCode(text: string, position: number): boolean {
  const lineStart = text.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
  let fence: string | null = null;
  let paragraph = 0;
  let offset = 0;
  const before = lineStart ? text.slice(0, lineStart - 1).split("\n") : [];
  for (const line of before) {
    const next = offset + line.length + 1;
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
      paragraph = next;
    } else if (!line.trim()) paragraph = next;
    offset = next;
  }
  if (fence) return true;

  let open = 0;
  let openedAt = 0;
  let i = paragraph;
  while (i < position) {
    const char = text[i];
    if (!open && char === "\\") {
      i += 2;
      continue;
    }
    if (char !== "`") {
      i += 1;
      continue;
    }
    let end = i;
    while (end < text.length && text[end] === "`") end += 1;
    const run = end - i;
    if (!open) {
      open = run;
      openedAt = i;
    } else if (run === open) open = 0;
    i = end;
  }
  if (!open) return false;
  if (openedAt >= lineStart) return true;
  // Opened on an earlier line: code only if a matching closer follows in
  // the same paragraph.
  const rest = text.slice(position);
  const paragraphEnd = rest.search(/\n\s*\n|\n {0,3}(`{3,}|~{3,})/);
  const tail = paragraphEnd < 0 ? rest : rest.slice(0, paragraphEnd);
  return new RegExp(`(^|[^\`])\`{${open}}(?!\`)`).test(tail);
}

/** Valid CSS hex colors (`#abc`, `#cafe`, `#1e1e1e`), issue numbers (`#123`)
 * and blank queries never preselect, so Enter/Tab keep their normal meaning
 * until the user picks a row with the arrows or the pointer. */
export function sessionQueryPreselects(query: string): boolean {
  const value = query.trim();
  if (!value) return false;
  if (/^\d+$/.test(value)) return false;
  return !/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
}

/** Remove the token (and one now-redundant space); returns the caret. */
export function removeSessionToken(
  text: string,
  token: SessionToken,
): { text: string; cursor: number } {
  let end = token.end;
  if (
    text[end] === " " &&
    (token.start === 0 || isSpace(text[token.start - 1]!))
  )
    end += 1;
  return {
    text: text.slice(0, token.start) + text.slice(end),
    cursor: token.start,
  };
}

/** Rewrite `#`/`##` so the text always says which scope is shown. */
export function setSessionTokenScope(
  text: string,
  token: SessionToken,
  scope: SessionReferenceScope,
): { text: string; cursor: number; token: SessionToken } {
  const prefix = scope === "all" ? "##" : "#";
  const oldPrefix = token.scope === "all" ? 2 : 1;
  const next =
    text.slice(0, token.start) + prefix + text.slice(token.start + oldPrefix);
  const delta = prefix.length - oldPrefix;
  const cursor = token.start + prefix.length + token.query.length;
  return {
    text: next,
    cursor,
    token: { ...token, end: token.end + delta, scope },
  };
}

/** Case-insensitive substring positions for highlighting a title match. */
export function sessionTitleMatch(title: string, query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const index = title.toLowerCase().indexOf(needle);
  if (index < 0) return [];
  return Array.from({ length: needle.length }, (_, offset) => index + offset);
}

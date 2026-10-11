import type { Block, Session } from "../../sessions/model/session";

/** Supply one saved record and its revision, never the live session window. */
export type SessionBlocksSource = Pick<Session, "id" | "title" | "cwd"> & {
  blocks: readonly Block[];
  updatedAt: number;
  readVersion: string;
};

export type SessionBlocksOptions = {
  view: "messages" | "blocks";
  before?: string;
  limit?: number;
  /** Maximum UTF-16 code units of readable text per block. */
  maxChars?: number;
  /**
   * Maximum compact JSON UTF-16 length, including metadata and escaping.
   * At the 20000-unit cap, UTF-8 is at most 60000 bytes (CJK uses 3 per unit).
   */
  maxTotalChars?: number;
  blockId?: string;
  offset?: number;
  /** Required for nonzero offsets; also pins an older page when supplied. */
  readVersion?: string;
};

export type SessionBlockSlice = {
  id: string;
  role: Block["role"];
  text: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
  truncated: boolean;
  tool?: Pick<NonNullable<Block["tool"]>, "kind" | "status">;
  plan?: Pick<NonNullable<Block["plan"]>, "status">;
};

export type SessionBlocksPage = {
  sessionId: string;
  title: string;
  cwd: string;
  updatedAt: number;
  readVersion: string;
  view: SessionBlocksOptions["view"];
  offsetUnit: "utf-16";
  blocks: SessionBlockSlice[];
  nextBefore: string | null;
  /** Some text or older blocks remain reachable through the cursors. */
  truncated: boolean;
};

export class SessionBlocksVersionError extends Error {
  readonly code = "SESSION_READ_VERSION_MISMATCH";

  constructor(
    readonly expectedReadVersion: string,
    readonly actualReadVersion: string,
    readonly updatedAt: number,
  ) {
    super("Saved session changed; reread from the first page or offset=0.");
    this.name = "SessionBlocksVersionError";
  }
}

function integerInRange(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
}

function splitsSurrogatePair(text: string, offset: number) {
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return (
    previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
  );
}

function safeEnd(text: string, end: number) {
  return splitsSurrogatePair(text, end) ? end - 1 : end;
}

function readableText(block: Block, view: SessionBlocksOptions["view"]) {
  // The prototype's tool title, input, result and detail share one offset space.
  return view === "blocks" && block.tool
    ? [block.tool.title, block.tool.input, block.text, block.tool.detail]
        .filter(Boolean)
        .join("\n\n")
    : block.text;
}

/** Newest page first, chronological within a page; every omission has a cursor. */
export function sessionBlocksPage(
  source: SessionBlocksSource,
  options: SessionBlocksOptions,
): SessionBlocksPage {
  const limit = options.limit ?? 10;
  const maxChars = options.maxChars ?? 4000;
  const maxTotalChars = options.maxTotalChars ?? 20000;
  const offset = options.offset ?? 0;
  integerInRange(limit, 1, 30, "limit");
  integerInRange(maxChars, 200, 12000, "maxChars");
  integerInRange(maxTotalChars, 200, 20000, "maxTotalChars");
  integerInRange(offset, 0, Number.MAX_SAFE_INTEGER, "offset");
  if (options.view !== "messages" && options.view !== "blocks")
    throw new Error("view must be messages or blocks");
  for (const field of ["before", "blockId", "readVersion"] as const) {
    if (
      options[field] !== undefined &&
      (typeof options[field] !== "string" || !options[field].length)
    )
      throw new Error(`${field} must be a nonempty string`);
  }
  if (typeof source.readVersion !== "string" || !source.readVersion.length)
    throw new Error("A saved readVersion is required");
  if (!Number.isFinite(source.updatedAt) || source.updatedAt < 0)
    throw new Error("A saved updatedAt is required");
  if (
    options.readVersion !== undefined &&
    options.readVersion !== source.readVersion
  )
    throw new SessionBlocksVersionError(
      options.readVersion,
      source.readVersion,
      source.updatedAt,
    );
  if (options.blockId !== undefined && options.before !== undefined)
    throw new Error("blockId and before cannot be combined");
  if (offset > 0 && options.blockId === undefined)
    throw new Error("offset requires blockId");
  if (offset > 0 && options.readVersion === undefined)
    throw new Error("readVersion is required to continue a block");

  const blocks = source.blocks.filter(
    (block) =>
      !block.draft &&
      !block.internal &&
      (options.view === "blocks" ||
        block.role === "user" ||
        block.role === "assistant"),
  );
  const single = options.blockId !== undefined;
  const anchor = single ? options.blockId : options.before;
  const anchorIndex =
    anchor === undefined
      ? blocks.length
      : blocks.findIndex((block) => block.id === anchor);
  if (anchorIndex < 0)
    throw new Error(`${single ? "blockId" : "before"} is not in this view`);
  const end = single ? anchorIndex + 1 : anchorIndex;
  const selected: SessionBlockSlice[] = [];
  let nextBefore: string | null = null;
  const page = (
    slices = selected,
    before = nextBefore,
  ): SessionBlocksPage => ({
    sessionId: source.id,
    title: source.title,
    cwd: source.cwd,
    updatedAt: source.updatedAt,
    readVersion: source.readVersion,
    view: options.view,
    offsetUnit: "utf-16",
    blocks: slices,
    nextBefore: before,
    truncated: before !== null || slices.some((slice) => slice.truncated),
  });
  if (JSON.stringify(page()).length > maxTotalChars)
    throw new Error("maxTotalChars cannot fit the session metadata");

  for (let index = end - 1; index >= 0 && selected.length < limit; index--) {
    const block = blocks[index];
    const full = readableText(block, options.view);
    const from = single ? offset : 0;
    if (from > full.length || splitsSurrogatePair(full, from))
      throw new Error("offset must be a UTF-16 character boundary within the block");
    const before = !single && index > 0 ? block.id : null;
    const slice = (to: number): SessionBlockSlice => ({
      id: block.id,
      role: block.role,
      text: full.slice(from, to),
      offset: from,
      nextOffset: to < full.length ? to : null,
      totalChars: full.length,
      truncated: to < full.length,
      ...(block.tool
        ? { tool: { kind: block.tool.kind, status: block.tool.status } }
        : {}),
      ...(block.plan ? { plan: { status: block.plan.status } } : {}),
    });
    const fits = (to: number) =>
      JSON.stringify(page([slice(to), ...selected], before)).length <=
      maxTotalChars;
    const maximum = safeEnd(full, Math.min(full.length, from + maxChars));
    let to = maximum;
    if (!fits(to)) {
      // Check the complete slice first: its null cursor changes JSON size.
      // Within truncated prefixes JSON length grows monotonically.
      let low = from;
      let high = maximum < full.length ? maximum : maximum - 1;
      to = -1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const boundary = safeEnd(full, middle);
        if (fits(boundary)) {
          to = boundary;
          low = middle + 1;
        } else high = middle - 1;
      }
    }
    if (to < from || (to === from && from < full.length)) {
      if (selected.length) break;
      throw new Error("maxTotalChars cannot fit block metadata and one character");
    }
    selected.unshift(slice(to));
    nextBefore = before;
    if (single) break;
  }
  return page();
}

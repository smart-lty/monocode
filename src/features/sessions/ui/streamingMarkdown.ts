import { defaultSchema } from "rehype-sanitize";
import remend from "remend";
import { parseMarkdownIntoBlocks } from "streamdown";

export function isFenceBlock(content: string): boolean {
  return /^ {0,3}(?:`{3,}|~{3,})/.test(content);
}

function hasPendingHtmlTag(block: string): boolean {
  const tag = /<\/?([a-z][a-z0-9-]*)(?:\s[^<>]*|\/?$)$/i.exec(block);
  if (!tag || (tag.index > 0 && /[\p{L}\p{N}_]/u.test(block[tag.index - 1])))
    return false;
  const name = tag[1].toLowerCase();
  return (defaultSchema.tagNames ?? []).some((allowed) =>
    allowed.startsWith(name),
  );
}

/**
 * Repair incomplete prose after splitting it into blocks. Remend scans back
 * through the source for each emphasis/link marker; running it over a large
 * Markdown fence can become quadratic, even though its contents are literal.
 * The Markdown parser already accepts open fences, so leave those untouched.
 */
export function parseStreamingMarkdown(
  text: string,
  { streaming = false }: { streaming?: boolean } = {},
): string[] {
  const blocks = parseMarkdownIntoBlocks(text);
  return blocks.map((block, index) =>
    isFenceBlock(block)
      ? block
      : remend(block, {
          htmlTags:
            streaming &&
            index === blocks.length - 1 &&
            hasPendingHtmlTag(block),
        }),
  );
}

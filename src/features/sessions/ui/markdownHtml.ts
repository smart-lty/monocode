import type { Nodes, Root, RootContent } from "hast";
import { defaultSchema } from "rehype-sanitize";
import type { VFile } from "vfile";

const allowedTags = new Set(defaultSchema.tagNames);
// Keep active/raw-text HTML in the sanitizer's hands. Its contents must not
// be split into new raw nodes, even when they look like unknown tags.
const rawTextTags = new Set([
  "script",
  "style",
  "iframe",
  "textarea",
  "title",
  "xmp",
  "noembed",
  "noframes",
  "plaintext",
]);
const htmlTokens =
  /<!--[\s\S]*?(?:-->|$)|<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/g;

/** Restore unknown HTML tokens before raw parsing lowercases/absorbs them. */
export function rehypePreserveUnknownTags() {
  return (tree: Root, file: VFile) => {
    const source = String(file.value);

    function restore(node: Nodes): RootContent[] | undefined {
      if (node.type !== "raw") return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const original = source.slice(start, end);
      // Source coordinates are authoritative; don't reconstruct a tag from a
      // normalized name or guess positions after another plugin rewrites HTML.
      if (original !== node.value) return;
      const parts: RootContent[] = [];
      let last = 0;
      let rawText: string | undefined;
      for (const token of original.matchAll(htmlTokens)) {
        const name = token[1]?.toLowerCase();
        if (!name) continue;
        const closing = token[0].startsWith("</");
        if (rawText) {
          if (closing && name === rawText) rawText = undefined;
          continue;
        }
        if (rawTextTags.has(name)) {
          if (!closing) rawText = name;
          continue;
        }
        if (allowedTags.has(name)) continue;
        const offset = token.index!;
        if (offset > last)
          parts.push({ type: "raw", value: original.slice(last, offset) });
        parts.push({
          type: "text",
          value: source.slice(start + offset, start + offset + token[0].length),
        });
        last = offset + token[0].length;
      }
      if (!parts.length) return;
      if (last < original.length)
        parts.push({ type: "raw", value: original.slice(last) });
      return parts;
    }

    function visit(node: Nodes) {
      if (!("children" in node)) return;
      node.children = node.children.flatMap((child) => {
        const restored = restore(child);
        if (restored) return restored;
        visit(child);
        return [child];
      }) as typeof node.children;
    }
    visit(tree);
  };
}

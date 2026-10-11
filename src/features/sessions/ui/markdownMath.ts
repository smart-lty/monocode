import type {} from "mdast-util-math";
import type { Root, Nodes } from "mdast";
import type { VFile } from "vfile";

/** Single dollars in prices and shell prose are not formula delimiters. */
export function remarkLiteralDollars() {
  return (tree: Root, file: VFile) => {
    const source = String(file.value);
    function visit(node: Nodes) {
      if (!("children" in node)) return;
      node.children = node.children.map((child) => {
        if (child.type === "inlineMath") {
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          if (start !== undefined && end !== undefined) {
            const raw = source.slice(start, end);
            if (
              /^\$(?!\$)/.test(raw) &&
              (/^[\d\s]/.test(raw.slice(1)) ||
                /\s\$$/.test(raw) ||
                /\d/.test(source[end] ?? ""))
            )
              return {
                type: "text" as const,
                value: raw,
                position: child.position,
              };
          }
        }
        visit(child);
        return child;
      }) as typeof node.children;
    }
    visit(tree);
  };
}

import type { Root } from "hast";
import { toHtml } from "hast-util-to-html";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import { VFile } from "vfile";
import { describe, expect, it } from "vitest";
import { rehypePreserveUnknownTags } from "./markdownHtml";

function render(source: string) {
  const parser = unified()
    .use(remarkParse)
    .use(Object.values(defaultRemarkPlugins))
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypePreserveUnknownTags)
    .use([defaultRehypePlugins.raw, defaultRehypePlugins.sanitize]);
  const file = new VFile(source);
  return toHtml(parser.runSync(parser.parse(file), file) as Root).replaceAll(
    "&#x3C;",
    "&lt;",
  );
}

describe("unknown Markdown HTML tokens", () => {
  it.each([
    [
      "返回 Vec<String> 类型，再看 Option<T> 与 Map<K, V>。",
      "返回 Vec&lt;String> 类型，再看 Option&lt;T> 与 Map&lt;K, V>。",
    ],
    [
      "Vec<String> Option<T> Vec<STRING> Option<t>",
      "Vec&lt;String> Option&lt;T> Vec&lt;STRING> Option&lt;t>",
    ],
    ["Foo<Bar<Baz>> end", "Foo&lt;Bar&lt;Baz>> end"],
    ["中文 😀 Vec<String>\nOption<T>", "中文 😀 Vec&lt;String>\nOption&lt;T>"],
  ])("preserves exact source spelling: %s", (source, expected) => {
    expect(render(source)).toContain(expected);
  });

  it("restores unknown opening/closing tags and quoted attributes by position", () => {
    const html = render(
      '<Widget DATA-x="A>B" onClick="alert(1)">before <kbd>K</kbd></Widget> after',
    );
    expect(html).toContain('&lt;Widget DATA-x="A>B" onClick="alert(1)">');
    expect(html).toContain("<kbd>K</kbd>");
    expect(html).toContain("&lt;/Widget> after");
    expect(html).not.toContain("<widget");
    expect(html).not.toContain("<Widget");
  });

  it("preserves a raw HTML block without lowercasing its unknown tags", () => {
    const html = render(
      "<Unknown data-Foo='a>b'>\n<kbd>Ctrl</kbd><br>tail\n</Unknown>",
    );
    expect(html).toContain("&lt;Unknown data-Foo='a>b'>");
    expect(html).toContain("<kbd>Ctrl</kbd><br>tail");
    expect(html).toContain("&lt;/Unknown>");
  });

  it("keeps details, kbd and br while sanitizing events, scripts and frames", () => {
    const html = render(
      '<details open onclick="alert(1)"><summary>More</summary><kbd onmouseover="alert(2)">Ctrl</kbd><br>Tail</details>\n\n<script>window.bad = "<Unknown>";</script>\n\n<iframe src="https://evil.invalid"></iframe>',
    );
    expect(html).toContain("<details open>");
    expect(html).toContain("<summary>More</summary><kbd>Ctrl</kbd><br>Tail");
    expect(html).not.toMatch(/<script|<iframe|\sonclick=|\sonmouseover=/i);
  });

  it("leaves literal code, entities and commented tags untouched", () => {
    const html = render(
      '`Vec<String>` and &lt;T&gt;\n\n```html\n<Widget onclick="bad()">\n```\n\n<!-- <Hidden> -->',
    );
    expect(html).toContain("<code>Vec&lt;String></code>");
    expect(html).toContain("and &lt;T>");
    expect(html).toContain('&lt;Widget onclick="bad()">');
    expect(html).not.toContain("&lt;Hidden>");
  });

  it("does not guess source text when raw source coordinates are unavailable", () => {
    const raw = { type: "raw" as const, value: "<WRONG>" };
    const tree: Root = { type: "root", children: [raw] };
    rehypePreserveUnknownTags()(tree, new VFile("<Actual>"));
    expect(tree.children).toEqual([raw]);
  });
});

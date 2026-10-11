import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";

describe("AgentMarkdown text direction", () => {
  it("detects direction independently for RTL and LTR blocks", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: [
          "# راهنمای تنظیمات",
          "",
          "این متن فارسی است.",
          "",
          "1. مرحله اول",
          "2. مرحله دوم",
          "",
          "English remains left to right.",
        ].join("\n"),
      }),
    );

    expect(markup).toMatch(/dir="rtl"[^>]*><h1/);
    expect(markup).toMatch(/dir="rtl"[^>]*><p/);
    expect(markup).toMatch(/dir="rtl"[^>]*><ol/);
    expect(markup).toMatch(/dir="ltr"[^>]*><p/);
  });

  it("isolates links and inline code inside RTL prose", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "مسیر `templates/admin/settings.html` و [پیوند](https://example.com) را بررسی کنید.",
      }),
    );

    expect(markup).toContain('<code dir="ltr"');
    expect(markup).toContain('dir="auto"');
  });

  it("keeps fenced code blocks LTR when their content is Arabic", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "```txt\nمرحبا بالعالم\n```",
      }),
    );

    expect(markup).toContain('class="markdown-code-shell" dir="ltr"');
  });
});

describe("AgentMarkdown inline code", () => {
  it("lets a long inline code span grow instead of clipping to a fixed height", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "1. `Before I refactor the transcript rendering, summarize how turns are grouped, in five bullets.`",
      }),
    );

    const match = markup.match(/<code dir="ltr" class="([^"]*)"/);
    expect(match).not.toBeNull();
    const classes = match![1].split(/\s+/);
    expect(classes).toContain("inline-flex");
    expect(classes).toContain("min-h-6");
    expect(classes).toContain("max-w-full");
    expect(classes).toContain("[overflow-wrap:anywhere]");
    expect(classes).not.toContain("h-6");
  });
});

describe("AgentMarkdown code fence highlighting", () => {
  it("falls back to JS highlighting for a fence tagged text", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "```text\nconst x = 1;\n```",
      }),
    );

    expect(markup).toContain('data-language="js"');
    expect(markup).not.toContain('data-language="text"');
  });

  it("falls back to JS highlighting for an untagged fence", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "```\nconst x = 1;\n```",
      }),
    );

    expect(markup).toContain('data-language="js"');
  });

  it("leaves an explicit real language alone", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "```python\nx = 1\n```",
      }),
    );

    expect(markup).toContain('data-language="python"');
  });

  it("keeps a text fence labeled text despite the JS highlighting fallback", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "```text\nconst x = 1;\n```",
      }),
    );

    expect(markup).toContain('data-language="js"');
    expect(markup).toMatch(
      /class="markdown-code-fallback-label"[^>]*>text<\/span>/,
    );
  });

  it("leaves an untagged fence without a visible language label", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "```\nconst x = 1;\n```",
      }),
    );

    expect(markup).toMatch(
      /class="markdown-code-fallback-label"[^>]*><\/span>/,
    );
  });

  it("keeps the plaintext and txt fallbacks labeled with their own fence language", () => {
    const plaintextMarkup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "```plaintext\nconst x = 1;\n```",
      }),
    );
    expect(plaintextMarkup).toContain('data-language="js"');
    expect(plaintextMarkup).toMatch(
      /class="markdown-code-fallback-label"[^>]*>plaintext<\/span>/,
    );

    const txtMarkup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "```txt\nconst x = 1;\n```",
      }),
    );
    expect(txtMarkup).toContain('data-language="js"');
    expect(txtMarkup).toMatch(
      /class="markdown-code-fallback-label"[^>]*>txt<\/span>/,
    );
  });

  it("does not add a fallback label for a real language", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "```python\nx = 1\n```",
      }),
    );

    expect(markup).not.toContain("markdown-code-fallback-label");
  });
});

describe("AgentMarkdown note images", () => {
  it("keeps app-owned note image references for the async image resolver", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "![Diagram](/note-assets/note-1/123-diagram.png)",
      }),
    );

    expect(markup).toContain(
      'data-note-image="/note-assets/note-1/123-diagram.png"',
    );
    expect(markup).toContain("Loading image: Diagram");
  });
});

describe("AgentMarkdown completed prose", () => {
  it("preserves a less-than comparison in completed output", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, { text: "如果 a<b 则交换。" }),
    );
    expect(markup).toContain("如果 a&lt;b 则交换。");
  });

  it("renders ordinary network images in sessions", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "![Network diagram](https://images.example.org/diagram.png)",
      }),
    );
    expect(markup).toContain("<img");
    expect(markup).toContain('src="https://images.example.org/diagram.png"');
  });

  it("retains numeric ranges and list comparisons without unintended markup", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "范围 20~25 之间，或 30~40\n\n价格 1~2 元到 3~4 元\n\n- > 25",
      }),
    );
    expect(markup).toContain("范围 20~25 之间，或 30~40");
    expect(markup).toContain("价格 1~2 元到 3~4 元");
    expect(markup).toContain("&gt; 25");
    expect(markup).not.toMatch(/<del|<blockquote/);
  });

  it("preserves exact generic names alongside legitimate HTML", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "Vec<String>、Option<T>、Map<K, V>\n\n<details open><summary>More</summary><kbd>Ctrl</kbd><br>Tail</details>",
      }),
    );
    expect(markup).toContain(
      "Vec&lt;String&gt;、Option&lt;T&gt;、Map&lt;K, V&gt;",
    );
    expect(markup).toContain("<details open=");
    expect(markup).toContain("<kbd>Ctrl</kbd><br/>Tail");
  });

  it("uses the official CJK plugin for Chinese emphasis and URL boundaries", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: "**注意：**后面的内容需要确认。\n\n这是**“引用”**文本，以及**（括号）**说明。\n\n访问 https://example.com/docs。然后继续",
      }),
    );
    expect(markup).toMatch(/data-streamdown="strong"[^>]*>注意：<\/span>/);
    expect(markup).toMatch(/data-streamdown="strong"[^>]*>“引用”<\/span>/);
    expect(markup).toMatch(/data-streamdown="strong"[^>]*>（括号）<\/span>/);
    expect(markup).not.toContain("**");
    expect(markup).toContain('href="https://example.com/docs"');
    expect(markup).toContain("</a>。然后继续");
  });

  it("keeps HTML event attributes and scripts inert", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        text: '<details onclick="bad()"><summary>Safe</summary><kbd onmouseover="bad()">K</kbd></details>\n\n<Widget onClick="bad()">unknown</Widget>\n\n<script>bad()</script>',
      }),
    );
    expect(markup).toContain("&lt;Widget onClick=&quot;bad()&quot;&gt;");
    expect(markup).not.toMatch(/<script|<[^>]*\s(?:onclick|onmouseover)=/i);
  });
});


describe("AgentMarkdown math", () => {
  const render = (text: string) => renderToStaticMarkup(createElement(AgentMarkdown, { text }));

  it("renders inline and block math with KaTeX and accessible MathML", () => {
    const markup = render("Inline $x^2$ and ${2x+1}$.\n\n$$\n\\frac{1}{2}\n$$");
    expect(markup.match(/class="katex"/g)).toHaveLength(3);
    expect(markup).toContain('class="katex-display"');
    expect(markup).toContain("<math");
    expect(markup).toContain("<mfrac>");
    expect(markup).not.toContain("markdown-code-shell");
  });

  it.each([
    "It costs $5 and $10", "价格从 $5 涨到 $10", "between $1.50 and $2.00",
    "Set $HOME and $PATH", "Set $HOME", "$ x$", "$x $", "$2x+1$",
  ])("preserves literal dollars: %s", (text) => {
    const markup = render(text);
    expect(markup).not.toContain('class="katex"');
    expect(markup).toContain(text);
  });

  it("renders a real formula after literal prices", () => {
    const markup = render("It costs $5 and $10. Use $x^2$ or ${2x+1}$.");
    expect(markup.match(/class="katex"/g)).toHaveLength(2);
    expect(markup).toContain("$5 and $10");
  });

  it("keeps code and escaped currency literal", () => {
    const markup = render("`$x^2$` and \\$5, \\$10.\n\n```text\n$$x^2$$\n```");
    expect(markup).not.toContain('class="katex"');
    expect(markup).toContain("$x^2$");
    expect(markup).toContain("$5, $10");
  });

  it("keeps invalid math visible and does not execute trusted KaTeX commands", () => {
    const markup = render("$\\notACommand{x}$ and $\\href{javascript:alert(1)}{click}$");
    expect(markup).toContain("notACommand");
    expect(markup).not.toContain('href="javascript:');
    expect(markup).not.toContain("<script");
  });
});

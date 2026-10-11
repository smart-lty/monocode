import { describe, expect, it } from "vitest";
import {
  removeSessionToken,
  sessionQueryPreselects,
  sessionTitleMatch,
  sessionTokenAt,
  setSessionTokenScope,
} from "./sessionPicker";

const at = (text: string) => sessionTokenAt(text, text.length);

describe("sessionTokenAt", () => {
  it("opens # for this project and ## for all projects", () => {
    expect(at("#")).toEqual({ start: 0, end: 1, scope: "project", query: "" });
    expect(at("see #输入法")).toEqual({
      start: 4,
      end: 8,
      scope: "project",
      query: "输入法",
    });
    expect(at("##compose")).toEqual({
      start: 0,
      end: 9,
      scope: "all",
      query: "compose",
    });
  });

  it("follows backspace from ## to # to closed", () => {
    expect(at("##")?.scope).toBe("all");
    expect(at("#")?.scope).toBe("project");
    expect(at("")).toBeNull();
  });

  it("measures the query to the caret but replaces the whole word", () => {
    expect(sessionTokenAt("#abc def", 2)).toEqual({
      start: 0,
      end: 4,
      scope: "project",
      query: "a",
    });
  });

  it("ignores markdown headings, ###, a#b, quotes and full-width ＃", () => {
    expect(at("# ")).toBeNull();
    expect(at("## 小节")).toBeNull();
    expect(at("###")).toBeNull();
    expect(at("###x")).toBeNull();
    expect(at("a#b")).toBeNull();
    expect(at("url#anchor")).toBeNull();
    expect(at("> #x")).toBeNull();
    expect(at("＃会话")).toBeNull();
    expect(at("#a#b")).toBeNull();
  });

  it("ignores fenced and inline code", () => {
    expect(at("```c\n#include")).toBeNull();
    expect(at("~~~\n#x")).toBeNull();
    expect(at("````\n```\n#x")).toBeNull();
    expect(at("```\ncode\n```\n#x")?.query).toBe("x");
    expect(at("~~~\na\n~~~\n#x")?.query).toBe("x");
    expect(at("run `#x")).toBeNull();
    expect(at("run `a` #x")?.query).toBe("x");
  });

  it("matches code spans by equal-length backtick runs", () => {
    // Caret after the query, before the closing delimiter.
    const inDouble = "see ``code #query`` after";
    expect(sessionTokenAt(inDouble, inDouble.indexOf("``", 6))).toBeNull();
    expect(at("see ``code #q")).toBeNull();
    // A single backtick inside a double span does not close it.
    expect(at("``a ` b #q")).toBeNull();
    expect(at("```x `` y #q")).toBeNull();
    // Closed spans of any length leave later tokens alone.
    expect(at("``a ` b`` #q")?.query).toBe("q");
    expect(at("```a``` #q")?.query).toBe("q");
    expect(at("`a` ``b`` #q")?.query).toBe("q");
  });

  it("follows code spans across lines of one paragraph only", () => {
    const open = "start `code\nstill #q";
    // Closed later in the paragraph: still code.
    expect(sessionTokenAt(`${open} end\` more`, open.length)).toBeNull();
    // Never closed: an earlier line's stray backtick is literal.
    expect(at(open)?.query).toBe("q");
    // A blank line ends the paragraph and the span.
    const split = "a `b\n\n#q";
    expect(sessionTokenAt(`${split} c\``, split.length)?.query).toBe("q");
  });

  it("treats escaped backticks outside code as literal", () => {
    expect(at("a \\` #q")?.query).toBe("q");
    expect(at("\\`` x #q")).toBeNull();
    expect(at("a \\\\`b #q")).toBeNull();
  });
});

describe("sessionQueryPreselects", () => {
  it("never preselects blank, numeric or any valid hex color query", () => {
    for (const query of [
      "",
      " ",
      "123",
      "abc",
      "abcd",
      "abcdef",
      "abcdefab",
      "fff",
      "FFFF",
      "cafe",
      "decade",
      "1e1e1e",
      "ff00ff80",
    ])
      expect(sessionQueryPreselects(query)).toBe(false);
    for (const query of ["输入", "include", "fix", "ab", "abcde", "abcdefg"])
      expect(sessionQueryPreselects(query)).toBe(true);
  });
});

describe("token edits", () => {
  it("removes the token and its trailing space, leaving the caret there", () => {
    const text = "before #comp after";
    const token = sessionTokenAt(text, 12)!;
    expect(removeSessionToken(text, token)).toEqual({
      text: "before after",
      cursor: 7,
    });
    expect(removeSessionToken("#x", at("#x")!)).toEqual({
      text: "",
      cursor: 0,
    });
  });

  it("rewrites the prefix when the scope button changes it", () => {
    const text = "x #abc y";
    const token = sessionTokenAt(text, 6)!;
    const next = setSessionTokenScope(text, token, "all");
    expect(next.text).toBe("x ##abc y");
    expect(next.cursor).toBe(7);
    expect(sessionTokenAt(next.text, next.cursor)).toEqual(next.token);
    const back = setSessionTokenScope(next.text, next.token, "project");
    expect(back.text).toBe(text);
    expect(sessionTokenAt(back.text, back.cursor)).toEqual(back.token);
  });

  it("highlights a case-insensitive title substring", () => {
    expect(sessionTitleMatch("Fix Composer", "comp")).toEqual([4, 5, 6, 7]);
    expect(sessionTitleMatch("修复输入法", "输入")).toEqual([2, 3]);
    expect(sessionTitleMatch("abc", "zz")).toEqual([]);
  });
});

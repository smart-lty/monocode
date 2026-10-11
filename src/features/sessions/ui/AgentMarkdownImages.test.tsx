// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBinaryFile } from "../../../platform/tauri/fs";
import { AgentMarkdown } from "./AgentMarkdown";
import {
  MarkdownImage,
  resolveMarkdownImageSource,
  sniffMarkdownImageMime,
} from "./AgentMarkdownImages";

vi.mock("../../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../../platform/tauri/fs")>()),
  readBinaryFile: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `http://asset.localhost${path}`,
}));
vi.mock("../../../platform/tauri/trackpadZoom", () => ({
  claimTrackpadMagnify: () => () => {},
}));

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const svg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>',
);
let root: Root;
let container: HTMLDivElement;
let nextUrl: number;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(readBinaryFile).mockReset().mockResolvedValue(png);
  vi.mocked(invoke).mockReset();
  nextUrl = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => `blob:markdown-${++nextUrl}`,
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(
  text: string,
  options: { cwd?: string; allowRemoteMedia?: boolean } = { cwd: "/repo" },
) {
  await act(async () =>
    root.render(createElement(AgentMarkdown, { text, ...options })),
  );
}

describe("session Markdown images", () => {
  it.each([
    "http://images.example.org/diagram.png",
    "https://images.example.org/diagram.png",
  ])("renders %s without reading it as a local file", async (url) => {
    await render(`![Network diagram](${url})`);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(url);
    expect(readBinaryFile).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["images/chart.png", "/repo/images/chart.png"],
    ["./images/chart.png", "/repo/images/chart.png"],
    ["../chart.png", "/chart.png"],
    ["/tmp/chart.png", "/tmp/chart.png"],
    ["images/中文 图.png", "/repo/images/中文 图.png"],
    ["/tmp/中文 图.png", "/tmp/中文 图.png"],
    ["images/%E4%B8%AD%E6%96%87%20%E5%9B%BE.png", "/repo/images/中文 图.png"],
    ["/tmp/progress%25.png", "/tmp/progress%.png"],
    ["C:/中文 图/chart.png", "C:/中文 图/chart.png"],
  ])(
    "reads the image path %s through controlled blob URLs",
    async (src, path) => {
      await render(`![Local diagram](<${src}>)`);
      expect(readBinaryFile).toHaveBeenCalledWith(path);
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "blob:markdown-1",
      );
      expect(URL.createObjectURL).toHaveBeenCalledWith(
        expect.objectContaining({ type: "image/png" }),
      );
      expect(container.innerHTML).not.toContain("asset.localhost");
    },
  );

  it("resolves the same relative image again when the session cwd changes", async () => {
    await render("![Chart](chart.png)", { cwd: "/repo-one" });
    await render("![Chart](chart.png)", { cwd: "/repo-two" });
    expect(readBinaryFile).toHaveBeenNthCalledWith(1, "/repo-one/chart.png");
    expect(readBinaryFile).toHaveBeenNthCalledWith(2, "/repo-two/chart.png");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:markdown-1");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:markdown-2",
    );
  });

  it("releases blobs on replacement and unmount", async () => {
    await render("![First](first.png)");
    await render("![Second](second.png)");
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:markdown-1");
    await act(async () => root.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenLastCalledWith("blob:markdown-2");
  });

  it("ignores a native read that resolves after the image was removed", async () => {
    let resolve!: (bytes: Uint8Array) => void;
    vi.mocked(readBinaryFile).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render("![Slow](slow.png)");
    expect(container.textContent).toContain("Loading image: Slow");
    await render("Removed.");
    await act(async () => resolve(png));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(container.textContent).toBe("Removed.");
  });

  it("does not leak blobs during StrictMode effect replays", async () => {
    await act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(MarkdownImage, {
            src: "chart.png",
            cwd: "/repo",
            alt: "Chart",
          }),
        ),
      ),
    );
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("opens the existing lightbox and closes it with Escape", async () => {
    await render("![Diagram](diagram.png)");
    await act(async () =>
      container.querySelector<HTMLImageElement>("img")!.click(),
    );
    expect(
      document.querySelector('[role="dialog"] img')?.getAttribute("src"),
    ).toBe("blob:markdown-1");
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows alt text and a useful failure message on network decode failure", async () => {
    await render("![Broken network](https://images.example.org/missing.png)");
    await act(async () =>
      container.querySelector("img")!.dispatchEvent(new Event("error")),
    );
    expect(container.textContent).toContain("Broken network");
    expect(container.textContent).toContain("Could not load image");
    expect(container.querySelector("img")).toBeNull();
  });

  it("releases an unreadable image blob and keeps its alt text", async () => {
    await render("![Broken local](broken.png)");
    await act(async () =>
      container.querySelector("img")!.dispatchEvent(new Event("error")),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:markdown-1");
    expect(container.textContent).toContain(
      "Broken local — Could not load image",
    );
  });

  it.each(["read", "mime"])(
    "explains a local %s failure instead of disappearing",
    async (failure) => {
      if (failure === "read")
        vi.mocked(readBinaryFile).mockRejectedValue(new Error("ENOENT"));
      else
        vi.mocked(readBinaryFile).mockResolvedValue(
          new TextEncoder().encode("<html>Not an image</html>"),
        );
      await render("![Missing diagram](missing.png)");
      expect(container.textContent).toContain("Missing diagram");
      expect(container.textContent).toContain("Could not load image");
      expect(container.textContent).toContain(
        failure === "read" ? "could not be read" : "not a supported image",
      );
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    },
  );

  it("keeps a missing-cwd failure visible", async () => {
    await render("![Relative](diagram.png)", {});
    expect(container.textContent).toContain("working directory is needed");
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("keeps data images working through sanitize and harden", async () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    await render(`![Data diagram](${src})`);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(src);
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("keeps the notes resolver separate from the binary reader", async () => {
    vi.mocked(invoke).mockResolvedValue(
      "/app-data/note-assets/notes-component/diagram.png",
    );
    await render("![Note diagram](/note-assets/notes-component/diagram.png)");
    expect(invoke).toHaveBeenCalledWith("notes_image_path", {
      asset: "/note-assets/notes-component/diagram.png",
    });
    expect(
      container.querySelector("img")?.getAttribute("data-note-image"),
    ).toBe("/note-assets/notes-component/diagram.png");
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("uses the Inbox fetcher only for allowed sources and never falls back to local reads", async () => {
    vi.mocked(invoke).mockResolvedValue(png.buffer);
    await render(
      "![Allowed](https://user-images.githubusercontent.com/diagram.png)\n\n![Blocked](https://images.example.org/diagram.png)\n\n![Local](/tmp/chart.png)",
      { cwd: "/repo", allowRemoteMedia: true },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("fetch_inbox_media", {
      url: "https://user-images.githubusercontent.com/diagram.png",
    });
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.textContent).toContain("Image blocked: Blocked");
    expect(container.textContent).toContain("Image blocked: Local");
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it.each([
    "javascript:alert%281%29",
    "vbscript:msgbox%281%29",
    "file:///tmp/chart.png",
    "blob:uncontrolled",
    "ftp://example.org/chart.png",
    "//example.org/chart.png",
    "%2F%2Fhost/share/chart.png",
    "javascript%3Aalert%281%29",
  ])("does not execute or read unsupported image source %s", async (src) => {
    await render(`![Unsafe](<${src}>)`);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Unsafe");
    expect(readBinaryFile).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("Markdown picture sources", () => {
  it("removes srcset URLs that could bypass Inbox's source checks", async () => {
    vi.mocked(invoke).mockResolvedValue(png.buffer);
    await render(
      '<picture><source srcset="https://images.example.org/spoof.png"><img src="https://user-images.githubusercontent.com/picture.png" alt="Inbox picture"></picture>',
      { allowRemoteMedia: true },
    );
    expect(
      container.querySelector("source")?.getAttribute("srcset"),
    ).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:markdown-1",
    );
    expect(invoke).toHaveBeenCalledWith("fetch_inbox_media", {
      url: "https://user-images.githubusercontent.com/picture.png",
    });
  });
});

describe("local Markdown SVG images", () => {
  it("accepts valid SVG as an image blob and retains raster detection", async () => {
    expect(sniffMarkdownImageMime(png)).toBe("image/png");
    expect(sniffMarkdownImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(
      "image/jpeg",
    );
    expect(sniffMarkdownImageMime(svg)).toBe("image/svg+xml");
    vi.mocked(readBinaryFile).mockResolvedValue(svg);
    await render("![SVG chart](images/chart.svg)");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:markdown-1",
    );
    expect(URL.createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image/svg+xml" }),
    );
    expect(container.querySelector("svg, iframe, object")).toBeNull();
  });

  it.each([
    '<html><svg xmlns="http://www.w3.org/2000/svg"/></html>',
    '<svg xmlns="https://wrong.invalid"/>',
    "not SVG",
  ])("rejects a non-SVG document with useful feedback", async (source) => {
    vi.mocked(readBinaryFile).mockResolvedValue(
      new TextEncoder().encode(source),
    );
    await render("![Bad SVG](bad.svg)");
    expect(container.textContent).toContain("Bad SVG — Could not load image");
    expect(container.querySelector("img")).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe("image protocol validation", () => {
  it("retains Windows paths but blocks network paths and URI schemes", () => {
    expect(resolveMarkdownImageSource("C:\\图 表\\chart.png")).toEqual({
      kind: "local",
      path: "C:/图 表/chart.png",
    });
    expect(resolveMarkdownImageSource("\\\\host\\share\\chart.png").kind).toBe(
      "blocked",
    );
    expect(resolveMarkdownImageSource("file:///tmp/chart.png").kind).toBe(
      "blocked",
    );
    expect(
      resolveMarkdownImageSource("https://images.example.org/chart.png", {
        inboxOnly: true,
      }).kind,
    ).toBe("blocked");
  });
});

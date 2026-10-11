import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentMarkdown } from "../../src/features/sessions/ui/AgentMarkdown";
import "../../src/styles/index.css";

export type MarkdownExample = {
  text: string;
  streaming?: boolean;
  revealOnMount?: boolean;
  cwd?: string;
  allowRemoteMedia?: boolean;
  className?: string;
  zen?: boolean;
  mountId?: string;
};

export type MarkdownFixture = {
  showMarkdown: (example: MarkdownExample) => void;
  fileReads: string[];
  mediaFetches: string[];
  openedFiles: {
    path: string;
    navigation?: { line: number; column?: number };
  }[];
  createdImageUrls: string[];
  revokedImageUrls: string[];
};

const fixture = window as unknown as MarkdownFixture;
fixture.fileReads = [];
fixture.mediaFetches = [];
fixture.openedFiles = [];
fixture.createdImageUrls = [];
fixture.revokedImageUrls = [];

// Exercise the real frontend readBinaryFile boundary with synthetic bytes.
// This fixture does not launch Tauri or validate native filesystem access.
const canvas = document.createElement("canvas");
canvas.width = 1600;
canvas.height = 400;
canvas.getContext("2d")!.fillRect(0, 0, canvas.width, canvas.height);
const imageBytes = Uint8Array.from(
  atob(canvas.toDataURL("image/png").split(",")[1]),
  (char) => char.charCodeAt(0),
);
const jpegBytes = Uint8Array.from(
  atob(canvas.toDataURL("image/jpeg").split(",")[1]),
  (char) => char.charCodeAt(0),
);

Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args: Record<string, string>) => {
      if (command === "read_binary_file") {
        fixture.fileReads.push(args.path);
        if (args.path.includes("missing")) throw new Error("File not found");
        if (args.path.includes("invalid"))
          return new TextEncoder().encode("<html>bad</html>").buffer;
        if (args.path.includes("malformed.svg"))
          return new TextEncoder().encode(
            '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>',
          ).buffer;
        if (args.path.endsWith(".svg")) {
          return new TextEncoder().encode(`<?xml version="1.0"?>
<?xml-stylesheet href="https://svg-resources.invalid/style.css" type="text/css"?>
<!DOCTYPE svg SYSTEM "https://svg-resources.invalid/svg.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1600" height="400" onload="parent.__svgEventRan = true">
  <script><![CDATA[parent.__svgScriptRan = true; fetch("https://svg-resources.invalid/script");]]></script>
  <style>@import url("https://svg-resources.invalid/import.css"); @font-face { font-family: external; src: url("https://svg-resources.invalid/font.woff2"); } text { font-family: external; }</style>
  <rect width="1600" height="400" fill="navy"/>
  <image href="https://svg-resources.invalid/image.png" width="40" height="40"/>
  <use xlink:href="https://svg-resources.invalid/external.svg#shape"/>
  <foreignObject width="100" height="100"><img xmlns="http://www.w3.org/1999/xhtml" src="https://svg-resources.invalid/html.png" onerror="parent.__svgEventRan = true"/></foreignObject>
  <text x="10" y="20">Local SVG</text>
</svg>`).buffer;
        }
        return (args.path.endsWith(".jpg") ? jpegBytes : imageBytes).slice()
          .buffer;
      }
      if (command === "fetch_inbox_media") {
        fixture.mediaFetches.push(args.url);
        return imageBytes.slice().buffer;
      }
      if (command === "notes_image_path") {
        return `/app-data${args.asset}`;
      }
      throw new Error(`Unexpected native command: ${command}`);
    },
    convertFileSrc: (path: string) => `http://asset.localhost${path}`,
  },
});

const createUrl = URL.createObjectURL.bind(URL);
URL.createObjectURL = (blob) => {
  const url = createUrl(blob);
  fixture.createdImageUrls.push(url);
  return url;
};
const revokeUrl = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => {
  fixture.revokedImageUrls.push(url);
  revokeUrl(url);
};

function Fixture() {
  const [example, setExample] = useState<MarkdownExample>({ text: "Ready." });
  useEffect(() => {
    fixture.showMarkdown = setExample;
  }, []);
  const { zen, mountId, ...props } = example;
  return (
    <div className={zen ? "zen-fold-prose" : undefined}>
      <AgentMarkdown
        key={mountId}
        {...props}
        onOpenFile={(path, navigation) => {
          fixture.openedFiles.push({ path, navigation });
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);

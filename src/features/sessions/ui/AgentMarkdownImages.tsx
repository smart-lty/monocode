import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Nodes, Root } from "hast";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { readBinaryFile } from "../../../platform/tauri/fs";
import { joinPath, slash } from "../../../shared/lib/paths";
import { ImageLightbox } from "../../../shared/ui/ImageLightbox";
import { sniffImageMime } from "../../files/model/filePreview";
import { isInboxMediaUrl } from "../../inbox/model/inboxMedia";
import { InboxMedia } from "../../inbox/ui/InboxMedia";
import { isNoteImagePath } from "../../notes/noteImages";

type ImageProps = ComponentProps<"img"> & { node?: unknown };
type ImageSource =
  | { kind: "direct"; src: string }
  | { kind: "local"; path: string }
  | { kind: "note"; asset: string }
  | { kind: "inbox"; src: string }
  | { kind: "blocked"; reason: string };

/** Accept only ordinary image URLs or local paths, never arbitrary schemes. */
export function resolveMarkdownImageSource(
  src: string,
  { cwd, inboxOnly = false }: { cwd?: string; inboxOnly?: boolean } = {},
): ImageSource {
  const value = src.trim();
  if (/^data:image\//.test(value)) return { kind: "direct", src: value };
  if (isNoteImagePath(value)) return { kind: "note", asset: value };
  if (inboxOnly) {
    return isInboxMediaUrl(value)
      ? { kind: "inbox", src: value }
      : {
          kind: "blocked",
          reason: "This image source is not allowed in Inbox.",
        };
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname) return { kind: "direct", src: value };
    } catch {
      /* Show the same understandable failure as other invalid URLs. */
    }
    return { kind: "blocked", reason: "The image URL is invalid." };
  }
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    return { kind: "blocked", reason: "The image path is empty or invalid." };
  }
  // Check both the original and decoded form. Encoded protocols and UNC/network
  // paths must never reach the native reader as if they were local files.
  let path = value;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* Literal '%' is a valid filename. */
  }
  path = slash(path);
  if (/^[\\/]{2}/.test(path) || path.startsWith("#") || path.startsWith("?")) {
    return { kind: "blocked", reason: "This image path is not supported." };
  }
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) && !/^[A-Za-z]:\//.test(path)) {
    return { kind: "blocked", reason: "This image protocol is not supported." };
  }
  if (/^[A-Za-z]:\//.test(path) || path.startsWith("/")) {
    return { kind: "local", path };
  }
  if (!cwd || cwd === "~") {
    return {
      kind: "blocked",
      reason: "A session working directory is needed for this image.",
    };
  }
  return { kind: "local", path: joinPath(cwd, path) };
}

/** Resolve paths before URL hardening, which discards a relative URL's cwd. */
export function rehypeMarkdownImagePaths({ cwd }: { cwd?: string } = {}) {
  return (tree: Root) => {
    function visit(node: Nodes) {
      if (node.type === "element" && node.tagName === "img") {
        const src = node.properties.src;
        if (typeof src === "string") {
          const image = resolveMarkdownImageSource(src, { cwd });
          if (image.kind === "local") {
            const path = image.path.startsWith("/")
              ? image.path
              : `/${image.path}`;
            node.properties.src = path
              .split("/")
              .map(encodeURIComponent)
              .join("/");
          } else if (image.kind === "blocked") {
            const alt = String(node.properties.alt || "Image");
            node.tagName = "span";
            node.properties = {};
            node.children = [
              {
                type: "text",
                value: `${alt} — Could not load image. ${image.reason}`,
              },
            ];
          }
        }
      }
      if ("children" in node) node.children.forEach(visit);
    }
    visit(tree);
  };
}

export function MarkdownImage({
  src,
  alt,
  node: _node,
  srcSet: _srcSet,
  cwd,
  inboxOnly,
  ...props
}: ImageProps & { cwd?: string; inboxOnly?: boolean }) {
  const image = resolveMarkdownImageSource(typeof src === "string" ? src : "", {
    cwd,
    inboxOnly,
  });
  switch (image.kind) {
    case "blocked":
      return <ImageFailure alt={alt} reason={image.reason} />;
    case "inbox":
      return <InboxMedia src={image.src} alt={alt} />;
    case "note":
      return (
        <FileImage
          key={image.asset}
          {...props}
          path={image.asset}
          note
          alt={alt}
        />
      );
    case "local":
      return (
        <FileImage key={image.path} {...props} path={image.path} alt={alt} />
      );
    case "direct":
      return (
        <LoadedImage key={image.src} {...props} src={image.src} alt={alt} />
      );
  }
}

function ImageFailure({ alt, reason }: { alt?: string; reason: string }) {
  return (
    <span className="markdown-image-failure" role="status">
      <span>{alt?.trim() || "Image"}</span>
      <span> — Could not load image. {reason}</span>
    </span>
  );
}

function ImageLoading({ alt, asset }: { alt?: string; asset?: string }) {
  return (
    <span
      role="status"
      className="markdown-image-loading"
      data-note-image={asset}
    >
      Loading image: {alt?.trim() || "Image"}…
    </span>
  );
}

function LoadedImage({
  src,
  alt,
  className,
  onError,
  onClick,
  onKeyDown,
  ...props
}: Omit<ImageProps, "node"> & { src: string }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const label = alt?.trim() || "Image";
  if (failed)
    return (
      <ImageFailure
        alt={alt}
        reason="Check the image address and file access."
      />
    );
  return (
    <>
      <img
        {...props}
        src={src}
        alt={alt ?? ""}
        className={`markdown-image ${className ?? ""}`}
        title={props.title ?? `Open image preview: ${label}`}
        draggable={false}
        loading="lazy"
        tabIndex={0}
        onError={(event) => {
          setFailed(true);
          setOpen(false);
          onError?.(event);
        }}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (
            !event.defaultPrevented &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      {open ? (
        <ImageLightbox src={src} alt={label} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

type ImageState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; reason: string };

/** The file viewer reserves SVG for its editor; Markdown uses the image mode. */
export function sniffMarkdownImageMime(bytes: Uint8Array): string | null {
  const rasterMime = sniffImageMime(bytes);
  if (rasterMime) return rasterMime;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const document = new DOMParser().parseFromString(source, "image/svg+xml");
    const root = document.documentElement;
    if (
      root.localName === "svg" &&
      root.namespaceURI === "http://www.w3.org/2000/svg" &&
      document.getElementsByTagName("parsererror").length === 0
    )
      return "image/svg+xml";
  } catch {
    /* Invalid XML or non-text bytes are not an SVG image. */
  }
  return null;
}

const noteImageSrcCache = new Map<string, string>();

function FileImage({
  path,
  note = false,
  alt,
  ...props
}: Omit<ImageProps, "src" | "node"> & { path: string; note?: boolean }) {
  const cached = note ? noteImageSrcCache.get(path) : undefined;
  const [state, setState] = useState<ImageState>(
    cached ? { status: "ready", url: cached } : { status: "loading" },
  );
  const objectUrl = useRef<string | null>(null);
  const release = () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  };
  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    async function load() {
      let url: string;
      if (note) {
        url = convertFileSrc(
          await invoke<string>("notes_image_path", { asset: path }),
        );
        noteImageSrcCache.set(path, url);
      } else {
        const bytes = await readBinaryFile(path);
        if (cancelled) return;
        const mime = sniffMarkdownImageMime(bytes);
        if (!mime) {
          setState({
            status: "error",
            reason: "The file is not a supported image.",
          });
          return;
        }
        url = objectUrl.current = URL.createObjectURL(
          new Blob([bytes], { type: mime }),
        );
      }
      if (!cancelled) setState({ status: "ready", url });
    }
    void load().catch(() => {
      if (!cancelled)
        setState({
          status: "error",
          reason: note
            ? "The note image could not be read."
            : "The file could not be read. Check its path and access permissions.",
        });
    });
    return () => {
      cancelled = true;
      release();
    };
  }, [path, note, cached]);
  if (state.status === "loading")
    return <ImageLoading alt={alt} asset={note ? path : undefined} />;
  if (state.status === "error")
    return <ImageFailure alt={alt} reason={state.reason} />;
  return (
    <LoadedImage
      {...props}
      src={state.url}
      alt={alt}
      data-note-image={note ? path : undefined}
      onError={(event) => {
        release();
        props.onError?.(event);
      }}
    />
  );
}

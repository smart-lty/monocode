// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import type { SessionReference } from "../model/sessionReferences";
import { AgentTranscript } from "./AgentTranscript";
import { MessageQueue } from "./MessageQueue";

const reference: SessionReference = {
  sessionId: "source-1",
  title: "Fix IME Enter",
  cwd: "/work/synara",
  harness: "codex",
};

const view = (markup: string) => {
  const container = document.createElement("div");
  container.innerHTML = markup;
  return container;
};

describe("referenced sessions after sending", () => {
  it("shows the cards on a sent user message, even without text", () => {
    const blocks: Block[] = [
      {
        id: "u1",
        role: "user",
        text: "compare",
        sessionReferences: [reference],
      },
      { id: "u2", role: "user", text: "", sessionReferences: [reference] },
    ];
    const container = view(
      renderToStaticMarkup(createElement(AgentTranscript, { blocks })),
    );
    const cards = container.querySelectorAll(
      "[data-chat-message] [data-session-reference-chips] li",
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("Fix IME Enter");
    expect(cards[0]!.textContent).toContain("synara");
    // Sent cards cannot be removed.
    expect(
      container.querySelector('[aria-label^="Remove reference"]'),
    ).toBeNull();
  });

  it("keeps a saved draft's cards inside the dashed draft bubble", () => {
    const container = view(
      renderToStaticMarkup(
        createElement(AgentTranscript, {
          blocks: [
            {
              id: "d",
              role: "user",
              text: "later",
              draft: true,
              sessionReferences: [reference],
            },
          ],
        }),
      ),
    );
    const bubble = container.querySelector('[data-draft="true"]')!;
    expect(
      bubble.querySelector("[data-session-reference-chips]"),
    ).not.toBeNull();
    expect(bubble.textContent).toContain("Draft");
  });

  it("says a queued reference becomes readable only once sent", () => {
    const container = view(
      renderToStaticMarkup(
        createElement(MessageQueue, {
          messages: [
            {
              id: "q",
              text: "",
              attachments: [],
              sessionReferences: [reference],
            },
          ],
          onEdit: vi.fn(),
          onDelete: vi.fn(),
          variant: "messages",
        }),
      ),
    );
    expect(container.textContent).toContain("1 referenced session");
    expect(container.textContent).toContain(
      "readable after this message is sent",
    );
    expect(container.textContent).not.toContain("0 attachments");
  });
});

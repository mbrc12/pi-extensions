/**
 * Thinking Tail Extension
 *
 * Shows the final five non-empty lines of each thinking run in Pi's native
 * gray/italic thinking style. Ctrl+O expands the full thinking; Ctrl+O again
 * returns to the tail. The tail updates as thinking streams and is applied to
 * restored historical messages too.
 */

import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TAIL_LINES = 5;
const COLLAPSED_HINT = "(thinking collapsed, ctrl+o to expand)";

type ContentBlock = {
  type: string;
  thinking?: string;
  [key: string]: unknown;
};

type AssistantMessageLike = {
  content: ContentBlock[];
  [key: string]: unknown;
};

type ComponentLike = {
  lastMessage?: AssistantMessageLike;
};

// State is per rendered assistant-message component.
const expandedInstances = new WeakSet<object>();
const rawMessages = new WeakMap<object, AssistantMessageLike>();

function tailOf(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .slice(-TAIL_LINES)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  const proto = AssistantMessageComponent.prototype as Record<string, unknown>;
  const originalUpdateContent = proto.updateContent as (
    this: ComponentLike,
    message: AssistantMessageLike,
  ) => void;
  const hadOwnSetExpanded = Object.hasOwn(proto, "setExpanded");
  const originalSetExpanded = proto.setExpanded;

  /**
   * Feed Pi's normal renderer a view-only copy of the message. Thinking stays
   * type="thinking", preserving Pi's native gray italic styling; only its
   * visible text is folded while collapsed.
   */
  function updateContent(this: ComponentLike, message: AssistantMessageLike): void {
    // Keep the untouched message. The original renderer records the view copy
    // as lastMessage, so restore the raw one below for later Ctrl+O expansion.
    rawMessages.set(this, message);
    const expanded = expandedInstances.has(this);
    const content: ContentBlock[] = [];

    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i]!;
      if (block.type !== "thinking") {
        content.push(block);
        continue;
      }

      // Pi normally renders adjacent thinking chunks as one block. Fold the
      // whole run, rather than independently showing five lines per chunk.
      const run: ContentBlock[] = [];
      while (i < message.content.length && message.content[i]!.type === "thinking") {
        run.push(message.content[i]!);
        i++;
      }
      i--; // The outer loop advances past this run.

      if (expanded) {
        content.push(...run);
        continue;
      }

      const fullText = run
        .map((part) => part.thinking?.trim())
        .filter((part): part is string => Boolean(part))
        .join("\n\n");

      if (!fullText) {
        // Keep empty/signature-only blocks intact; Pi's normal renderer knows
        // how to handle them.
        content.push(...run);
        continue;
      }

      // One native thinking block: gray/italic hint followed by the tail.
      content.push({
        ...run[0]!,
        thinking: `${COLLAPSED_HINT}\n\n${tailOf(fullText)}`,
      });
    }

    originalUpdateContent.call(this, { ...message, content });

    // Critical: retain the raw message for invalidate(), theme changes, and
    // setExpanded(). Without this, Ctrl+O can only re-expand the tail itself.
    this.lastMessage = message;
  }

  proto.updateContent = updateContent;

  // Pi calls setExpanded() on transcript children when Ctrl+O toggles tool
  // output. Adding this method makes thinking messages participate too.
  proto.setExpanded = function (this: ComponentLike, expanded: boolean): void {
    if (expanded) {
      expandedInstances.add(this);
    } else {
      expandedInstances.delete(this);
    }

    const raw = rawMessages.get(this) ?? this.lastMessage;
    if (raw) updateContent.call(this, raw);
  };

  pi.on("session_start", (_event, ctx) => {
    // On reload, chat history is rebuilt just before session_start. Reapply
    // the current Ctrl+O state to every historical assistant component.
    const expanded = ctx.ui.getToolsExpanded();
    ctx.ui.setToolsExpanded(expanded);
  });

  pi.on("session_shutdown", () => {
    proto.updateContent = originalUpdateContent;
    if (hadOwnSetExpanded) {
      proto.setExpanded = originalSetExpanded;
    } else {
      delete proto.setExpanded;
    }
  });
}

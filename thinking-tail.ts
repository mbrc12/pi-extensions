/**
 * Thinking Tail Extension
 *
 * Shows the final five non-empty lines of each thinking run in Pi's native
 * gray/italic thinking style on a light-gray background. Ctrl+O expands the full thinking; Ctrl+O again
 * returns to the tail. The tail updates as thinking streams and is applied to
 * restored historical messages too.
 */

import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TAIL_LINES = 5;

// Footer status item shown while any thinking is present. 🤐 = collapsed,
// 😮 = expanded. The hint header that used to live inside the collapsed
// thinking block is gone; this status line now carries that signal.
const THINK_STATUS_KEY = "thinking";
const EMOJI_COLLAPSED = "\u{1F910}"; // 🤐 zipped mouth
const EMOJI_EXPANDED = "\u{1F62E}"; // 😮 face with open mouth

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
  contentContainer?: {
    children?: unknown[];
  };
};

type ThinkingMarkdownLike = {
  defaultTextStyle?: {
    italic?: boolean;
    color?: unknown;
    bgColor?: (text: string) => string;
  };
  invalidate?: () => void;
};

// A light gray that keeps the existing theme-controlled thinking text unchanged.
const LIGHT_GRAY_THINKING_BACKGROUND = "\x1b[48;2;224;224;224m";
const RESET_BACKGROUND = "\x1b[49m";

function lightGrayThinkingBackground(text: string): string {
  return `${LIGHT_GRAY_THINKING_BACKGROUND}${text}${RESET_BACKGROUND}`;
}

/** Add a full-width light-gray background to the native thinking Markdown. */
function applyThinkingBackground(component: ComponentLike): void {
  for (const child of component.contentContainer?.children ?? []) {
    const markdown = child as ThinkingMarkdownLike;
    const style = markdown.defaultTextStyle;
    // Native thinking Markdown is the only assistant child with both styles.
    if (!style?.italic || !style.color) continue;
    style.bgColor = lightGrayThinkingBackground;
    markdown.invalidate?.();
  }
}

// Minimal slice of ExtensionUIContext needed to push the footer status.
type StatusUI = {
  setStatus(key: string, text: string | undefined): void;
  getToolsExpanded(): boolean;
};

/** Return true if an assistant message content array has thinking text. */
function contentHasThinking(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "thinking" &&
      typeof (block as { thinking?: string }).thinking === "string" &&
      (block as { thinking?: string }).thinking!.trim()
    ) {
      return true;
    }
  }
  return false;
}

function messageHasThinking(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  return contentHasThinking((message as { content?: unknown }).content);
}

// State is per rendered assistant-message component.
const expandedInstances = new WeakSet<object>();
const rawMessages = new WeakMap<object, AssistantMessageLike>();

// Latest interactive UI context, captured on session_start so the
// prototype-level setExpanded() override (which has no ctx) can still push
// status updates. One extension instance serves all sessions in a process.
let uiRef: StatusUI | undefined;
// Whether the current session branch has any thinking content at all. The
// think status is only shown when there is something to collapse/expand.
let thinkingPresent = false;
// Most recently applied expand state, for use during streaming updates that
// do not pass through setExpanded().
let currentExpanded = false;

function statusText(expanded: boolean): string {
  return `think: ${expanded ? EMOJI_EXPANDED : EMOJI_COLLAPSED}`;
}

function syncThinkStatus(): void {
  if (!uiRef) return;
  uiRef.setStatus(
    THINK_STATUS_KEY,
    thinkingPresent ? statusText(currentExpanded) : undefined,
  );
}

function tailOf(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .slice(-TAIL_LINES)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  const proto = AssistantMessageComponent.prototype as unknown as Record<string, unknown>;
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
      } else {
        const fullText = run
          .map((part) => part.thinking?.trim())
          .filter((part): part is string => Boolean(part))
          .join("\n\n");

        if (!fullText) {
          // Keep empty/signature-only blocks intact; Pi's normal renderer knows
          // how to handle them.
          content.push(...run);
        } else {
          // One native thinking block showing just the tail fold. The collapse
          // signal now lives in the footer status item instead of an inline hint.
          content.push({
            ...run[0]!,
            thinking: tailOf(fullText),
          });
        }
      }

      // Leave one blank line before the next text or tool output. Do not add
      // it while thinking is still streaming by itself.
      if (i + 1 < message.content.length) {
        content.push({ type: "text", text: "\n" });
      }
    }

    originalUpdateContent.call(this, { ...message, content });
    applyThinkingBackground(this);

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

    // Ctrl+O toggles the global expansion state. Reflect it in the footer
    // think status. This override has no ctx, so use the captured uiRef.
    currentExpanded = expanded;
    syncThinkStatus();
  };

  pi.on("session_start", (_event, ctx) => {
    // Capture the interactive UI for the prototype-level toggle override and
    // for streaming-message handlers below.
    uiRef = ctx.ui;
    currentExpanded = ctx.ui.getToolsExpanded();

    // Reapply the current Ctrl+O state to every historical assistant
    // component; chat history was just rebuilt before session_start.
    ctx.ui.setToolsExpanded(currentExpanded);

    // Determine whether this session branch has any thinking content, then
    // show (or hide) the footer think status accordingly.
    thinkingPresent = false;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message") continue;
      if (messageHasThinking(entry.message)) {
        thinkingPresent = true;
        break;
      }
    }
    syncThinkStatus();
  });

  // As thinking streams in, flip thinkingPresent on so the collapsed status
  // appears from the first thinking run onward (before any Ctrl+O toggle).
  pi.on("message_update", (event) => {
    if (!messageHasThinking(event.message)) return;
    if (!thinkingPresent) {
      thinkingPresent = true;
      syncThinkStatus();
    }
  });

  pi.on("message_end", (event) => {
    if (!messageHasThinking(event.message)) return;
    if (!thinkingPresent) {
      thinkingPresent = true;
      syncThinkStatus();
    }
  });

  pi.on("session_shutdown", () => {
    proto.updateContent = originalUpdateContent;
    if (hadOwnSetExpanded) {
      proto.setExpanded = originalSetExpanded;
    } else {
      delete proto.setExpanded;
    }
    if (uiRef) uiRef.setStatus(THINK_STATUS_KEY, undefined);
    uiRef = undefined;
    thinkingPresent = false;
  });
}

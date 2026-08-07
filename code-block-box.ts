/**
 * Render assistant fenced code blocks in a single-line Unicode box-drawing
 * frame with a borderless language label set into the top border. This intentionally patches Pi's exported
 * AssistantMessageComponent: the public extension API currently only exposes
 * renderers for custom messages, not normal assistant messages.
 */

import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  type Component,
  type MarkdownTheme,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type AssistantContent = {
  type: string;
  text?: string;
  thinking?: string;
  [key: string]: unknown;
};

type AssistantMessage = {
  content: AssistantContent[];
  stopReason?: string;
  errorMessage?: string;
  [key: string]: unknown;
};

type AssistantComponent = {
  contentContainer: Container;
  hideThinkingBlock: boolean;
  markdownTheme: MarkdownTheme;
  hiddenThinkingLabel: string;
  outputPad: number;
  lastMessage?: AssistantMessage;
  hasToolCalls: boolean;
};

type TextSegment = { kind: "markdown"; text: string };
type CodeSegment = { kind: "code"; code: string; language: string };
type Segment = TextSegment | CodeSegment;

type PatchState = {
  original: (this: AssistantComponent, message: AssistantMessage) => void;
  wrapper: (this: AssistantComponent, message: AssistantMessage) => void;
  enabled: boolean;
};

const PATCH = Symbol.for("pi.code-block-box.patch");

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function languageName(info: string): string {
  const firstWord = info.trim().split(/\s+/)[0] ?? "";
  // Keep ordinary language aliases such as c++, c#, and shell-session, but
  // never let control characters or ANSI escapes into a terminal label.
  const safe = firstWord.replace(/[^A-Za-z0-9_+.#-]/g, "");
  return safe || "text";
}

function isClosingFence(line: string, marker: string): boolean {
  const character = escapeRegex(marker[0]!);
  return new RegExp(`^[ \t]*${character}{${marker.length},}[ \t]*$`).test(line);
}

function trimPartialClosingFence(lines: string[], marker: string): string[] {
  const last = lines.at(-1);
  if (!last || last.length >= marker.length) return lines;
  if (last === marker[0]!.repeat(last.length)) return lines.slice(0, -1);
  return lines;
}

/** Split only block-level fenced code. Other Markdown stays with Pi's renderer. */
function splitFencedCode(text: string): Segment[] {
  const lines = text.split(/\r?\n/);
  const segments: Segment[] = [];
  let markdown: string[] = [];

  const flushMarkdown = () => {
    const value = markdown.join("\n");
    if (value) segments.push({ kind: "markdown", text: value });
    markdown = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const opening = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
    if (!opening) {
      markdown.push(lines[i]!);
      continue;
    }

    flushMarkdown();
    const marker = opening[1]!;
    const code: string[] = [];
    let closed = false;
    i++;
    for (; i < lines.length; i++) {
      if (isClosingFence(lines[i]!, marker)) {
        closed = true;
        break;
      }
      code.push(lines[i]!);
    }

    // During streaming, avoid briefly rendering a partial closing delimiter as
    // code, matching Pi's native Markdown renderer behavior.
    const visibleCode = closed ? code : trimPartialClosingFence(code, marker);
    segments.push({
      kind: "code",
      code: visibleCode.join("\n"),
      language: languageName(opening[2]!),
    });

    if (!closed) break;
  }

  flushMarkdown();
  return segments;
}

class FencedCodeBox implements Component {
  constructor(
    private readonly code: string,
    private readonly language: string,
    private readonly paddingX: number,
    private readonly markdownTheme: MarkdownTheme,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const outerWidth = width - this.paddingX * 2;
    if (outerWidth < 4) {
      // A usable framed box is impossible in an exceptionally narrow terminal.
      // Still use Pi's ANSI-safe wrapping and never exceed the requested width.
      return wrapTextWithAnsi(this.code, Math.max(1, width));
    }

    const innerWidth = outerWidth - 2;
    // One top-border character precedes the borderless label; spaces form the
    // gap that separates it from the border on both sides.
    const maxLabelWidth = Math.max(0, innerWidth - 4);
    const label = this.language.slice(0, maxLabelWidth);
    const top = label
      ? `┌─ ${label} ${"─".repeat(innerWidth - label.length - 3)}┐`
      : `┌${"─".repeat(innerWidth)}┐`;
    const highlighted = this.markdownTheme.highlightCode
      ? this.markdownTheme.highlightCode(this.code.replace(/\t/g, "   "), this.language)
      : this.code.replace(/\t/g, "   ").split("\n").map((line) => this.markdownTheme.codeBlock(line));
    const lineNumberWidth = String(Math.max(1, highlighted.length)).length;
    // `│1│ code │` takes the line-number width plus five fixed columns.
    // On very narrow terminals, retain a correctly sized box without a gutter.
    const showLineNumbers = outerWidth >= lineNumberWidth + 6;
    const codeWidth = showLineNumbers
      ? outerWidth - lineNumberWidth - 5
      : Math.max(1, innerWidth - 2);
    // Continue the gutter's right-hand vertical rule into the bottom border.
    const bottom = showLineNumbers
      ? `└${"─".repeat(lineNumberWidth)}┴${"─".repeat(innerWidth - lineNumberWidth - 1)}┘`
      : `└${"─".repeat(innerWidth)}┘`;
    const border = this.markdownTheme.codeBlockBorder;
    const pad = " ".repeat(this.paddingX);

    const frameLine = (line: string) => {
      const padded = line + " ".repeat(Math.max(0, outerWidth - visibleWidth(line)));
      return pad + padded + pad;
    };

    const output = [frameLine(border(top))];
    for (let lineIndex = 0; lineIndex < highlighted.length; lineIndex++) {
      const highlightedLine = highlighted[lineIndex]!;
      // wrapTextWithAnsi also splits a single very long token, preserving ANSI
      // styles. Wrapped continuation rows keep an empty line-number gutter.
      const wrappedLines = wrapTextWithAnsi(highlightedLine, codeWidth);
      for (let wrappedIndex = 0; wrappedIndex < wrappedLines.length; wrappedIndex++) {
        const line = wrappedLines[wrappedIndex]!;
        const content = line + " ".repeat(Math.max(0, codeWidth - visibleWidth(line)));
        if (showLineNumbers) {
          const number = wrappedIndex === 0 ? String(lineIndex + 1).padStart(lineNumberWidth) : " ".repeat(lineNumberWidth);
          output.push(frameLine(border("│") + number + border("│ ") + content + border(" │")));
        } else {
          output.push(frameLine(border("│ ") + content + border(" │")));
        }
      }
    }
    output.push(frameLine(border(bottom)));
    return output;
  }
}

export default function (pi: ExtensionAPI) {
  const proto = AssistantMessageComponent.prototype as unknown as Record<PropertyKey, unknown>;
  // Keep the patch stable over /reload. This also lets thinking-tail (which
  // patches the same method) compose when this extension loads first.
  let state = proto[PATCH] as PatchState | undefined;
  if (!state) {
    const original = proto.updateContent as PatchState["original"];
    state = { original, wrapper: undefined as never, enabled: true };

    const wrapper = function (this: AssistantComponent, message: AssistantMessage): void {
      if (!state!.enabled) {
        state!.original.call(this, message);
        return;
      }

    this.lastMessage = message;
    this.contentContainer.clear();

    const hasVisibleContent = message.content.some(
      (content) =>
        (content.type === "text" && content.text?.trim()) ||
        (content.type === "thinking" && content.thinking?.trim()),
    );
    if (hasVisibleContent) this.contentContainer.addChild(new Spacer(1));

    for (let i = 0; i < message.content.length; i++) {
      const content = message.content[i]!;
      if (content.type === "text" && content.text?.trim()) {
        for (const segment of splitFencedCode(content.text.trim())) {
          if (segment.kind === "markdown") {
            this.contentContainer.addChild(new Markdown(segment.text, this.outputPad, 0, this.markdownTheme));
          } else {
            this.contentContainer.addChild(
              new FencedCodeBox(segment.code, segment.language, this.outputPad, this.markdownTheme),
            );
          }
        }
      } else if (content.type === "thinking") {
        const thinkingBlocks: string[] = [];
        for (; i < message.content.length && message.content[i]!.type === "thinking"; i++) {
          const thinking = message.content[i]!.thinking?.trim();
          if (thinking) thinkingBlocks.push(thinking);
        }
        i--;
        if (thinkingBlocks.length === 0) continue;

        if (this.hideThinkingBlock) {
          this.contentContainer.addChild(new Text(this.hiddenThinkingLabel, this.outputPad, 0));
        } else {
          // Thinking is deliberately left as native Markdown; normal assistant
          // text is where Pi presents fenced code blocks to the user.
          this.contentContainer.addChild(
            new Markdown(thinkingBlocks.join("\n\n"), this.outputPad, 0, this.markdownTheme, { italic: true }),
          );
        }
      }
    }

    const hasToolCalls = message.content.some((content) => content.type === "toolCall");
    this.hasToolCalls = hasToolCalls;
    if (message.stopReason === "length") {
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(
        new Text("Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.", this.outputPad, 0),
      );
    } else if (!hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error")) {
      const fallback = message.stopReason === "aborted" ? "Operation aborted" : "Unknown error";
      const error = message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : fallback;
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(new Text(error, this.outputPad, 0));
    }
    };

    state.wrapper = wrapper;
    proto.updateContent = wrapper;
    proto[PATCH] = state;
  }

  pi.registerCommand("code-block-box", {
    description: "Toggle framed assistant code blocks (on/off)",
    handler: async (args, ctx) => {
      const choice = args.trim().toLowerCase();
      if (choice === "on") state!.enabled = true;
      else if (choice === "off") state!.enabled = false;
      else {
        ctx.ui.notify(`Code-block boxes are ${state!.enabled ? "on" : "off"}. Use /code-block-box on|off.`, "info");
        return;
      }

      // Theme invalidation rebuilds every AssistantMessageComponent from its
      // source message, so the change applies to existing transcript rows too.
      ctx.ui.setTheme(ctx.ui.theme);
      ctx.ui.notify(`Code-block boxes ${state!.enabled ? "enabled" : "disabled"}.`, "info");
    },
  });
}

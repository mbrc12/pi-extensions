/**
 * Prompt Prefix Extension
 *
 * Adds a » prefix before the editor prompt to visually distinguish it.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
const PREFIX = "» ";

class PromptPrefixEditor extends CustomEditor {
  render(width: number): string[] {
    const prefixWidth = visibleWidth(PREFIX);
    const lines = super.render(width - prefixWidth);
    // lines layout: [0] = top border, [1..] = content lines, [last] = bottom border
    if (lines.length > 1) {
      // First content line gets the prefix
      lines[1] = PREFIX + lines[1]!;
      // Continuation lines are indented to align with the text after the prefix
      const indent = " ".repeat(prefixWidth);
      for (let i = 2; i < lines.length - 1; i++) {
        lines[i] = indent + lines[i]!;
      }
    }

    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent(
      (tui, theme, kb) => new PromptPrefixEditor(tui, theme, kb)
    );
  });
}

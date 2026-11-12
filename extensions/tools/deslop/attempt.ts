/**
 * One attempt at one section, driven by an injected completer.
 *
 * Taking the model call as a parameter is what makes the retry testable: a fake
 * completer can return a bad answer once and prove that the second request names
 * the criterion that was broken.
 */

import { guardRewrite } from "./guard.ts";
import { type Attempt } from "./retry.ts";
import type { Section } from "./sections.ts";
import { countWords } from "./text.ts";

export type Complete = (request: { systemPrompt: string; messages: unknown[] }, options: Record<string, unknown>) => Promise<string>;

/** Models wrap output in a fence or prefix it with an announcement even when told not to. */
export function cleanOutput(text: string, hadFence: boolean): string {
	let out = text.trim();
	const fenced = out.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
	if (fenced && fenced[1].trim()) out = fenced[1];
	else if (!hadFence) {
		out = out.replace(/^(?:here(?:'s| is) the (?:rewritten|edited|revised)[^\n]*\n+)/i, "");
	}
	return out.trimEnd();
}

export async function attemptSection(
	complete: Complete,
	section: Section,
	systemPrompt: string,
	feedback = "",
): Promise<Attempt> {
	const budget = `This section has ${section.words} words. Return between ${Math.round(section.words * 0.9)} and ${Math.round(section.words * 1.1)} words.`;
	const instructions = [budget, feedback].filter(Boolean).join("\n\n");

	try {
		const text = await complete(
			{
				systemPrompt,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: [instructions, "", "<text>", section.masked, "</text>"].join("\n") }],
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: Math.min(4096, Math.max(700, section.words * 6)), cacheRetention: "short" },
		);

		if (!text.trim()) return { status: "invalid", text: section.raw, reason: "empty" };

		const cleaned = cleanOutput(text, section.raw.includes("```"));
		const guard = guardRewrite(section.raw, cleaned, section.spans);

		if (guard.ok && guard.restored.trim() !== section.raw.trim()) {
			return { status: "accepted", text: guard.restored, note: guard.warnings[0] };
		}
		if (guard.ok) return { status: "unchanged", text: section.raw, reason: "unchanged" };

		const reason = guard.reason ?? "";
		if (reason.includes("placeholder")) return { status: "invalid", text: section.raw, reason: "placeholder", detail: reason };
		if (reason.startsWith("invented")) return { status: "invalid", text: section.raw, reason: "invented_number", detail: reason.replace("invented ", "") };
		if (reason.includes("length")) {
			const ratio = Math.round((countWords(cleaned) / Math.max(1, section.words)) * 100);
			return { status: "invalid", text: section.raw, reason: "length", detail: `${ratio}%` };
		}
		if (reason.startsWith("dropped")) return { status: "invalid", text: section.raw, reason: "dropped_fact", detail: reason.replace("dropped ", "") };
		return { status: "invalid", text: section.raw, reason: "api", detail: reason };
	} catch (error) {
		return { status: "invalid", text: section.raw, reason: "api", detail: error instanceof Error ? error.message : String(error) };
	}
}


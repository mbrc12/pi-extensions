/**
 * Global rules: the concerns a sentence-level rule cannot see.
 *
 * These are Higher Order Concerns in writing-centre terms: promise, order,
 * proportion, redundancy. The audit answers them from the spine, and every
 * answer is validated against a fixed schema before anything acts on it.
 *
 * Kept free of model imports so the rules and the validator can be tested alone.
 */

import type { Spine } from "./spine.ts";
import type { StructuralOp } from "./spine.ts";

export interface GlobalRule {
	id: string;
	label: string;
	question: string;
	action: string;
}

/**
 * Twelve document-level rules, from higher-order-concern revision practice,
 * reverse outlining, Gopen & Swan's topic and stress positions, and the two gaps
 * CLEAR-100 names in its own checker (a thesis restated everywhere, a headline
 * number that is never derived).
 */
export const GLOBAL_RULES: GlobalRule[] = [
	{ id: "promise_fulfilment", label: "promise not kept", question: "Does the opening promise something with no section behind it, or does a section serve no promise?", action: "add the section, or drop the promise" },
	{ id: "answer_first", label: "conclusion buried", question: "Is the answer to the reader's question anywhere but the first paragraph?", action: "move the conclusion to the opening" },
	{ id: "thesis_drift", label: "thesis drift", question: "Does the document argue something other than what its opening claims?", action: "restate the opening to match the argument" },
	{ id: "use_before_definition", label: "defined after use", question: "Is a term, identifier, or command used before it is explained?", action: "move the definition earlier" },
	{ id: "given_new_flow", label: "section opens on the new idea", question: "Does a section start with material the reader has not met, instead of linking back?", action: "rewrite the section's first sentence" },
	{ id: "redundancy", label: "same claim twice", question: "Are two sections making the same point in different words?", action: "merge them, keep the stronger one" },
	{ id: "underived_number", label: "number before its derivation", question: "Does a headline number appear before the evidence that produces it?", action: "move the derivation first" },
	{ id: "proportion", label: "section out of proportion", question: "Is a section far longer or shorter than its importance in the argument warrants?", action: "split, expand, or trim" },
	{ id: "heading_accuracy", label: "heading does not match content", question: "Does a heading describe what the section actually does?", action: "rename the heading or move the content" },
	{ id: "dependency_order", label: "ordered by the author's work, not the reader's need", question: "Would the reader be better served by a different section order?", action: "reorder sections" },
	{ id: "one_sentence", label: "no single-sentence thesis", question: "Can the document be stated in one sentence? If not, does it have a point?", action: "supply a thesis in the opening" },
	{ id: "stated_limits", label: "limits implied, not stated", question: "Does the document say what it does not cover?", action: "state the scope in one line" },
];

export type FindingAction = "none" | "reorder" | "merge" | "delete" | "rewrite_opening" | "rename_heading" | "split" | "expand";

export interface Finding {
	rule: string;
	severity: 1 | 2 | 3;
	sections: string[];
	evidence: string;
	action: FindingAction;
}

export interface AuditResult {
	findings: Finding[];
	ops: StructuralOp[];
	/** Findings the rewriter must handle in prose, since they cannot be applied mechanically. */
	instructions: string[];
	summary: string;
	raw?: string;
}

/** Rules worth asking about, given the shape of this document. */
export function rulesFor(spine: Spine): GlobalRule[] {
	const sections = spine.sections.length;
	const words = spine.words;
	return GLOBAL_RULES.filter((rule) => {
		if (sections < 2 && ["proportion", "dependency_order", "redundancy", "heading_accuracy", "promise_fulfilment"].includes(rule.id)) return false;
		if (!spine.promises.length && rule.id === "promise_fulfilment") return false;
		if (words < 250 && ["stated_limits", "underived_number"].includes(rule.id)) return false;
		if (!spine.sections.some((section) => section.numbers.length) && rule.id === "underived_number") return false;
		return true;
	});
}

export function extractJson(text: string): any | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fenced ? fenced[1] : text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		return JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return undefined;
	}
}

const ACTIONS = new Set<FindingAction>(["none", "reorder", "merge", "delete", "rewrite_opening", "rename_heading", "split", "expand"]);

/** Validate the model's answer against the spine; drop anything that does not check out. */
export function validateAudit(raw: string, spine: Spine, allowed: GlobalRule[]): AuditResult {
	const parsed = extractJson(raw);
	const empty: AuditResult = { findings: [], ops: [], instructions: [], raw };
	if (!parsed || typeof parsed !== "object") return empty;

	const ids = new Set(spine.sections.map((section) => section.id));
	const known = new Set(allowed.map((rule) => rule.id));
	const findings: Finding[] = [];
	const ops: StructuralOp[] = [];
	const instructions: string[] = [];

	for (const item of Array.isArray(parsed.findings) ? parsed.findings.slice(0, 6) : []) {
		if (!item || typeof item !== "object") continue;
		if (!known.has(String(item.rule))) continue;
		const sections = (Array.isArray(item.sections) ? item.sections : []).filter((id: unknown) => ids.has(String(id))).map(String);
		const severity = Number(item.severity);
		if (![1, 2, 3].includes(severity)) continue;
		const action: FindingAction = ACTIONS.has(item.action) ? item.action : "none";
		const evidence = typeof item.evidence === "string" ? item.evidence.slice(0, 240) : "";
		findings.push({ rule: String(item.rule), severity: severity as 1 | 2 | 3, sections, evidence, action });

		if (action === "merge" && sections.length >= 2) {
			ops.push({ kind: "merge", from: sections[1], into: sections[0] });
		} else if (action === "delete" && sections.length >= 1) {
			ops.push({ kind: "delete", id: sections[0], supersededBy: sections[1] ?? parsed.target });
		} else if (["rewrite_opening", "rename_heading", "split", "expand"].includes(action)) {
			const rule = allowed.find((entry) => entry.id === item.rule);
			if (rule) instructions.push(`${rule.label}: ${evidence || rule.question} (${rule.action})`);
		}
	}

	if (Array.isArray(parsed.order) && parsed.order.length === spine.sections.length) {
		const order = parsed.order.map(String);
		// "Keep this order" is not an operation. Only record a real change.
		if (order.join(" ") !== spine.sections.map((section) => section.id).join(" ")) {
			ops.push({ kind: "reorder", order });
		}
	}

	return {
		findings,
		ops,
		instructions: instructions.slice(0, 4),
		summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 200) : "",
		raw,
	};
}

export function auditLine(result: AuditResult): string {
	if (!result.findings.length) return "document: no global findings";
	const worst = Math.max(...result.findings.map((finding) => finding.severity));
	const labels = result.findings.map((finding) => GLOBAL_RULES.find((rule) => rule.id === finding.rule)?.label ?? finding.rule);
	return `document: ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} (worst ${worst}/3) · ${labels.join(", ")}`;
}

/**
 * Rule pack: the single source of truth for both the scorer and the rewrite prompt.
 *
 * A rule either matches a pattern, or measures a metric against a budget. The
 * scorer consumes `pattern`/`metric`; the rewriter receives `fix`. Keep both in
 * one object so the two can never drift apart.
 */

export type Axis = "plain" | "human" | "structured" | "dense";

export type MetricName =
	| "meanSentence"
	| "longSentenceShare"
	| "gradeLevel"
	| "nominalizationShare"
	| "passivePer100"
	| "boldPer100"
	| "paraMax"
	| "paraMean"
	| "sectionMaxWords"
	| "bulletShortfall"
	| "sentenceLengthCV"
	| "openerRepeatShare"
	| "duplicatePhraseCount"
	| "headingEchoShare"
	| "hedgePer100"
	| "abstractOpenerShare";

export interface PatternRule {
	id: string;
	axis: Axis;
	kind: "pattern";
	/** Source and flags are stored separately so matching never leaks lastIndex. */
	source: string;
	flags: string;
	/**
	 * Tells per 100 words that saturate this rule. One strong tell in a short
	 * text reads as dense; the same tell spread across a long document does not.
	 */
	density: number;
	/** Extra weight when ranking rules for the prompt. */
	weight: number;
	label: string;
	fix: string;
	/** Collect the matched words so the prompt can name them. */
	terms?: boolean;
}

export interface MetricRule {
	id: string;
	axis: Axis;
	kind: "metric";
	metric: MetricName;
	/** A value at or better than `good` scores 0; at or worse than `bad` scores 1. */
	good: number;
	bad: number;
	weight: number;
	label: string;
	fix: string;
	/** Read limits from the profile instead of `good`/`bad`. */
	profileKey?: "maxSentence" | "maxGrade" | "maxParaSentences" | "minBulletShare";
}

export type Rule = PatternRule | MetricRule;

export const AXIS_WEIGHT: Record<Axis, number> = {
	plain: 0.3,
	human: 0.3,
	structured: 0.25,
	dense: 0.15,
};

export interface Profile {
	name: string;
	maxSentence: number;
	maxGrade: number;
	maxParaSentences: number;
	minBulletShare: number;
}

export const PROFILES: Record<string, Profile> = {
	general: { name: "general", maxSentence: 25, maxGrade: 9, maxParaSentences: 4, minBulletShare: 0 },
	technical: { name: "technical", maxSentence: 28, maxGrade: 11, maxParaSentences: 5, minBulletShare: 0 },
	social: { name: "social", maxSentence: 20, maxGrade: 8, maxParaSentences: 2, minBulletShare: 0 },
	agent: { name: "agent", maxSentence: 20, maxGrade: 9, maxParaSentences: 6, minBulletShare: 0 },
	docs: { name: "docs", maxSentence: 25, maxGrade: 10, maxParaSentences: 5, minBulletShare: 0.15 },
};

export function resolveProfile(name: string | Profile | undefined): Profile {
	if (name && typeof name === "object") return name;
	return PROFILES[name ?? "general"] ?? PROFILES.general;
}

const pattern = (
	id: string,
	axis: Axis,
	source: string,
	flags: string,
	density: number,
	weight: number,
	label: string,
	fix: string,
	terms = false,
): PatternRule => ({ id, axis, kind: "pattern", source, flags, density, weight, label, fix, terms });

/**
 * Concrete substitutions. Naming the replacement in the prompt beats describing
 * the problem: "holistic -> whole" gets followed, "use plain words" does not.
 */
export const REPLACEMENTS: Record<string, string> = {
	delve: "look at", delves: "covers", delving: "looking at", "testament to": "shows",
	"landscape of": "field", "realm of": "area", tapestry: "picture", showcase: "show",
	showcases: "shows", showcased: "showed", underscore: "stress", underscores: "stresses",
	pivotal: "key", crucial: "key", robust: "strong", seamless: "smooth", seamlessly: "smoothly",
	comprehensive: "full", holistic: "whole", leverage: "use", leverages: "uses", leverage_: "use",
	utilize: "use", utilizes: "uses", utilized: "used", utilizing: "using", utilise: "use",
	utilises: "uses", utilised: "used", paradigm: "model", foster: "encourage", fosters: "encourages",
	garner: "get", garnered: "got", myriad: "many", plethora: "many", embark: "start",
	embarks: "starts", embarking: "starting", embarked: "started", elevate: "raise", elevates: "raises",
	unpack: "explain", unpacks: "explains", supercharge: "speed up", unlock: "get", unlocks: "gets",
	revolutionary: "new", "cutting-edge": "current", "state-of-the-art": "current",
	"best-in-class": "best", "world-class": "top", effortless: "easy", effortlessly: "easily",
	powerful: "capable", delightful: "good", magical: "good", aforementioned: "this",
	"it is worth noting": "cut it", "it is important to": "cut it", "in order to": "to",
	"due to the fact that": "because", notably: "cut it", importantly: "cut it", interestingly: "cut it",
};

export function replaceHint(term: string): string | undefined {
	return REPLACEMENTS[term.toLowerCase()];
}

const metric = (
	id: string,
	axis: Axis,
	metricName: MetricName,
	good: number,
	bad: number,
	weight: number,
	label: string,
	fix: string,
	profileKey?: MetricRule["profileKey"],
): MetricRule => ({
	id,
	axis,
	kind: "metric",
	metric: metricName,
	good,
	bad,
	weight,
	label,
	fix,
	profileKey,
});

/**
 * Rules ordered strongest first. The first five rewrite on sight, matching the
 * order of the strongest documented tells.
 */
export const RULES: Rule[] = [
	// ---- Human: the five strongest tells -------------------------------------
	pattern(
		"not_x_but_y",
		"human",
		"\\b(?:it'?s|that'?s|this is|it is|this isn'?t|it isn'?t)\\s+(?:not|n't)\\s+(?:just|only|merely|about)\\b[^.;!?\\n]{0,90}?(?:[;,]\\s*(?:it'?s|it is|they'?re|but)\\b)",
		"i",
		0.4,
		10,
		"not X, but Y",
		"State the claim once, directly. Delete the negation you are correcting and keep only the real assertion.",
	),
	pattern(
		"one_line_closer",
		"human",
		"(?:^|[.!?]\\s+|\\n\\s*)(?:let that sink in|full stop|period\\.|that'?s it\\.|end of story|read that again|i'?ll say it again)\\b",
		"i",
		0.4,
		10,
		"one-line closer",
		"Delete the closer. The paragraph before it already made the point.",
		true,
	),
	pattern(
		"deep_saying",
		"human",
		"\\b(?:at its core|at the end of the day|when you think about it|at the heart of it|the real (?:magic|power|work) (?:happens|is)|what really matters is|the beauty of)\\b",
		"i",
		0.45,
		9,
		"deep-sounding saying",
		"Replace the saying with the specific claim it is standing in for, or delete it.",
		true,
	),
	pattern(
		"staged_runup",
		"human",
		"\\b(?:here'?s the thing|the thing is|honestly\\b|let'?s be (?:clear|honest)|to be (?:clear|honest)|the truth is|spoiler[: ]|plot twist)\\b",
		"i",
		0.45,
		9,
		"staged run-up",
		"Cut the run-up. Start with the sentence that follows it.",
		true,
	),
	pattern(
		"arguing_with_no_one",
		"human",
		"\\b(?:i'?m not saying|that'?s not to say|don'?t get me wrong|this isn'?t (?:about|to say)|it'?s not that)\\b",
		"i",
		0.5,
		8,
		"arguing with no one",
		"Delete the imaginary objection and keep the claim.",
		true,
	),

	// ---- Human: inflation and borrowed authority -----------------------------
	pattern(
		"ai_vocabulary",
		"human",
		"\\b(?:delve[sd]?|delving|testament to|landscape of|realm of|tapestry|showcase[sd]?|underscore[sd]?|pivotal|crucial|robust|seamless(?:ly)?|comprehensive|holistic|leverage[sd]?|utiliz(?:e|es|ed|ing)|utilis(?:e|es|ed|ing)|paradigm|foster(?:s|ed|ing)?|garner(?:s|ed)?|myriad|plethora|embark(?:s|ed|ing)?|elevate[sd]?|unpack(?:s|ed|ing)?)\\b",
		"i",
		1.2,
		9,
		"AI vocabulary",
		"Use the plain word. Say what the thing does.",
		true,
	),
	pattern(
		"inflated_significance",
		"human",
		"\\b(?:plays? a (?:crucial|vital|key|pivotal|central) role|stands? as a testament|marks? a (?:significant|pivotal|major) (?:shift|moment|milestone)|serves? as a reminder|underscores? the (?:importance|need)|is a game[- ]?changer)\\b",
		"i",
		0.6,
		8,
		"inflated significance",
		"State the concrete effect instead: what changed, for whom, by how much.",
	),
	pattern(
		"borrowed_authority",
		"human",
		"\\b(?:experts (?:say|believe|agree)|studies (?:show|suggest|indicate)|research (?:shows|suggests)|it is (?:widely|generally) (?:known|accepted|believed)|many (?:believe|argue|experts))\\b",
		"i",
		0.7,
		7,
		"borrowed authority",
		"Name the source, or cut the appeal to unnamed authority and state what you actually know.",
	),
	pattern(
		"sales_talk",
		"human",
		"\\b(?:supercharg(?:e|es|ed|ing)|unlock(?:s|ed|ing)?|revolutionary|cutting[- ]edge|state[- ]of[- ]the[- ]art|best[- ]in[- ]class|world[- ]class|effortless(?:ly)?|powerful|delightful|magical)\\b",
		"i",
		1.0,
		5,
		"sales language",
		"Replace the adjective with the property that earns it, or delete it.",
		true,
	),
	pattern(
		"chat_residue",
		"human",
		"\\b(?:great question|good question|i hope this helps|hope this helps|let me know if you|feel free to reach out|as an ai\\b|i cannot browse|i don'?t have access to real[- ]?time)\\b",
		"i",
		0.5,
		7,
		"chatbot residue",
		"Delete the conversational wrapper. The text should read as a document, not a reply.",
	),
	pattern(
		"knowledge_disclaimer",
		"human",
		"\\b(?:as of my (?:last )?(?:knowledge|training)|up to my (?:training|knowledge) cutoff|cannot provide (?:real[- ]?time|up[- ]?to[- ]?date))\\b",
		"i",
		0.6,
		6,
		"knowledge-limit disclaimer",
		"Cut the disclaimer or replace it with the date and scope of what the text actually covers.",
	),
	pattern(
		"meta_document",
		"human",
		"\\b(?:in this (?:article|post|section|guide|page),? (?:we|i)(?:'ll| will)|this (?:article|post|section|guide) (?:will )?(?:cover|explain|explore|walk)|we'?ll (?:look at|explore|cover) (?:how|what|why))\\b",
		"i",
		0.7,
		6,
		"writing about the document",
		"Delete the announcement and start with the content. The heading already says what this is.",
	),
	pattern(
		"shallow_ing",
		"human",
		",\\s+(?:highlighting|underscoring|emphasi[sz]ing|reflecting|showcasing|demonstrating|illustrating|revealing|ensuring|allowing for)\\b",
		"i",
		0.8,
		6,
		"shallow -ing phrase",
		"Turn the -ing phrase into a plain statement of fact, or delete it.",
	),

	// ---- Plain: length and word choice --------------------------------------
	metric(
		"mean_sentence",
		"plain",
		"meanSentence",
		18,
		32,
		8,
		"long average sentence",
		"Split long sentences. Aim for 15–25 words and one idea per sentence.",
		"maxSentence",
	),
	metric(
		"long_sentence_share",
		"plain",
		"longSentenceShare",
		0.05,
		0.3,
		7,
		"many sentences over 35 words",
		"Break every sentence over 35 words into two. Put the condition before the command.",
	),
	metric("grade_level", "plain", "gradeLevel", 8, 14, 7, "high reading grade", "Replace long words and clause stacks with plain words. Target the reading grade in the profile.", "maxGrade"),
	metric(
		"nominalization",
		"plain",
		"nominalizationShare",
		0.04,
		0.12,
		5,
		"noun-heavy style",
		"Turn nouns back into verbs: 'the implementation of' becomes 'we implemented'.",
	),
	metric("passive_voice", "plain", "passivePer100", 0.5, 4, 4, "passive voice", "Name the actor and make it the subject. Keep the passive only when the actor is unknown."),
	pattern(
		"stacked_hedges",
		"plain",
		"\\b(?:may|might|could|would)\\s+(?:potentially|possibly|perhaps|conceivably)\\b|\\b(?:it (?:is|seems) (?:possible|likely) that)\\b",
		"i",
		0.8,
		5,
		"stacked hedge",
		"Keep one hedge or none. Say what is known and what was not tested.",
	),
	pattern(
		"filler_openers",
		"plain",
		"(?:^|[.!?]\\s+|\\n\\s*)(?:it is worth noting|it'?s worth noting|it is important to|it'?s important to|notably,|importantly,|interestingly,|in today'?s|in order to|due to the fact that)\\b",
		"i",
		1.0,
		4,
		"filler opener",
		"Delete the filler and keep the sentence. 'in order to' becomes 'to'.",
		true,
	),

	// ---- Structured ---------------------------------------------------------
	metric("paragraph_length", "structured", "paraMax", 5, 9, 6, "overlong paragraph", "Split paragraphs past the profile limit. One idea per paragraph.", "maxParaSentences"),
	metric("paragraph_mean", "structured", "paraMean", 3, 6, 3, "even, dense paragraphs", "Vary paragraph length. Put the point in a paragraph of its own."),
	metric("section_length", "structured", "sectionMaxWords", 500, 1100, 4, "overlong section", "Split the section or promote part of it to a subheading."),
	metric("bullet_shortfall", "structured", "bulletShortfall", 0, 1, 5, "prose where a list belongs", "Convert parallel items into bullets. Documents prefer lists; prose connects them.", "minBulletShare"),
	metric(
		"heading_echo",
		"structured",
		"headingEchoShare",
		0.05,
		0.5,
		5,
		"heading repeated in the first sentence",
		"Delete the sentence that restates the heading. Start with the content.",
	),
	pattern(
		"listicle_stem",
		"structured",
		"\\b(?:here are (?:the|some|a few|\\d+)|let'?s (?:break|dive) (?:it )?down|first,? let'?s|second,? let'?s|third,? let'?s|finally,? let'?s|let'?s get started)\\b",
		"i",
		0.7,
		6,
		"listicle stem",
		"Delete the stem and start the list.",
	),
	pattern("emoji_decoration", "structured", "[\\u{1F300}-\\u{1FAFF}\\u{2700}-\\u{27BF}]", "u", 2.0, 3, "emoji decoration", "Delete the emoji. Keep text for readers."),
	pattern(
		"bold_decoration",
		"structured",
		"\\*\\*[^*\\n]{1,40}\\*\\*(?![\\s]*[:.])",
		"",
		3.0,
		3,
		"bold used as decoration",
		"Keep bold for the one claim, number, or warning that matters. Remove the rest.",
	),

	// ---- Dense --------------------------------------------------------------
	metric(
		"sentence_rhythm",
		"dense",
		"sentenceLengthCV",
		0.55,
		0.25,
		6,
		"metronome rhythm",
		"Vary sentence length. Put a short sentence next to a long one.",
	),
	metric("repeated_openers", "dense", "openerRepeatShare", 0.15, 0.4, 5, "repeated sentence openers", "Change the opening structure. Do not start consecutive sentences the same way."),
	metric("repeated_phrases", "dense", "duplicatePhraseCount", 0, 6, 5, "phrases repeated across sections", "Say each thing once. Delete the restatement."),
	metric("hedge_density", "dense", "hedgePer100", 0.5, 3, 4, "hedge density", "Cut empty hedging. Keep the uncertainty that is real."),
	metric("abstract_openers", "dense", "abstractOpenerShare", 0.15, 0.45, 4, "sentences that start with nothing", "Start sentences with the actor or the fact, not 'It is' or 'There is'."),
];

const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "but", "of", "to", "in", "for", "on", "with", "as", "at", "by", "from",
	"is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these", "those", "we", "you",
	"i", "they", "he", "she", "not", "no", "do", "does", "did", "can", "will", "would", "should", "if",
	"then", "than", "so", "up", "out", "into", "about", "your", "our", "their", "how", "what", "why", "when",
]);

export function contentWords(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.match(/[a-z][a-z'-]{2,}/g)
		?.filter((word) => !STOPWORDS.has(word)) ?? [];
}

/** Concurrency and retry guidance. No model imports, so both can be tested alone. */

/** One model attempt at one section, with the failure named rather than swallowed. */
export interface Attempt {
	status: "accepted" | "unchanged" | "invalid";
	text: string;
	reason?: "placeholder" | "dropped_fact" | "invented_number" | "length" | "empty" | "unchanged" | "api";
	detail?: string;
	note?: string;
}

/**
 * The retry tells the model which criterion it broke, in words it can act on.
 * "Your reply was invalid" teaches nothing and burns the attempt.
 */
export function repairMessage(attempt: Attempt): string {
	switch (attempt.reason) {
		case "placeholder":
			return "Your previous reply lost or duplicated a [[n]] token. Copy every [[n]] token exactly as it appears in the input, once each, and leave it where it is.";
		case "dropped_fact":
			return `Your previous reply dropped ${attempt.detail ?? "a fact"}. Keep every number, name, link, and path from the original, unchanged.`;
		case "invented_number":
			return `Your previous reply added ${attempt.detail ?? "a number"}, which is not in the original. Never add a number or a claim.`;
		case "length":
			return `Your previous reply was ${attempt.detail ?? "the wrong length"} of the original. Rewrite again and keep between 90% and 110% of the words: do not condense, merge, or drop sentences.`;
		case "empty":
			return "Your previous reply was empty. Return the rewritten section only, with no commentary.";
		case "unchanged":
			return "Your previous reply was identical to the original. Apply the findings listed above and change the sentences they name.";
		default:
			return "Your previous reply could not be used. Return only the rewritten section, keeping every [[n]] token, every number, and every name.";
	}
}

/** Run tasks in parallel with a ceiling. Order of results matches the order of items. */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}

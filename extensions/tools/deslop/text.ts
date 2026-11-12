/** Small text helpers shared by the scorer, guard, and chunker. */

export function words(text: string): string[] {
	return text.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? [];
}

export function countWords(text: string): number {
	return words(text).length;
}

export function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])[ \t]+|\n+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => words(sentence).length > 0);
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

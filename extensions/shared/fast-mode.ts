export const OPENAI_FAST_MODE_ENV = "PI_OPENAI_FAST_MODE";

export function isOpenAICodexProvider(provider: string): boolean {
	return /^openai-codex(?:-\d+)?$/.test(provider);
}

export function isOpenAICodexModel(model: string | undefined): boolean {
	if (!model) return false;
	const separator = model.indexOf("/");
	if (separator <= 0) return false;
	return isOpenAICodexProvider(model.slice(0, separator));
}

export function subagentEnvironment(
	model: string | undefined,
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env = { ...source };
	if (source[OPENAI_FAST_MODE_ENV] !== "1" || !isOpenAICodexModel(model)) {
		delete env[OPENAI_FAST_MODE_ENV];
	}
	return env;
}

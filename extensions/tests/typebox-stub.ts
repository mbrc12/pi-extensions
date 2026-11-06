/**
 * Shared typebox stub for tests.
 *
 * bun's `mock.module` is process-wide, so a file that stubs only the builders it
 * needs hides `Type.Array` and friends from every module loaded afterwards.
 * These tests never validate schemas, so an identity stub for the builder
 * functions plus the real module for everything else keeps later files working.
 */
import { createRequire } from "node:module";

const piDir = process.env.PI_CODING_AGENT_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const requireFromPi = createRequire(`${piDir}/package.json`);
const real = await import(requireFromPi.resolve("typebox"));

const identity = (value: unknown) => value;

export const typeboxStub = {
	...real,
	Type: {
		...real.Type,
		Any: identity,
		Array: identity,
		Boolean: identity,
		Integer: identity,
		Literal: identity,
		Number: identity,
		Object: identity,
		Optional: identity,
		Record: identity,
		String: identity,
		Union: identity,
	},
};

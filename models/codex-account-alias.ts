import {
	getModels,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex-2";
const PROVIDER_NAME = "OpenAI Codex 2";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

async function readTokenResponse(response: Response, operation: string): Promise<OAuthCredentials> {
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`OpenAI Codex token ${operation} failed (${response.status}): ${detail || response.statusText}`);
	}

	const token = await response.json() as Partial<TokenResponse>;
	if (!token.access_token || !token.refresh_token || typeof token.expires_in !== "number") {
		throw new Error(`OpenAI Codex token ${operation} response is missing required fields`);
	}

	return {
		access: token.access_token,
		refresh: token.refresh_token,
		expires: Date.now() + token.expires_in * 1000,
	};
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new Error("Login cancelled"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Login cancelled"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function exchangeDeviceCode(
	authorizationCode: string,
	verifier: string,
	signal: AbortSignal,
): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: authorizationCode,
			code_verifier: verifier,
			redirect_uri: DEVICE_REDIRECT_URI,
		}),
		signal,
	});
	return readTokenResponse(response, "exchange");
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const timeoutController = new AbortController();
	const timeout = setTimeout(
		() => timeoutController.abort(new Error("OpenAI Codex device login timed out")),
		DEVICE_CODE_TIMEOUT_MS,
	);
	const signal = callbacks.signal
		? AbortSignal.any([callbacks.signal, timeoutController.signal])
		: timeoutController.signal;

	try {
		const startResponse = await fetch(DEVICE_USER_CODE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: CLIENT_ID }),
			signal,
		});
		if (!startResponse.ok) {
			throw new Error(`OpenAI Codex device login failed (${startResponse.status})`);
		}

		const device = await startResponse.json() as {
			device_auth_id?: string;
			user_code?: string;
			interval?: number | string;
		};
		const intervalSeconds = Number(device.interval);
		if (
			!device.device_auth_id ||
			!device.user_code ||
			!Number.isFinite(intervalSeconds) ||
			intervalSeconds < 0
		) {
			throw new Error("OpenAI Codex device login returned an invalid response");
		}

		callbacks.onDeviceCode({
			userCode: device.user_code,
			verificationUri: DEVICE_VERIFICATION_URI,
			intervalSeconds,
			expiresInSeconds: DEVICE_CODE_TIMEOUT_MS / 1000,
		});

		let pollIntervalMs = Math.max(1, intervalSeconds) * 1000;
		while (true) {
			await abortableDelay(pollIntervalMs, signal);
			const pollResponse = await fetch(DEVICE_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					device_auth_id: device.device_auth_id,
					user_code: device.user_code,
				}),
				signal,
			});

			if (pollResponse.ok) {
				const result = await pollResponse.json() as {
					authorization_code?: string;
					code_verifier?: string;
				};
				if (!result.authorization_code || !result.code_verifier) {
					throw new Error("OpenAI Codex device authorization returned an invalid response");
				}
				return exchangeDeviceCode(result.authorization_code, result.code_verifier, signal);
			}

			const detail = await pollResponse.text().catch(() => "");
			let errorCode = "";
			try {
				const error = (JSON.parse(detail) as { error?: string | { code?: string } }).error;
				errorCode = typeof error === "string" ? error : error?.code ?? "";
			} catch {
				// Some endpoint versions return plain text; inspect it below.
			}
			if (errorCode === "slow_down" || detail.includes("slow_down")) {
				pollIntervalMs += 5_000;
				continue;
			}
			if (
				errorCode === "deviceauth_authorization_pending" ||
				detail.includes("authorization_pending") ||
				pollResponse.status === 403 ||
				pollResponse.status === 404
			) {
				continue;
			}
			throw new Error(`OpenAI Codex device authorization failed (${pollResponse.status}): ${detail}`);
		}
	} catch (error) {
		if (callbacks.signal?.aborted) throw new Error("OpenAI Codex login cancelled");
		if (timeoutController.signal.aborted) throw new Error("OpenAI Codex device login timed out");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
			client_id: CLIENT_ID,
		}),
		signal,
	});
	const refreshed = await readTokenResponse(response, "refresh");
	return { ...credentials, ...refreshed };
}

export default function (pi: ExtensionAPI) {
	const models = getModels("openai-codex").map(({ provider: _provider, ...model }) => model);
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: "https://chatgpt.com/backend-api",
		api: "openai-codex-responses",
		models,
		oauth: {
			name: PROVIDER_NAME,
			isSubscription: true,
			login,
			refreshToken,
			getApiKey: (credentials) => credentials.access,
		},
	});
}

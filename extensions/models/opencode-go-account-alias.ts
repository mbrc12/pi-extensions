import { getModels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("opencode-go-2", {
		name: "OpenCode Go 2",
		baseUrl: "https://opencode.ai/inference/go/v1",
		apiKey: "$OPENCODE_GO_2_API_KEY",
		models: getModels("opencode-go").map(({ provider: _provider, ...model }) => model),
	});
}

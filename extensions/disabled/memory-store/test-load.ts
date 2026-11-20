// Load the memory-store extension factory with pi's own jiti loader + aliases
// and verify it registers tools, commands, and event handlers. No model calls.
// Run: node test-load.ts
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Replicate pi's loader aliases (from dist/core/extensions/loader.js)
const packagesRoot = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules";
const aliases = {
  typebox: path.join(packagesRoot, "typebox/build/index.mjs"),
  "typebox/compile": path.join(packagesRoot, "typebox/build/compile/index.mjs"),
  "typebox/value": path.join(packagesRoot, "typebox/build/value/index.mjs"),
  "@earendil-works/pi-coding-agent": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
  "@earendil-works/pi-tui": path.join(packagesRoot, "@earendil-works/pi-tui/dist/index.js"),
  "@earendil-works/pi-ai/providers/all": path.join(packagesRoot, "@earendil-works/pi-ai/dist/providers/all.js"),
  "@earendil-works/pi-ai/oauth": path.join(packagesRoot, "@earendil-works/pi-ai/dist/oauth.js"),
  "@earendil-works/pi-ai/compat": path.join(packagesRoot, "@earendil-works/pi-ai/dist/compat.js"),
  "@earendil-works/pi-ai": path.join(packagesRoot, "@earendil-works/pi-ai/dist/compat.js"),
  "@earendil-works/pi-agent-core": path.join(packagesRoot, "@earendil-works/pi-agent-core/dist/index.js"),
};

const jiti = createJiti(path.join(__dirname, "x.mjs"), { moduleCache: false, alias: aliases });

const registrations = { tools: [], commands: [], events: [] };
const stubPi = {
  on(channel, handler) {
    registrations.events.push(channel);
  },
  registerTool(tool) {
    registrations.tools.push(tool.name);
  },
  registerCommand(name, def) {
    registrations.commands.push(name);
  },
};

const factory = await jiti.import(path.join(__dirname, "index.ts"), { default: true });
if (typeof factory !== "function") {
  console.error("FAIL: factory is not a function:", typeof factory);
  process.exit(1);
}
factory(stubPi);

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};

check("factory is a function", typeof factory === "function");
check("4 tools registered", registrations.tools.length === 4);
for (const name of ["memory_search", "memory_add", "memory_remove", "memory_update"]) {
  check(`tool ${name}`, registrations.tools.includes(name));
}
check("4 commands registered", registrations.commands.length === 4);
for (const name of ["memory-search", "memory-list", "memory-stats", "memory-health"]) {
  check(`command ${name}`, registrations.commands.includes(name));
}
for (const ev of ["message_end", "turn_end", "session_before_compact", "session_shutdown"]) {
  check(`event ${ev}`, registrations.events.includes(ev));
}

// Instance files land in agent/memory-store/, not the extension dir.
const dbFile = path.join(process.env.HOME, ".pi", "agent", "memory-store", "memories.db");
check("db created in agent/memory-store/", fs.existsSync(dbFile));

console.log(failures === 0 ? "\nALL LOAD TESTS PASSED" : `\n${failures} LOAD TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

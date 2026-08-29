/**
 * Config for the memory-store extension.
 *
 * Optional config file: ~/.pi/agent/memory-store/config.json
 *
 * {
 *   "model": "opencode-go/deepseek-v4-flash",   // primary LLM for review/rerank/etc.
 *   "fallbackModels": ["openai-codex/gpt-5.6-luna"], // tried after provider/auth failure
 *   "dbDir": "~/.pi/agent/memory-store",        // where memories.db lives
 *   "reviewEnabled": true,                      // background review loop
 *   "flushOnCompact": true,
 *   "flushOnShutdown": true,
 *   "nudgeInterval": 10,                        // turns between reviews
 *   "nudgeToolCalls": 15,                       // tool calls between reviews
 *   "minUserTurns": 3,
 *   "minParts": 4,
 *   "flushMinTurns": 6,
 *   "rerankCandidates": 15,                     // FTS5 pool before LLM rerank
 *   "searchLimit": 5                            // default memory_search limit
 * }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DB_FILE,
  DEFAULT_DB_DIR,
  DEFAULT_FLUSH_MIN_TURNS,
  DEFAULT_MIN_PARTS,
  DEFAULT_MIN_USER_TURNS,
  DEFAULT_MODEL,
  DEFAULT_NUDGE_INTERVAL,
  DEFAULT_NUDGE_TOOL_CALLS,
  DEFAULT_RERANK_CANDIDATES,
  DEFAULT_SEARCH_LIMIT,
} from "./constants.js";

export interface MemoryStoreConfig {
  model: string;
  fallbackModels: string[];
  dbDir: string;
  reviewEnabled: boolean;
  flushOnCompact: boolean;
  flushOnShutdown: boolean;
  nudgeInterval: number;
  nudgeToolCalls: number;
  minUserTurns: number;
  minParts: number;
  flushMinTurns: number;
  rerankCandidates: number;
  searchLimit: number;
}

export const DEFAULT_CONFIG: MemoryStoreConfig = {
  model: DEFAULT_MODEL,
  fallbackModels: [],
  dbDir: DEFAULT_DB_DIR,
  reviewEnabled: true,
  flushOnCompact: true,
  flushOnShutdown: true,
  nudgeInterval: DEFAULT_NUDGE_INTERVAL,
  nudgeToolCalls: DEFAULT_NUDGE_TOOL_CALLS,
  minUserTurns: DEFAULT_MIN_USER_TURNS,
  minParts: DEFAULT_MIN_PARTS,
  flushMinTurns: DEFAULT_FLUSH_MIN_TURNS,
  rerankCandidates: DEFAULT_RERANK_CANDIDATES,
  searchLimit: DEFAULT_SEARCH_LIMIT,
};

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveConfigPath(): string {
  const dir = expandHome(DEFAULT_DB_DIR);
  return path.join(dir, "config.json");
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function compilePatterns(configured: unknown, defaults: RegExp[]): RegExp[] {
  if (!Array.isArray(configured)) return defaults;
  const compiled: RegExp[] = [];
  for (const source of configured) {
    if (typeof source !== "string") continue;
    try {
      compiled.push(new RegExp(source, "i"));
    } catch {
      // Ignore invalid regex entries; valid entries still apply.
    }
  }
  return compiled.length > 0 ? compiled : defaults;
}

export function loadConfig(configPath = resolveConfigPath()): MemoryStoreConfig {
  const config: MemoryStoreConfig = { ...DEFAULT_CONFIG };

  try {
    if (!fs.existsSync(configPath)) return config;
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (typeof parsed.model === "string" && parsed.model.trim()) {
      config.model = parsed.model.trim();
    }
    if (Array.isArray(parsed.fallbackModels)) {
      config.fallbackModels = parsed.fallbackModels
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim());
    }
    if (typeof parsed.dbDir === "string" && parsed.dbDir.trim()) {
      config.dbDir = parsed.dbDir.trim();
    }
    if (typeof parsed.reviewEnabled === "boolean") config.reviewEnabled = parsed.reviewEnabled;
    if (typeof parsed.flushOnCompact === "boolean") config.flushOnCompact = parsed.flushOnCompact;
    if (typeof parsed.flushOnShutdown === "boolean") config.flushOnShutdown = parsed.flushOnShutdown;
    if (isNonNegativeNumber(parsed.nudgeInterval) && parsed.nudgeInterval > 0) {
      config.nudgeInterval = Math.floor(parsed.nudgeInterval);
    }
    if (isNonNegativeNumber(parsed.nudgeToolCalls) && parsed.nudgeToolCalls > 0) {
      config.nudgeToolCalls = Math.floor(parsed.nudgeToolCalls);
    }
    if (isNonNegativeNumber(parsed.minUserTurns) && parsed.minUserTurns > 0) {
      config.minUserTurns = Math.floor(parsed.minUserTurns);
    }
    if (isNonNegativeNumber(parsed.minParts) && parsed.minParts > 0) {
      config.minParts = Math.floor(parsed.minParts);
    }
    if (isNonNegativeNumber(parsed.flushMinTurns) && parsed.flushMinTurns > 0) {
      config.flushMinTurns = Math.floor(parsed.flushMinTurns);
    }
    if (isNonNegativeNumber(parsed.rerankCandidates) && parsed.rerankCandidates > 0) {
      config.rerankCandidates = Math.floor(parsed.rerankCandidates);
    }
    if (isNonNegativeNumber(parsed.searchLimit) && parsed.searchLimit > 0) {
      config.searchLimit = Math.floor(parsed.searchLimit);
    }
  } catch {
    // Fall back to defaults on parse error or access issues.
  }

  return config;
}

/** Absolute path to the SQLite database file. */
export function dbFilePath(config: MemoryStoreConfig): string {
  return path.join(expandHome(config.dbDir), DB_FILE);
}

export function configDirPath(config: MemoryStoreConfig): string {
  return expandHome(config.dbDir);
}

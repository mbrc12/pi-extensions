// Standalone test of the memory-store DB layer.
// Run: node --experimental-strip-types test-db.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryDb } from "./db.ts";
import { loadConfig } from "./config.ts";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-test-"));
const config = { ...loadConfig(), dbDir: testDir };
const db = new MemoryDb(config);

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
}

try {
  // Add + dedup
  const r1 = db.add("User prefers pnpm over npm for package management", "preference", "tool");
  check("add1 ok", r1.ok && !r1.duplicate && typeof r1.id === "number");
  const r2 = db.add("User prefers pnpm over npm for package management");
  check("add2 duplicate", r2.duplicate);
  db.add("M1 Mac has issues with better-sqlite3 native builds", "tool-quirk");
  db.add("User works at a fintech startup called Acme", "memory");
  db.add("wifi drops when the laptop sleeps", "tool-quirk");
  db.add("Always use sed for daily notes, not echo >>", "convention");

  // Broad FTS5 candidate search supports Porter stemming.
  const c1 = db.searchCandidates("pnpm package manager", 10);
  check("broad search finds pnpm blurb", c1.some((c) => c.content.includes("pnpm")));
  const c2 = db.searchCandidates("wifi drop", 10);
  check("broad search stems drop to drops", c2.some((c) => c.content.includes("wifi drops")));

  // Strict fallback must not return an OR-only match after reranking fails.
  const strictHit = db.searchStrictCandidates("pnpm package manager", 10);
  check("strict search finds all-token match", strictHit.some((c) => c.content.includes("pnpm")));
  const strictMiss = db.searchStrictCandidates("pnpm unrelated", 10);
  check("strict search rejects partial OR match", strictMiss.length === 0);

  // Malformed / injection-ish query must not break and must not return junk.
  const c3 = db.searchCandidates('OR * "weird', 10);
  check("weird query safe", Array.isArray(c3));
  const c4 = db.searchCandidates("", 10);
  check("empty query safe", c4.length === 0);

  // Remove + replace.
  const rem = db.remove("Acme");
  check("remove Acme", rem.removed === 1);
  const rep = db.replace("better-sqlite3", "node:sqlite built into Node 26 works fine");
  check("replace better-sqlite3", rep.replaced === 1);
  const after = db.list();
  check("replaced content present", after.some((b) => b.content.includes("node:sqlite")));
  check("old content gone", !after.some((b) => b.content.includes("better-sqlite3")));

  // Touch + audit events.
  const target = after.find((b) => b.content.includes("pnpm"));
  if (target) {
    const before = target.last_used_at;
    db.touch([target.id]);
    const afterTouch = db.getByIds([target.id]);
    check("touch updates last_used_at", afterTouch[0]?.last_used_at >= before);
  }
  db.recordEvent("review", "no_change", "0 applied, 0 skipped");
  check("events are retained", db.listEvents().some((event) => event.kind === "review"));

  // Stats + category filter.
  const stats = db.stats();
  check("stats total > 0", stats.total > 0);
  check("stats by source has tool", (stats.by_source.tool ?? 0) > 0);
  check("stats reports review event", (stats.events["review:no_change"] ?? 0) === 1);
  const quirkList = db.list("tool-quirk");
  check("list by category", quirkList.length > 0 && quirkList.every((b) => b.category === "tool-quirk"));
} finally {
  db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

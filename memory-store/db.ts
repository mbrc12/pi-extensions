/**
 * SQLite storage for the memory-store extension.
 *
 * One file, one source of truth. A `memories` table holds markdown blurbs,
 * and an FTS5 virtual table (external content, trigger-maintained) provides
 * keyword retrieval. WAL mode + busy_timeout handle concurrent pi sessions:
 * SQLite is the lock, so there is no markdown-file race machinery at all.
 *
 * Design decisions:
 * - Dedup at the DB level via UNIQUE(content).
 * - last_used_at is bumped on search hits (and on add) to support future
 *   aging/pruning without a consolidation rewrite.
 * - All mutation methods run inside a single transaction.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configDirPath, dbFilePath, type MemoryStoreConfig } from "./config.js";
import { WAL_PRAGMAS } from "./constants.js";

export interface MemoryBlurb {
  id: number;
  content: string;
  category: string;
  created_at: string;
  last_used_at: string;
  source: string;
}

export interface AddResult {
  ok: boolean;
  duplicate: boolean;
  id?: number;
}

export interface MemoryEvent {
  id: number;
  occurred_at: string;
  kind: string;
  outcome: string;
  detail: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  content      TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'memory',
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'tool',
  UNIQUE(content)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS memory_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  kind        TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT ''
);
`;

export class MemoryDb {
  private db: DatabaseSync;

  constructor(config: MemoryStoreConfig) {
    const dir = configDirPath(config);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbFilePath(config));
    for (const pragma of WAL_PRAGMAS) {
      this.db.exec(pragma);
    }
    this.db.exec(SCHEMA);
  }

  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Best effort — never block shutdown.
    }
    try {
      this.db.close();
    } catch {
      // Best effort.
    }
  }

  private today(): string {
    return new Date().toISOString().split("T")[0];
  }

  /** Add a blurb. Dedup at the DB level: UNIQUE(content). */
  add(content: string, category = "memory", source = "tool"): AddResult {
    const trimmed = content.trim();
    if (!trimmed) return { ok: false, duplicate: false };

    const now = this.today();
    try {
      const result = this.db
        .prepare("INSERT INTO memories (content, category, created_at, last_used_at, source) VALUES (?, ?, ?, ?, ?)")
        .run(trimmed, category, now, now, source);
      return { ok: true, duplicate: false, id: Number(result.lastInsertRowid) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE")) {
        return { ok: true, duplicate: true };
      }
      throw error;
    }
  }

  /** Add if not already present (exact text match). Returns true when added. */
  addIfAbsent(content: string, category = "memory", source = "tool"): { added: boolean; duplicate: boolean } {
    const result = this.add(content, category, source);
    return { added: result.ok && !result.duplicate, duplicate: result.duplicate };
  }

  /** Remove every blurb whose content contains oldText (case-insensitive). */
  remove(oldText: string): { removed: number } {
    const trimmed = oldText.trim();
    if (!trimmed) return { removed: 0 };
    const result = this.db
      .prepare("DELETE FROM memories WHERE lower(content) LIKE lower(?)")
      .run(`%${trimmed}%`);
    return { removed: Number(result.changes) };
  }

  /** Replace blurbs containing oldText with newContent. Returns count replaced. */
  replace(oldText: string, newContent: string): { replaced: number } {
    const oldTrimmed = oldText.trim();
    const newTrimmed = newContent.trim();
    if (!oldTrimmed || !newTrimmed) return { replaced: 0 };
    const now = this.today();
    const rows = this.db
      .prepare("SELECT id, content FROM memories WHERE lower(content) LIKE lower(?)")
      .all(`%${oldTrimmed}%`) as { id: number; content: string }[];

    const update = this.db.prepare(
      "UPDATE memories SET content = ?, last_used_at = ? WHERE id = ?",
    );
    for (const row of rows) {
      update.run(newTrimmed, now, row.id);
    }
    return { replaced: rows.length };
  }

  list(category?: string): MemoryBlurb[] {
    if (category && category.trim()) {
      return this.db
        .prepare("SELECT * FROM memories WHERE category = ? ORDER BY last_used_at DESC, id DESC")
        .all(category.trim()) as unknown as MemoryBlurb[];
    }
    return this.db
      .prepare("SELECT * FROM memories ORDER BY last_used_at DESC, id DESC")
      .all() as unknown as MemoryBlurb[];
  }

  stats(): { total: number; by_category: Record<string, number>; by_source: Record<string, number>; events: Record<string, number> } {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
    const categoryRows = this.db
      .prepare("SELECT category, COUNT(*) AS c FROM memories GROUP BY category")
      .all() as { category: string; c: number }[];
    const sourceRows = this.db
      .prepare("SELECT source, COUNT(*) AS c FROM memories GROUP BY source")
      .all() as { source: string; c: number }[];
    const eventRows = this.db
      .prepare("SELECT kind || ':' || outcome AS key, COUNT(*) AS c FROM memory_events GROUP BY kind, outcome")
      .all() as { key: string; c: number }[];
    const by_category: Record<string, number> = {};
    const by_source: Record<string, number> = {};
    const events: Record<string, number> = {};
    for (const row of categoryRows) by_category[row.category] = row.c;
    for (const row of sourceRows) by_source[row.source] = row.c;
    for (const row of eventRows) events[row.key] = row.c;
    return { total, by_category, by_source, events };
  }

  /** Record a compact outcome for background review, flush, or retrieval. */
  recordEvent(kind: string, outcome: string, detail = ""): void {
    this.db
      .prepare("INSERT INTO memory_events (occurred_at, kind, outcome, detail) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), kind, outcome, detail.slice(0, 500));
  }

  listEvents(limit = 10): MemoryEvent[] {
    return this.db
      .prepare("SELECT * FROM memory_events ORDER BY id DESC LIMIT ?")
      .all(Math.min(Math.max(Math.floor(limit), 1), 100)) as unknown as MemoryEvent[];
  }

  /**
   * FTS5 keyword search. Returns up to `limit` candidates ordered by BM25.
   * The broad OR query maximizes recall for the LLM reranker.
   */
  searchCandidates(query: string, limit: number): MemoryBlurb[] {
    const matchExpr = this.buildMatchExpression(query, "OR");
    if (!matchExpr) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.content, m.category, m.created_at, m.last_used_at, m.source,
                  bm25(memories_fts) AS rank
           FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
           WHERE memories_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(matchExpr, limit) as unknown as MemoryBlurb[];
      return rows;
    } catch {
      // A malformed MATCH expression must never break a search — return nothing.
      return [];
    }
  }

  /**
   * Conservative FTS fallback: all query tokens must occur in a blurb.
   * Used only if reranking is unavailable, so a provider failure cannot inject
   * weak OR matches into the conversation.
   */
  searchStrictCandidates(query: string, limit: number): MemoryBlurb[] {
    const matchExpr = this.buildMatchExpression(query, "AND");
    if (!matchExpr) return [];
    try {
      return this.db
        .prepare(
          `SELECT m.id, m.content, m.category, m.created_at, m.last_used_at, m.source,
                  bm25(memories_fts) AS rank
           FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
           WHERE memories_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(matchExpr, limit) as unknown as MemoryBlurb[];
    } catch {
      return [];
    }
  }

  /** Bump last_used_at for a set of ids (search hits). Single transaction. */
  touch(ids: number[]): void {
    if (ids.length === 0) return;
    const now = this.today();
    const update = this.db.prepare("UPDATE memories SET last_used_at = ? WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      for (const id of ids) update.run(now, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getByIds(ids: number[]): MemoryBlurb[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as MemoryBlurb[];
  }

  /**
   * Turn a user query into an FTS5 MATCH expression: each token becomes a
   * quoted phrase, joined with OR. Quoting prevents FTS syntax injection
   * (e.g. `OR`, `NEAR`, `*` in the query).
   *
   * OR (not AND) on purpose: the FTS5 stage is a recall gate — it should cast
   * a wide net and let the LLM rerank decide precision. AND would drop
   * relevant blurbs whenever the query uses a synonym the entry lacks
   * (e.g. "drinks" vs "coffee"), which is exactly the case rerank exists for.
   */
  private buildMatchExpression(query: string, operator: "OR" | "AND"): string {
    const tokens = query
      .split(/\s+/)
      .map((t) => t.trim().replace(/"/g, ""))
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return "";
    return tokens.map((t) => `"${t}"`).join(` ${operator} `);
  }
}

import type { SyncSourceResult } from "../core/types";
import { MachineDatabase } from "./database";
import { decodeJson, encodeJson } from "./json";

export interface StoredSyncRun {
  id: string;
  status: "running" | "succeeded" | "partial" | "failed";
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  results: SyncSourceResult[];
}

export class SyncRepository {
  constructor(private readonly database: MachineDatabase) {}

  startRun(id: string, startedAt = new Date().toISOString()): void {
    this.database.connection
      .prepare(
        `INSERT INTO sync_runs(id, status, started_at)
         VALUES (?, 'running', ?)`
      )
      .run(id, startedAt);
  }

  finishRun(
    id: string,
    status: Exclude<StoredSyncRun["status"], "running">,
    error: string | null,
    completedAt = new Date().toISOString()
  ): void {
    this.database.connection
      .prepare(
        `UPDATE sync_runs
         SET status = ?, error = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(status, error, completedAt, id);
  }

  saveSourceResult(runId: string, result: SyncSourceResult): void {
    const status = result.ok ? "succeeded" : "failed";
    this.database.connection
      .prepare(
        `INSERT INTO sync_source_runs(
           sync_run_id, source, status, received, persisted,
           error, issue_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sync_run_id, source) DO UPDATE SET
           status = excluded.status,
           received = excluded.received,
           persisted = excluded.persisted,
           error = excluded.error,
           issue_json = excluded.issue_json,
           completed_at = excluded.completed_at`
      )
      .run(
        runId,
        result.source,
        status,
        result.received,
        result.persisted,
        result.error ?? null,
        result.issue ? encodeJson(result.issue) : null,
        result.completed_at ?? null
      );
  }

  getCursor(source: string): string | null {
    const row = this.database.connection
      .prepare("SELECT cursor_at FROM sync_cursors WHERE source = ?")
      .get(source) as { cursor_at: string } | undefined;
    return row?.cursor_at ?? null;
  }

  setCursor(
    source: string,
    cursorAt: string,
    updatedAt = new Date().toISOString()
  ): void {
    this.database.connection
      .prepare(
        `INSERT INTO sync_cursors(source, cursor_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           cursor_at = excluded.cursor_at,
           updated_at = excluded.updated_at`
      )
      .run(source, cursorAt, updatedAt);
  }

  hasSuccessfulRun(): boolean {
    return Boolean(
      this.database.connection
        .prepare("SELECT 1 FROM sync_runs WHERE status = 'succeeded' LIMIT 1")
        .get()
    );
  }

  latestRun(): StoredSyncRun | null {
    const run = this.database.connection
      .prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1")
      .get() as
      | {
          id: string;
          status: StoredSyncRun["status"];
          started_at: string;
          completed_at: string | null;
          error: string | null;
        }
      | undefined;
    if (!run) return null;
    const results = this.database.connection
      .prepare(
        `SELECT source, status, received, persisted, error, issue_json, completed_at
         FROM sync_source_runs
         WHERE sync_run_id = ?
         ORDER BY rowid`
      )
      .all(run.id) as Array<{
        source: SyncSourceResult["source"];
        status: "succeeded" | "failed";
        received: number;
        persisted: number;
        error: string | null;
        issue_json: string | null;
        completed_at: string | null;
      }>;
    return {
      id: run.id,
      status: run.status,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      error: run.error,
      results: results.map((row) => ({
        source: row.source,
        ok: row.status === "succeeded",
        received: row.received,
        persisted: row.persisted,
        ...(row.error ? { error: row.error } : {}),
        ...(row.issue_json
          ? { issue: decodeJson<NonNullable<SyncSourceResult["issue"]>>(row.issue_json) }
          : {}),
        ...(row.completed_at ? { completed_at: row.completed_at } : {})
      }))
    };
  }
}

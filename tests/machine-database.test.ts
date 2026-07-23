import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMachineMigrations,
  MACHINE_DATABASE_RELATIVE_PATH,
  MACHINE_MIGRATIONS,
  openMachineDatabase
} from "../src/machine";

describe("MachineDatabase", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-machine-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a restricted database with the required pragmas and schema", async () => {
    const database = await openMachineDatabase(root);
    expect(database.connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.connection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.connection.pragma("busy_timeout", { simple: true })).toBe(5000);

    const tables = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "sources",
        "analysis_jobs",
        "analysis_candidates",
        "acceptance_operations",
        "markdown_documents",
        "agent_repositories",
        "agent_sessions",
        "agent_confirmations"
      ])
    );
    expect(
      database.connection
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()
    ).toEqual({ count: MACHINE_MIGRATIONS.length });
    database.close();

    const mode = (await stat(path.join(root, MACHINE_DATABASE_RELATIVE_PATH))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("can reopen without applying a migration twice", async () => {
    const first = await openMachineDatabase(root);
    first.close();
    const second = await openMachineDatabase(root);
    expect(
      second.connection
        .prepare("SELECT version, COUNT(*) AS count FROM schema_migrations GROUP BY version")
        .all()
    ).toEqual(
      MACHINE_MIGRATIONS.map(({ version }) => ({ version, count: 1 }))
    );
    second.close();
  });

  it("backfills causal Agent message sequence when upgrading an existing database", () => {
    const database = new Database(":memory:");
    const agentMigration = MACHINE_MIGRATIONS.find(({ version }) => version === 4)!;
    database.exec(agentMigration.sql);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const markApplied = database.prepare(
      "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)"
    );
    for (const migration of MACHINE_MIGRATIONS.filter(({ version }) => version < 7)) {
      markApplied.run(migration.version, migration.name, "2026-07-21T00:00:00.000Z");
    }
    database.exec(`
      INSERT INTO agent_repositories(
        id, name, path, head_commit, branch, created_at, updated_at
      ) VALUES (
        'repo_existing', 'Existing', '/tmp/existing', '', NULL,
        '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z'
      );
      INSERT INTO agent_sessions(
        id, title, source_kind, source_id, repository_id, mode,
        workspace_path, branch, base_commit, thread_id, status, attention,
        workspace_lifecycle, created_at, updated_at, ended_at
      ) VALUES (
        'session_existing', 'Existing', 'todo', 'todo_existing',
        'repo_existing', 'read_only', '/tmp/existing', NULL, '', NULL,
        'active', 'none', 'ready', '2026-07-21T00:00:00.000Z',
        '2026-07-21T00:00:00.000Z', NULL
      );
    `);
    const insert = database.prepare(
      `INSERT INTO agent_messages(id, session_id, turn_id, role, content, created_at)
       VALUES (?, 'session_existing', NULL, ?, ?, '2026-07-21T00:00:00.000Z')`
    );
    insert.run("message_z", "user", "first");
    insert.run("message_a", "assistant", "second");

    applyMachineMigrations(database);

    expect(
      database.prepare("SELECT agent, model FROM agent_sessions WHERE id = 'session_existing'").get()
    ).toEqual({ agent: "codex", model: null });

    expect(
      database.prepare(
        "SELECT id, sequence FROM agent_messages ORDER BY sequence"
      ).all()
    ).toEqual([
      { id: "message_z", sequence: 1 },
      { id: "message_a", sequence: 2 }
    ]);
    database.close();
  });

  it("rolls back all writes when a transaction fails", async () => {
    const database = await openMachineDatabase(root);
    expect(() =>
      database.transaction(() => {
        database.connection
          .prepare(
            `INSERT INTO settings(key, value_json, updated_at)
             VALUES ('retention_days', '90', '2026-07-20T00:00:00.000Z')`
          )
          .run();
        throw new Error("stop");
      })
    ).toThrow("stop");
    expect(
      database.connection
        .prepare("SELECT key FROM settings WHERE key = 'retention_days'")
        .get()
    ).toBeUndefined();
    database.close();
  });
});

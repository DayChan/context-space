import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
        "markdown_documents"
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

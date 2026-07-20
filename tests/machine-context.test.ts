import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedSourceRecord } from "../src/core/types";
import {
  MachineContextRepository,
  SettingsRepository,
  SyncRepository,
  openMachineDatabase,
  type MachineDatabase
} from "../src/machine";

function source(
  id: string,
  overrides: Partial<NormalizedSourceRecord> = {}
): NormalizedSourceRecord {
  return {
    sourceId: id,
    provider: "lark",
    kind: "p2p",
    title: `Source ${id}`,
    text: "original body",
    occurredAt: "2026-01-01T00:00:00.000Z",
    participants: [
      {
        provider_id: "ou_partner",
        name: "Partner",
        role: "partner"
      }
    ],
    metadata: {},
    ...overrides
  };
}

describe("machine context repositories", () => {
  let root: string;
  let database: MachineDatabase;
  let context: MachineContextRepository;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-repository-"));
    database = await openMachineDatabase(root);
    context = new MachineContextRepository(database);
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("upserts stable sources, participants, upstream tasks and people", () => {
    expect(context.upsertSource(source("lark:message:1"))).toEqual({
      inserted: true,
      changed: true
    });
    expect(
      context.upsertSource(
        source("lark:message:1", {
          text: "updated body",
          participants: [
            { provider_id: "ou_partner", name: "Renamed", role: "partner" }
          ]
        })
      )
    ).toEqual({ inserted: false, changed: true });
    expect(context.getSource("lark:message:1")).toMatchObject({
      body: "updated body",
      participants: [{ provider_id: "ou_partner", name: "Renamed" }]
    });
    expect(context.countUpstreamPeople()).toBe(1);

    context.upsertSource(
      source("lark:task:1", {
        kind: "task",
        metadata: { status: "open", due_at: "2026-08-01T00:00:00.000Z" },
        participants: [
          { provider_id: "ou_self", name: "Me", role: "assignee" }
        ]
      })
    );
    expect(context.countUpstreamTasks()).toBe(1);
    expect(context.countUpstreamPeople()).toBe(2);
  });

  it("stores independent source cursors and sync results", () => {
    const sync = new SyncRepository(database);
    sync.startRun("sync_1", "2026-07-20T00:00:00.000Z");
    sync.setCursor("p2p", "2026-07-20T01:00:00.000Z");
    sync.saveSourceResult("sync_1", {
      source: "p2p",
      ok: true,
      received: 4,
      persisted: 3,
      completed_at: "2026-07-20T01:00:00.000Z"
    });
    sync.finishRun("sync_1", "succeeded", null, "2026-07-20T01:00:00.000Z");
    expect(sync.getCursor("p2p")).toBe("2026-07-20T01:00:00.000Z");
    expect(sync.latestRun()).toMatchObject({
      id: "sync_1",
      status: "succeeded",
      results: [{ source: "p2p", ok: true, received: 4, persisted: 3 }]
    });
  });

  it("validates settings and defaults source retention to 90 days", () => {
    const settings = new SettingsRepository(database);
    expect(settings.getSourceRetentionDays()).toBe(90);
    settings.setSourceRetentionDays(30);
    expect(settings.getSourceRetentionDays()).toBe(30);
    expect(() => settings.setSourceRetentionDays(0)).toThrow();
  });

  it("purges only analyzed and unblocked message bodies", () => {
    context.upsertSource(source("lark:message:analyzed"));
    context.upsertSource(source("lark:message:pending"));
    context.upsertSource(source("lark:message:unanalyzed"));
    context.markAnalyzed([
      "lark:message:analyzed",
      "lark:message:pending"
    ]);

    database.transaction(() => {
      database.connection
        .prepare(
          `INSERT INTO analysis_jobs(
             id, idempotency_key, source_ids_json, status, available_at,
             max_attempts, config_json, created_at, updated_at
           ) VALUES ('job', 'key', '[]', 'succeeded', ?, 3, '{}', ?, ?)`
        )
        .run(
          "2026-07-20T00:00:00.000Z",
          "2026-07-20T00:00:00.000Z",
          "2026-07-20T00:00:00.000Z"
        );
      database.connection
        .prepare(
          `INSERT INTO analysis_runs(
             id, job_id, status, provider, prompt_version, schema_version,
             config_hash, event_types_json, started_at, completed_at
           ) VALUES ('run', 'job', 'succeeded', 'test', 'p1', 's1', 'hash', '[]', ?, ?)`
        )
        .run("2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z");
      database.connection
        .prepare(
          `INSERT INTO analysis_candidates(
             id, run_id, stable_key, kind, status, title, data_json,
             source_refs_json, confidence, reason, created_at
           ) VALUES ('candidate', 'run', 'stable', 'todo', 'proposed',
             'Todo', '{}', '["lark:message:pending"]', 0.9, 'reason', ?)`
        )
        .run("2026-07-20T00:00:00.000Z");
      database.connection
        .prepare(
          `INSERT INTO candidate_evidence(candidate_id, source_id, quote, position)
           VALUES ('candidate', 'lark:message:pending', 'evidence', 0)`
        )
        .run();
    });

    expect(context.purgeExpiredBodies(90, new Date("2026-07-20T00:00:00.000Z"))).toBe(1);
    expect(context.getSource("lark:message:analyzed")?.body).toBeNull();
    expect(context.getSource("lark:message:pending")?.body).toBe("original body");
    expect(context.getSource("lark:message:unanalyzed")?.body).toBe("original body");
  });
});

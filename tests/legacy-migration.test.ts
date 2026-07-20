import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeHumanWorkspace } from "../src/core/workspace";
import { createTodoMetadata } from "../src/core/todo";
import {
  LegacyWorkspaceMigration,
  MachineContextRepository,
  SettingsRepository,
  SyncRepository,
  openMachineDatabase,
  type MachineDatabase
} from "../src/machine";
import type { MarkdownStore } from "../src/core/markdown-store";
import type { SourceMetadata } from "../src/core/types";

describe("legacy workspace migration", () => {
  let root: string;
  let store: MarkdownStore;
  let database: MachineDatabase;
  let migration: LegacyWorkspaceMigration;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-legacy-"));
    store = await initializeHumanWorkspace(root);
    database = await openMachineDatabase(root);
    migration = new LegacyWorkspaceMigration(
      root,
      store,
      database,
      new MachineContextRepository(database),
      new SyncRepository(database),
      new SettingsRepository(database)
    );
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("imports sources and candidates idempotently and writes a report", async () => {
    const timestamp = "2026-07-20T00:00:00.000Z";
    const source: SourceMetadata = {
      schema: "work-context/source@1",
      id: "lark:message:legacy",
      type: "source",
      title: "旧消息",
      managed: "generated",
      created_at: timestamp,
      updated_at: timestamp,
      source_refs: [],
      provider: "lark",
      source_kind: "mention",
      source_id: "lark:message:legacy",
      occurred_at: timestamp,
      participants: [],
      provider_metadata: {}
    };
    await store.write(
      "sources/lark/mentions/2026/07/legacy.md",
      source,
      "旧消息正文"
    );
    const candidate = createTodoMetadata({
      id: "legacy_candidate",
      title: "旧候选",
      type: "candidate",
      status: "candidate",
      managed: "generated",
      source_refs: [source.id]
    });
    candidate.analysis = {
      run_id: "analysis_run_legacy",
      item_key: "legacy_item",
      provider: "codex-sdk",
      prompt_version: "context-analysis@2",
      schema_version: "work-context/analysis@2",
      analyzed_at: timestamp,
      evidence: ["旧消息正文"],
      reason: "旧候选迁移"
    };
    await store.write(
      "inbox/todo-candidates/legacy_candidate.md",
      candidate,
      "# 旧候选"
    );
    await store.write(
      ".context/analysis/runs/analysis_run_legacy.md",
      {
        schema: "work-context/analysis-run@2",
        id: "analysis_run_legacy",
        type: "analysis-run",
        title: "旧分析运行",
        managed: "generated",
        created_at: timestamp,
        updated_at: timestamp,
        source_refs: [source.id],
        status: "succeeded",
        provider: "codex-sdk",
        model: null,
        prompt_version: "context-analysis@2",
        output_schema_version: "work-context/analysis@2",
        config_hash: "legacy-config",
        event_types: ["agent_message"],
        started_at: timestamp,
        completed_at: timestamp
      },
      ""
    );
    await store.write(
      ".context/sync/lark.md",
      {
        schema: "work-context/sync-status@1",
        id: "sync_lark_checkpoint",
        type: "sync-status",
        title: "旧同步游标",
        managed: "generated",
        created_at: timestamp,
        updated_at: timestamp,
        source_refs: [],
        source_checkpoints: { mentions: timestamp }
      },
      ""
    );
    await store.write(
      ".context/sync/lark-status.md",
      {
        schema: "work-context/sync-status@1",
        id: "sync_lark_status",
        type: "sync-status",
        title: "旧同步状态",
        managed: "generated",
        created_at: timestamp,
        updated_at: timestamp,
        source_refs: [],
        running: false,
        started_at: timestamp,
        completed_at: timestamp,
        results: [
          {
            source: "mentions",
            ok: true,
            received: 1,
            persisted: 1,
            completed_at: timestamp
          }
        ],
        last_error: null,
        progress: null
      },
      ""
    );
    await store.write(
      "config/workspace.md",
      {
        schema: "work-context/config@1",
        id: "config_workspace",
        type: "config",
        title: "旧工作区配置",
        managed: "manual",
        created_at: timestamp,
        updated_at: timestamp,
        source_refs: [],
        timezone: "Asia/Singapore",
        source_retention_days: 45
      },
      ""
    );
    await store.write(
      "config/analysis.md",
      {
        schema: "work-context/config@1",
        id: "config_analysis",
        type: "config",
        title: "旧分析配置",
        managed: "manual",
        created_at: timestamp,
        updated_at: timestamp,
        source_refs: [],
        provider: "codex-sdk",
        prompt_version: "context-analysis@1"
      },
      ""
    );

    const first = await migration.run();
    expect(first.counts.failed).toBe(0);
    expect(first.counts.imported).toBe(7);
    expect(
      new MachineContextRepository(database).getSource(source.id)?.body
    ).toBe("旧消息正文");
    expect(
      database.connection
        .prepare("SELECT status FROM analysis_candidates WHERE id = ?")
        .get(candidate.id)
    ).toEqual({ status: "proposed" });
    expect(
      database.connection
        .prepare("SELECT status FROM analysis_runs WHERE id = ?")
        .get("analysis_run_legacy")
    ).toEqual({ status: "succeeded" });
    expect(new SyncRepository(database).getCursor("mentions")).toBe(timestamp);
    const settings = new SettingsRepository(database);
    expect(settings.get("workspace_timezone")).toBe("Asia/Singapore");
    expect(settings.getSourceRetentionDays()).toBe(45);
    expect(
      settings.get<Record<string, unknown>>("analysis_config")
    ).toMatchObject({ prompt_version: "context-analysis@2" });

    const second = await migration.run();
    expect(second.counts.skipped).toBe(7);
    expect(
      (await readdir(path.join(root, ".context"))).includes(
        "migration-report.json"
      )
    ).toBe(true);
  });

  it("requires explicit confirmation and moves legacy files to a timestamped backup", async () => {
    const timestamp = "2026-07-20T00:00:00.000Z";
    const source: SourceMetadata = {
      schema: "work-context/source@1",
      id: "lark:message:backup",
      type: "source",
      title: "待备份",
      managed: "generated",
      created_at: timestamp,
      updated_at: timestamp,
      source_refs: [],
      provider: "lark",
      source_kind: "mention",
      source_id: "lark:message:backup",
      occurred_at: timestamp,
      participants: [],
      provider_metadata: {}
    };
    await store.write(
      "sources/lark/mentions/2026/07/backup.md",
      source,
      "正文"
    );
    await expect(migration.backup({ confirmed: false })).rejects.toThrow(
      "confirmed=true"
    );

    await migration.run();
    const report = await migration.backup({ confirmed: true });
    expect(report.moved).toContain("sources/lark");
    expect(await store.exists("sources/lark/mentions/2026/07/backup.md")).toBe(
      false
    );
    expect(
      await store.exists(
        `${report.backupDirectory}/sources/lark/mentions/2026/07/backup.md`
      )
    ).toBe(true);
  });
});

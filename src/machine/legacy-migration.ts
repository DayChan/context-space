import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import type { MarkdownStore } from "../core/markdown-store";
import type {
  BaseMetadata,
  NormalizedSourceRecord,
  SourceMetadata,
  SyncStatus
} from "../core/types";
import type { MachineDatabase } from "./database";
import { encodeJson } from "./json";
import type { MachineContextRepository } from "./context-repository";
import type { SettingsRepository } from "./settings-repository";
import type { SyncRepository } from "./sync-repository";

const LEGACY_DIRECTORIES = [
  "sources/lark",
  ".context/sync",
  ".context/analysis/runs",
  "inbox/todo-candidates",
  "inbox/knowledge-candidates"
] as const;

const LEGACY_CONFIG_FILES = [
  "config/analysis.md",
  "config/workspace.md",
  "config/priority-people.md",
  "config/policies.md",
  "config/sources/lark.md",
  ".context/analysis/status.md"
] as const;

export interface LegacyMigrationItem {
  sourcePath: string;
  targetKind: string;
  targetId: string | null;
  status: "imported" | "skipped" | "conflict" | "failed";
  error: string | null;
}

export interface LegacyMigrationReport {
  startedAt: string;
  completedAt: string;
  reportPath: string;
  counts: Record<LegacyMigrationItem["status"], number>;
  items: LegacyMigrationItem[];
}

export interface LegacyBackupReport {
  backupDirectory: string;
  moved: string[];
  skipped: string[];
}

function stableId(prefix: string, value: unknown): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${hash}`;
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function markdownFiles(
  root: string,
  relativeDirectory: string
): Promise<string[]> {
  const absoluteDirectory = path.join(root, relativeDirectory);
  if (!(await exists(absoluteDirectory))) return [];
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(
          path.relative(root, absolute).replaceAll(path.sep, "/")
        );
      }
    }
  }
  await visit(absoluteDirectory);
  return results.sort();
}

function stringValue(
  record: Record<string, unknown>,
  key: string,
  fallback: string
): string {
  return typeof record[key] === "string" && record[key]
    ? record[key]
    : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export class LegacyWorkspaceMigration {
  constructor(
    private readonly root: string,
    private readonly store: MarkdownStore,
    private readonly database: MachineDatabase,
    private readonly context: MachineContextRepository,
    private readonly sync: SyncRepository,
    private readonly settings: SettingsRepository
  ) {}

  async run(): Promise<LegacyMigrationReport> {
    const startedAt = new Date().toISOString();
    const sourceFiles = await markdownFiles(this.root, "sources/lark");
    const analysisRuns = await markdownFiles(
      this.root,
      ".context/analysis/runs"
    );
    const todoCandidates = await markdownFiles(
      this.root,
      "inbox/todo-candidates"
    );
    const knowledgeCandidates = await markdownFiles(
      this.root,
      "inbox/knowledge-candidates"
    );
    const optionalFiles = await Promise.all(
      LEGACY_CONFIG_FILES.map(async (filePath) =>
        (await this.store.exists(filePath)) ? [filePath] : []
      )
    );
    const items: LegacyMigrationItem[] = [];

    for (const filePath of sourceFiles) {
      items.push(await this.importFile(filePath, "source"));
    }
    for (const filePath of analysisRuns) {
      items.push(await this.importFile(filePath, "analysis_run"));
    }
    for (const filePath of [...todoCandidates, ...knowledgeCandidates]) {
      items.push(await this.importFile(filePath, "candidate"));
    }
    for (const filePath of optionalFiles.flat()) {
      const kind = filePath.startsWith(".context/sync/")
        ? "sync"
        : filePath === ".context/analysis/status.md"
          ? "analysis_status"
          : "config";
      items.push(await this.importFile(filePath, kind));
    }

    for (const filePath of await markdownFiles(this.root, ".context/sync")) {
      if (!items.some(({ sourcePath }) => sourcePath === filePath)) {
        items.push(await this.importFile(filePath, "sync"));
      }
    }

    const completedAt = new Date().toISOString();
    const reportRelativePath = ".context/migration-report.json";
    const report: LegacyMigrationReport = {
      startedAt,
      completedAt,
      reportPath: reportRelativePath,
      counts: {
        imported: items.filter(({ status }) => status === "imported").length,
        skipped: items.filter(({ status }) => status === "skipped").length,
        conflict: items.filter(({ status }) => status === "conflict").length,
        failed: items.filter(({ status }) => status === "failed").length
      },
      items
    };
    await mkdir(path.dirname(path.join(this.root, reportRelativePath)), {
      recursive: true
    });
    await writeFile(
      path.join(this.root, reportRelativePath),
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    this.settings.set("legacy_migration_last_report", report);
    return report;
  }

  async backup(options: { confirmed: boolean }): Promise<LegacyBackupReport> {
    if (!options.confirmed) {
      throw new Error("备份旧机器 Markdown 需要显式 confirmed=true");
    }
    const migrationReport = this.settings.get<LegacyMigrationReport>(
      "legacy_migration_last_report"
    );
    if (!migrationReport) {
      throw new Error("备份前必须先完成旧工作区导入并检查迁移报告");
    }
    if (
      migrationReport.counts.failed > 0 ||
      migrationReport.counts.conflict > 0
    ) {
      throw new Error("迁移报告仍有失败或冲突，禁止移动旧机器 Markdown");
    }
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const backupDirectory = `.context/legacy-backups/${timestamp}`;
    const moved: string[] = [];
    const skipped: string[] = [];
    for (const relativePath of [
      ...LEGACY_DIRECTORIES,
      ...LEGACY_CONFIG_FILES
    ]) {
      const source = path.join(this.root, relativePath);
      if (!(await exists(source))) {
        skipped.push(relativePath);
        continue;
      }
      const target = path.join(this.root, backupDirectory, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(source, target);
      moved.push(relativePath);
    }
    const report = { backupDirectory, moved, skipped };
    await writeFile(
      path.join(this.root, backupDirectory, "backup-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    return report;
  }

  private async importFile(
    sourcePath: string,
    targetKind: string
  ): Promise<LegacyMigrationItem> {
    try {
      const document = await this.store.read(sourcePath);
      const existing = this.database.connection
        .prepare(
          `SELECT source_etag, status
           FROM legacy_imports
           WHERE source_path = ?`
        )
        .get(sourcePath) as
        | { source_etag: string; status: LegacyMigrationItem["status"] }
        | undefined;
      if (
        existing?.source_etag === document.etag &&
        existing.status === "imported"
      ) {
        return {
          sourcePath,
          targetKind,
          targetId: null,
          status: "skipped",
          error: null
        };
      }
      const targetId = this.importDocument(targetKind, document.data, document.body);
      this.recordImport({
        sourcePath,
        targetKind,
        targetId,
        status: "imported",
        error: null
      }, document.etag);
      return {
        sourcePath,
        targetKind,
        targetId,
        status: "imported",
        error: null
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordImport({
        sourcePath,
        targetKind,
        targetId: null,
        status: "failed",
        error: message
      }, "unreadable");
      return {
        sourcePath,
        targetKind,
        targetId: null,
        status: "failed",
        error: message
      };
    }
  }

  private importDocument(
    targetKind: string,
    data: BaseMetadata,
    body: string
  ): string | null {
    if (targetKind === "source") return this.importSource(data, body);
    if (targetKind === "analysis_run") return this.importAnalysisRun(data);
    if (targetKind === "candidate") return this.importCandidate(data, body);
    if (targetKind === "sync") return this.importSync(data);
    if (targetKind === "config") return this.importConfig(data);
    return data.id;
  }

  private importSource(data: BaseMetadata, body: string): string {
    if (data.type !== "source") {
      throw new Error(`旧来源文档类型错误：${data.type}`);
    }
    const source = data as SourceMetadata;
    const record: NormalizedSourceRecord = {
      sourceId: source.id,
      provider: "lark",
      kind: source.source_kind,
      title: source.title,
      text: body,
      occurredAt: source.occurred_at,
      participants: Array.isArray(source.participants)
        ? source.participants
        : [],
      metadata: source.provider_metadata ?? {}
    };
    this.context.upsertSource(record, source.updated_at);
    return source.id;
  }

  private ensureLegacyRun(
    runId: string,
    sourceRefs: string[],
    data: Record<string, unknown>
  ): void {
    const jobId = `legacy_job_${runId}`;
    const status = data.status === "succeeded" ? "succeeded" : "failed_terminal";
    this.database.connection
      .prepare(
        `INSERT INTO analysis_jobs(
           id, idempotency_key, source_ids_json, status, available_at,
           attempts, max_attempts, config_json, last_error_code,
           last_error_message, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, 1, '{}', ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(
        jobId,
        `legacy:${runId}`,
        encodeJson(sourceRefs),
        status,
        stringValue(data, "started_at", stringValue(data, "created_at", new Date().toISOString())),
        typeof data.error_code === "string" ? data.error_code : null,
        typeof data.error_message === "string" ? data.error_message : null,
        stringValue(data, "created_at", new Date().toISOString()),
        stringValue(data, "updated_at", new Date().toISOString())
      );
    this.database.connection
      .prepare(
        `INSERT INTO analysis_runs(
           id, job_id, status, provider, model, prompt_version,
           schema_version, config_hash, event_types_json, usage_json,
           error_code, error_message, started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(
        runId,
        jobId,
        data.status === "succeeded" ? "succeeded" : "failed",
        stringValue(data, "provider", "legacy"),
        typeof data.model === "string" ? data.model : null,
        stringValue(data, "prompt_version", "legacy"),
        stringValue(data, "output_schema_version", "legacy"),
        stringValue(data, "config_hash", "legacy"),
        encodeJson(stringArray(data.event_types)),
        data.usage && typeof data.usage === "object"
          ? encodeJson(data.usage)
          : null,
        typeof data.error_code === "string" ? data.error_code : null,
        typeof data.error_message === "string" ? data.error_message : null,
        stringValue(data, "started_at", stringValue(data, "created_at", new Date().toISOString())),
        typeof data.completed_at === "string"
          ? data.completed_at
          : stringValue(data, "updated_at", new Date().toISOString())
      );
  }

  private importAnalysisRun(data: BaseMetadata): string {
    if (data.type !== "analysis-run") {
      throw new Error(`旧分析运行文档类型错误：${data.type}`);
    }
    this.ensureLegacyRun(data.id, data.source_refs, data);
    return data.id;
  }

  private importCandidate(data: BaseMetadata, body: string): string {
    if (data.type !== "candidate") {
      throw new Error(`旧候选文档类型错误：${data.type}`);
    }
    const analysis =
      data.analysis && typeof data.analysis === "object"
        ? data.analysis
        : null;
    const runId =
      analysis && typeof analysis.run_id === "string"
        ? analysis.run_id
        : stableId("legacy_candidate_run", data.id);
    this.ensureLegacyRun(runId, data.source_refs, {
      ...data,
      status: "succeeded",
      provider: analysis?.provider ?? "legacy",
      prompt_version: analysis?.prompt_version ?? "legacy",
      output_schema_version: analysis?.schema_version ?? "legacy",
      started_at: analysis?.analyzed_at ?? data.created_at,
      completed_at: analysis?.analyzed_at ?? data.updated_at
    });
    const kind = "knowledge_kind" in data ? "knowledge" : "todo";
    const candidateData =
      kind === "knowledge"
        ? {
            knowledge_kind: data.knowledge_kind,
            summary: body,
            tags: Array.isArray(data.tags) ? data.tags : []
          }
        : {
            status: data.status,
            direction: data.direction,
            due_at: data.due_at,
            explicit: data.explicit,
            stakeholders: Array.isArray(data.stakeholders)
              ? data.stakeholders
              : []
          };
    this.database.connection
      .prepare(
        `INSERT INTO analysis_candidates(
           id, run_id, stable_key, kind, status, title, data_json,
           source_refs_json, confidence, reason, created_at
         ) VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           data_json = excluded.data_json,
           source_refs_json = excluded.source_refs_json,
           confidence = excluded.confidence,
           reason = excluded.reason`
      )
      .run(
        data.id,
        runId,
        analysis && typeof analysis.item_key === "string"
          ? analysis.item_key
          : data.id,
        kind,
        data.title,
        encodeJson(candidateData),
        encodeJson(data.source_refs),
        typeof data.confidence === "number" ? data.confidence : 0,
        analysis && typeof analysis.reason === "string"
          ? analysis.reason
          : "从旧 Markdown 候选导入",
        data.created_at
      );
    const quotes =
      analysis && Array.isArray(analysis.evidence)
        ? analysis.evidence.filter(
            (quote): quote is string => typeof quote === "string"
          )
        : [];
    const insertEvidence = this.database.connection.prepare(
      `INSERT OR IGNORE INTO candidate_evidence(
         candidate_id, source_id, quote, position
       ) VALUES (?, ?, ?, ?)`
    );
    quotes.forEach((quote, position) => {
      const sourceId = data.source_refs[position] ?? data.source_refs[0];
      if (
        sourceId &&
        this.database.connection
          .prepare("SELECT 1 FROM sources WHERE id = ?")
          .get(sourceId)
      ) {
        insertEvidence.run(data.id, sourceId, quote, position);
      }
    });
    return data.id;
  }

  private importSync(data: BaseMetadata): string {
    const checkpoints =
      data.source_checkpoints &&
      typeof data.source_checkpoints === "object" &&
      !Array.isArray(data.source_checkpoints)
        ? (data.source_checkpoints as Record<string, unknown>)
        : {};
    for (const [source, cursor] of Object.entries(checkpoints)) {
      if (typeof cursor === "string") this.sync.setCursor(source, cursor);
    }
    if (data.id !== "sync_lark_status") return data.id;
    const status = data as BaseMetadata & Partial<SyncStatus>;
    const runId = stableId("legacy_sync", {
      startedAt: status.started_at,
      completedAt: status.completed_at
    });
    if (!this.database.connection.prepare("SELECT 1 FROM sync_runs WHERE id = ?").get(runId)) {
      this.sync.startRun(runId, status.started_at ?? data.created_at);
      for (const result of status.results ?? []) {
        this.sync.saveSourceResult(runId, result);
      }
      const failed = (status.results ?? []).some((result) => !result.ok);
      this.sync.finishRun(
        runId,
        status.last_error ? "failed" : failed ? "partial" : "succeeded",
        status.last_error ?? null,
        status.completed_at ?? data.updated_at
      );
    }
    return runId;
  }

  private importConfig(data: BaseMetadata): string {
    if (data.id === "config_analysis") {
      if (!this.settings.get("analysis_config")) {
        const keys = [
          "provider",
          "model",
          "reasoning_effort",
          "timeout_ms",
          "max_source_chars",
          "max_batch_records",
          "max_batch_source_chars",
          "max_output_bytes",
          "prompt_version",
          "retain_runs",
          "max_reanalysis_records"
        ];
        const imported = Object.fromEntries(
          keys.flatMap((key) =>
            data[key] === undefined ? [] : [[key, data[key]]]
          )
        );
        if (
          imported.prompt_version === "context-analysis@1" ||
          imported.prompt_version === "context-analysis@2" ||
          imported.prompt_version === "context-analysis@3"
        ) {
          imported.prompt_version = "context-analysis@4";
        }
        this.settings.set("analysis_config", imported);
      }
    } else if (data.id === "config_workspace") {
      if (typeof data.timezone === "string") {
        this.settings.set("workspace_timezone", data.timezone);
      }
      if (typeof data.source_retention_days === "number") {
        this.settings.set("source_retention_days", data.source_retention_days);
      }
    } else if (data.id === "config_priority_people") {
      this.settings.set(
        "leaders",
        Array.isArray(data.leaders) ? data.leaders : []
      );
    } else if (data.id === "config_policies") {
      this.settings.set("privacy_policies", data);
    } else if (data.id === "config_source_lark") {
      this.settings.set("lark_source_config", data);
    }
    return data.id;
  }

  private recordImport(
    item: Omit<LegacyMigrationItem, "sourcePath"> & { sourcePath: string },
    sourceEtag: string
  ): void {
    this.database.connection
      .prepare(
        `INSERT INTO legacy_imports(
           source_path, source_etag, target_kind, target_id,
           status, error, imported_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_path) DO UPDATE SET
           source_etag = excluded.source_etag,
           target_kind = excluded.target_kind,
           target_id = excluded.target_id,
           status = excluded.status,
           error = excluded.error,
           imported_at = excluded.imported_at`
      )
      .run(
        item.sourcePath,
        sourceEtag,
        item.targetKind,
        item.targetId,
        item.status,
        item.error,
        new Date().toISOString()
      );
  }
}

import { randomUUID } from "node:crypto";
import { AnalysisCoordinator } from "../../analysis/coordinator";
import { ContextIndex } from "../../core/index";
import type { BaseMetadata } from "../../core/types";
import {
  EMPTY_SYNC_STATUS,
  type NormalizedSourceRecord,
  type PersonMetadata,
  type SourceMetadata,
  type SyncSourceResult,
  type SyncStatus,
  type WorkspaceDocument,
  nowIso
} from "../../core/types";
import { discoverPeople } from "../../core/people";
import { MarkdownStore } from "../../core/markdown-store";
import { nullLogger, withLogContext, type Logger } from "../../logging";
import { LarkAdapter, type LarkSyncSource, splitWindows } from "./adapter";
import { sourceKindDirectory } from "./normalize";

interface CheckpointData extends BaseMetadata {
  source_checkpoints: Record<string, { last_success_at: string }>;
  last_completed_at: string | null;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 140);
}

function sourcePath(record: NormalizedSourceRecord): string {
  const id = safeSegment(record.sourceId);
  const date = record.occurredAt.slice(0, 10);
  const directory = sourceKindDirectory(record.kind);
  if (record.kind === "mention") {
    const [year, month] = date.split("-");
    return `sources/lark/${directory}/${year}/${month}/${id}.md`;
  }
  if (record.kind === "p2p") {
    const partner = record.participants.find((entry) => entry.role === "partner")?.provider_id ?? "unknown";
    return `sources/lark/${directory}/${safeSegment(partner)}/${date}-${id}.md`;
  }
  return `sources/lark/${directory}/${id}.md`;
}

function sourceMetadata(record: NormalizedSourceRecord): SourceMetadata {
  const timestamp = nowIso();
  return {
    schema: "work-context/source@1",
    id: record.sourceId,
    type: "source",
    title: record.title,
    managed: "generated",
    created_at: timestamp,
    updated_at: timestamp,
    source_refs: [],
    provider: record.provider,
    source_kind: record.kind,
    source_id: record.sourceId,
    occurred_at: record.occurredAt,
    participants: record.participants,
    provider_metadata: record.metadata
  };
}

function sourceBody(record: NormalizedSourceRecord): string {
  const participants = record.participants.map((entry) => entry.name).filter(Boolean).join(", ");
  return [
    `# ${record.title}`,
    "",
    participants ? `**Participants:** ${participants}` : "",
    `**Occurred:** ${record.occurredAt}`,
    "",
    record.text || "_No text content._"
  ]
    .filter((line, index, lines) => line || lines[index - 1] !== "")
    .join("\n");
}

export interface SyncOptions {
  backfillDays?: number;
  overlapMinutes?: number;
  windowDays?: number;
  now?: Date;
}

export class LarkSyncService {
  private status: SyncStatus = { ...EMPTY_SYNC_STATUS };

  constructor(
    private readonly store: MarkdownStore,
    private readonly index: ContextIndex,
    private readonly adapter: LarkAdapter,
    private readonly analysis: AnalysisCoordinator,
    logger: Logger = nullLogger
  ) {
    this.logger = logger.child({ component: "lark-sync" });
  }

  private readonly logger: Logger;

  getStatus(): SyncStatus {
    return this.status;
  }

  async loadStatus(): Promise<SyncStatus> {
    try {
      const document = await this.store.read(".context/sync/lark-status.md");
      this.status = {
        running: Boolean(document.data.running),
        started_at: typeof document.data.started_at === "string" ? document.data.started_at : null,
        completed_at:
          typeof document.data.completed_at === "string" ? document.data.completed_at : null,
        results: Array.isArray(document.data.results)
          ? (document.data.results as unknown as SyncSourceResult[])
          : [],
        last_error: typeof document.data.last_error === "string" ? document.data.last_error : null
      };
    } catch {
      this.status = { ...EMPTY_SYNC_STATUS };
    }
    return this.status;
  }

  async sync(options: SyncOptions = {}): Promise<SyncStatus> {
    const syncId = `sync_${randomUUID()}`;
    return withLogContext({ sync_id: syncId }, async () => {
      const started = process.hrtime.bigint();
      try {
        return await this.executeSync(options);
      } catch (error) {
        this.logger.error("lark.sync.failed", {
          duration_ms:
            Math.round(
              (Number(process.hrtime.bigint() - started) / 1_000_000) * 100
            ) / 100,
          error
        });
        if (this.status.running) {
          this.status = {
            ...this.status,
            running: false,
            completed_at: nowIso(),
            last_error: "飞书同步因未预期错误中止，请查看结构化日志。"
          };
          try {
            await this.persistStatus();
          } catch (persistenceError) {
            this.logger.error("lark.sync.status.persist.failed", {
              error: persistenceError
            });
          }
        }
        throw error;
      }
    });
  }

  private async executeSync(options: SyncOptions): Promise<SyncStatus> {
    if (this.status.running) throw new Error("A Lark synchronization is already running");
    const syncStarted = process.hrtime.bigint();
    const now = options.now ?? new Date();
    const backfillDays = options.backfillDays ?? 30;
    const overlapMinutes = options.overlapMinutes ?? 10;
    const windowDays = options.windowDays ?? 7;
    this.status = {
      running: true,
      started_at: nowIso(),
      completed_at: null,
      results: [],
      last_error: null
    };
    this.logger.info("lark.sync.started", {
      backfill_days: backfillDays,
      overlap_minutes: overlapMinutes,
      window_days: windowDays,
      source_count: 5
    });
    await this.persistStatus();

    const checkpoint = await this.readCheckpoint();
    const sources: LarkSyncSource[] = ["self", "mentions", "p2p", "calendar", "tasks"];
    const results: SyncSourceResult[] = [];
    const recordsForAnalysis: NormalizedSourceRecord[] = [];
    const sourceByRecordId = new Map<string, LarkSyncSource>();

    for (const source of sources) {
      const sourceStarted = process.hrtime.bigint();
      const previous = checkpoint.data.source_checkpoints[source]?.last_success_at;
      const defaultStart = new Date(now.getTime() - backfillDays * 24 * 60 * 60 * 1000);
      const start = previous
        ? new Date(new Date(previous).getTime() - overlapMinutes * 60 * 1000)
        : defaultStart;
      const windows =
        source === "mentions" || source === "p2p" || source === "calendar"
          ? splitWindows(start, now, windowDays)
          : [{ start, end: now }];
      this.logger.info("lark.sync.source.started", {
        source,
        window_count: windows.length,
        has_checkpoint: Boolean(previous)
      });
      let sourceResult: SyncSourceResult = {
        source,
        ok: true,
        received: 0,
        persisted: 0,
        completed_at: now.toISOString()
      };

      for (const [windowIndex, window] of windows.entries()) {
        const windowStarted = process.hrtime.bigint();
        this.logger.info("lark.sync.window.started", {
          source,
          window_index: windowIndex,
          start_at: window.start.toISOString(),
          end_at: window.end.toISOString()
        });
        const fetched = await this.adapter.fetchSource(source, window.start, window.end);
        sourceResult.received += fetched.result.received;
        if (!fetched.result.ok) {
          sourceResult = {
            ...sourceResult,
            ok: false,
            error: fetched.result.error,
            ...(fetched.result.issue ? { issue: fetched.result.issue } : {}),
            completed_at: undefined
          };
          this.logger.warn("lark.sync.window.failed", {
            source,
            window_index: windowIndex,
            start_at: window.start.toISOString(),
            end_at: window.end.toISOString(),
            duration_ms:
              Math.round(
                (Number(process.hrtime.bigint() - windowStarted) / 1_000_000) *
                  100
              ) / 100,
            issue_kind: fetched.result.issue?.kind,
            issue_code: fetched.result.issue?.code,
            log_id: fetched.result.issue?.log_id,
            requires_action: fetched.result.issue?.requires_action ?? false,
            error_message: fetched.result.error
          });
          break;
        }
        for (const record of fetched.records) {
          sourceResult.persisted += await this.persistRecord(record);
          recordsForAnalysis.push(record);
          sourceByRecordId.set(record.sourceId, source);
        }
        this.logger.info("lark.sync.window.completed", {
          source,
          window_index: windowIndex,
          start_at: window.start.toISOString(),
          end_at: window.end.toISOString(),
          received: fetched.result.received,
          persisted_total: sourceResult.persisted,
          duration_ms:
            Math.round(
              (Number(process.hrtime.bigint() - windowStarted) / 1_000_000) *
                100
            ) / 100
        });
      }

      if (sourceResult.ok) {
        checkpoint.data.source_checkpoints[source] = { last_success_at: now.toISOString() };
      }
      results.push(sourceResult);
      const sourceFields = {
        source,
        ok: sourceResult.ok,
        received: sourceResult.received,
        persisted: sourceResult.persisted,
        window_count: windows.length,
        duration_ms:
          Math.round(
            (Number(process.hrtime.bigint() - sourceStarted) / 1_000_000) * 100
          ) / 100
      };
      if (sourceResult.ok) {
        this.logger.info("lark.sync.source.completed", sourceFields);
      } else {
        this.logger.warn("lark.sync.source.completed", {
          ...sourceFields,
          issue_kind: sourceResult.issue?.kind,
          issue_code: sourceResult.issue?.code,
          requires_action: sourceResult.issue?.requires_action ?? false
        });
      }
    }

    await this.index.rebuild(this.store);
    this.logger.info("lark.sync.analysis.started", {
      record_count: recordsForAnalysis.length,
      message_count: recordsForAnalysis.filter(
        ({ kind }) => kind === "mention" || kind === "p2p"
      ).length,
      task_count: recordsForAnalysis.filter(({ kind }) => kind === "task")
        .length
    });
    try {
      const analysis = await this.analysis.analyzeRecords(recordsForAnalysis);
      for (const recordResult of analysis.results) {
        if (recordResult.outcome === "not_applicable") continue;
        const source = sourceByRecordId.get(recordResult.source_id);
        const sourceResult = results.find((result) => result.source === source);
        if (!sourceResult) continue;
        if (recordResult.outcome === "failed") {
          sourceResult.analysis_failed =
            (sourceResult.analysis_failed ?? 0) + 1;
        } else {
          sourceResult.analyzed = (sourceResult.analyzed ?? 0) + 1;
        }
      }
      const analysisFields = {
        requested: analysis.requested,
        succeeded: analysis.succeeded,
        failed: analysis.failed,
        batch_count: analysis.batches,
        written: analysis.written
      };
      if (analysis.failed) {
        this.logger.warn("lark.sync.analysis.completed", analysisFields);
      } else {
        this.logger.info("lark.sync.analysis.completed", analysisFields);
      }
    } catch (error) {
      this.logger.error("lark.sync.analysis.failed", {
        record_count: recordsForAnalysis.length,
        error
      });
      for (const record of recordsForAnalysis) {
        if (record.kind !== "mention" && record.kind !== "p2p") continue;
        const source = sourceByRecordId.get(record.sourceId);
        const sourceResult = results.find((result) => result.source === source);
        if (sourceResult) {
          sourceResult.analysis_failed =
            (sourceResult.analysis_failed ?? 0) + 1;
        }
      }
    }

    if (results.every((result) => result.ok)) {
      checkpoint.data.last_completed_at = now.toISOString();
    }
    checkpoint.data.updated_at = nowIso();
    await this.store.write(checkpoint.path, checkpoint.data, checkpoint.body, {
      expectedEtag: checkpoint.etag
    });

    this.status = {
      running: false,
      started_at: this.status.started_at,
      completed_at: nowIso(),
      results,
      last_error: (() => {
        const failed = results.filter((result) => !result.ok);
        if (!failed.length) return null;
        const actionable = failed.find((result) => result.issue?.requires_action);
        if (actionable) {
          return `飞书同步需要人工处理：${actionable.source} - ${actionable.error ?? "权限或认证失败"}`;
        }
        return `飞书同步存在失败来源：${failed.map(({ source }) => source).join("、")}；成功来源已保留。`;
      })()
    };
    await this.persistStatus();
    await this.index.rebuild(this.store);
    const totalReceived = results.reduce(
      (sum, result) => sum + result.received,
      0
    );
    const totalPersisted = results.reduce(
      (sum, result) => sum + result.persisted,
      0
    );
    const failedSources = results.filter((result) => !result.ok).length;
    const completedFields = {
      ok: failedSources === 0,
      source_count: results.length,
      failed_source_count: failedSources,
      received: totalReceived,
      persisted: totalPersisted,
      analyzed: results.reduce(
        (sum, result) => sum + (result.analyzed ?? 0),
        0
      ),
      analysis_failed: results.reduce(
        (sum, result) => sum + (result.analysis_failed ?? 0),
        0
      ),
      duration_ms:
        Math.round(
          (Number(process.hrtime.bigint() - syncStarted) / 1_000_000) * 100
        ) / 100
    };
    if (failedSources) {
      this.logger.warn("lark.sync.completed", completedFields);
    } else {
      this.logger.info("lark.sync.completed", completedFields);
    }
    return this.status;
  }

  private async readCheckpoint(): Promise<WorkspaceDocument<CheckpointData>> {
    return this.store.read<CheckpointData>(".context/sync/lark.md");
  }

  private async persistStatus(): Promise<void> {
    const existing = await this.store.read(".context/sync/lark-status.md");
    await this.store.write(
      existing.path,
      {
        ...existing.data,
        updated_at: nowIso(),
        ...this.status
      },
      "",
      { expectedEtag: existing.etag }
    );
  }

  private async persistRecord(record: NormalizedSourceRecord): Promise<number> {
    const relativePath = sourcePath(record);
    const exists = await this.store.exists(relativePath);
    if (exists) {
      const existing = await this.store.read(relativePath);
      await this.store.write(
        relativePath,
        {
          ...sourceMetadata(record),
          created_at: existing.data.created_at
        },
        sourceBody(record),
        { expectedEtag: existing.etag }
      );
    } else {
      await this.store.write(relativePath, sourceMetadata(record), sourceBody(record), {
        createOnly: true
      });
    }

    await this.persistPeople(record);
    return exists ? 0 : 1;
  }

  private async persistPeople(record: NormalizedSourceRecord): Promise<void> {
    for (const person of discoverPeople([record])) {
      const relativePath = `people/${safeSegment(person.id)}.md`;
      if (await this.store.exists(relativePath)) {
        const existing = await this.store.read<PersonMetadata>(relativePath);
        const identities = [...existing.data.identities];
        for (const identity of person.identities) {
          if (
            !identities.some(
              (entry) =>
                entry.provider === identity.provider && entry.external_id === identity.external_id
            )
          ) {
            identities.push(identity);
          }
        }
        await this.store.write(
          relativePath,
          {
            ...person,
            ...existing.data,
            identities,
            title: existing.data.title || person.title,
            last_interaction_at:
              !existing.data.last_interaction_at ||
              existing.data.last_interaction_at < record.occurredAt
                ? record.occurredAt
                : existing.data.last_interaction_at,
            source_refs: [...new Set([...existing.data.source_refs, record.sourceId])],
            updated_at: nowIso()
          },
          existing.body,
          { expectedEtag: existing.etag }
        );
      } else {
        await this.store.write(relativePath, person, "# Profile\n", { createOnly: true });
      }
    }
  }

}

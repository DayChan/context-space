import { randomUUID } from "node:crypto";
import type { PersistentAnalysisJobConfig } from "../../analysis/persistent-processor";
import { analysisJobIdempotencyKey } from "../../analysis/persistent-processor";
import type { NormalizedSourceRecord } from "../../core/types";
import { personIdForIdentity } from "../../core/people";
import {
  EMPTY_SYNC_STATUS,
  type SyncProgress,
  type SyncSourceResult,
  type SyncStatus,
  nowIso
} from "../../core/types";
import {
  AnalysisJobRepository,
  MachineContextRepository,
  MachineDatabase,
  SyncRepository
} from "../../machine";
import { hashStableValue } from "../../analysis/run-store";
import { nullLogger, withLogContext, type Logger } from "../../logging";
import { LarkAdapter, type LarkSyncSource, splitWindows } from "./adapter";

const DEFAULT_MAX_MESSAGE_PAGES_PER_WINDOW = 200;

function isMessageSource(
  source: LarkSyncSource
): source is "mentions" | "p2p" {
  return source === "mentions" || source === "p2p";
}

function isAnalyzable(
  record: NormalizedSourceRecord
): boolean {
  return record.kind === "mention" || record.kind === "p2p";
}

export interface SyncOptions {
  backfillDays?: number;
  overlapMinutes?: number;
  windowDays?: number;
  maxMessagePagesPerWindow?: number;
  now?: Date;
}

export class LarkSyncService {
  private status: SyncStatus = { ...EMPTY_SYNC_STATUS };
  private readonly logger: Logger;

  constructor(
    private readonly database: MachineDatabase,
    private readonly context: MachineContextRepository,
    private readonly syncRepository: SyncRepository,
    private readonly jobs: AnalysisJobRepository,
    private readonly adapter: LarkAdapter,
    private readonly getAnalysisJobConfig: () => Promise<PersistentAnalysisJobConfig>,
    logger: Logger = nullLogger
  ) {
    this.logger = logger.child({ component: "lark-sync" });
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  async loadStatus(): Promise<SyncStatus> {
    const latest = this.syncRepository.latestRun();
    if (!latest) {
      this.status = { ...EMPTY_SYNC_STATUS };
      return this.status;
    }
    if (latest.status === "running") {
      this.syncRepository.finishRun(
        latest.id,
        "failed",
        "上一次飞书同步因服务退出而中断，请重新同步。"
      );
    }
    this.status = {
      running: false,
      started_at: latest.startedAt,
      completed_at: latest.completedAt,
      results: latest.results,
      last_error:
        latest.status === "running"
          ? "上一次飞书同步因服务退出而中断，请重新同步。"
          : latest.error,
      progress: {
        phase:
          latest.status === "succeeded"
            ? "completed"
            : "failed",
        source: null,
        window_index: null,
        window_count: null,
        page_index: null,
        received: latest.results.reduce(
          (sum, result) => sum + result.received,
          0
        ),
        persisted: latest.results.reduce(
          (sum, result) => sum + result.persisted,
          0
        ),
        message:
          latest.status === "succeeded"
            ? "同步已完成"
            : latest.error ?? "同步未完成",
        updated_at: nowIso()
      }
    };
    return this.status;
  }

  async sync(options: SyncOptions = {}): Promise<SyncStatus> {
    if (this.status.running) {
      throw new Error("A Lark synchronization is already running");
    }
    this.status = {
      running: true,
      started_at: nowIso(),
      completed_at: null,
      results: [],
      last_error: null,
      progress: {
        phase: "collecting",
        source: null,
        window_index: null,
        window_count: null,
        page_index: null,
        received: 0,
        persisted: 0,
        message: "正在准备飞书只读同步",
        updated_at: nowIso()
      }
    };
    const syncId = `sync_${randomUUID()}`;
    return withLogContext({ sync_id: syncId }, async () => {
      const started = process.hrtime.bigint();
      let runStarted = false;
      try {
        this.syncRepository.startRun(syncId);
        runStarted = true;
        const status = await this.executeSync(syncId, options);
        this.syncRepository.finishRun(
          syncId,
          status.results.some(({ ok }) => !ok) ? "partial" : "succeeded",
          status.last_error
        );
        return status;
      } catch (error) {
        const message = "飞书同步因未预期错误中止，请查看结构化日志。";
        if (runStarted) {
          this.syncRepository.finishRun(syncId, "failed", message);
        }
        this.status = {
          ...this.status,
          running: false,
          completed_at: nowIso(),
          last_error: message,
          progress: {
            ...(this.status.progress ?? {
              source: null,
              window_index: null,
              window_count: null,
              page_index: null,
              received: 0,
              persisted: 0
            }),
            phase: "failed",
            message: "同步因未预期错误中止",
            updated_at: nowIso()
          }
        };
        this.logger.error("lark.sync.failed", {
          duration_ms:
            Math.round(
              (Number(process.hrtime.bigint() - started) / 1_000_000) * 100
            ) / 100,
          error
        });
        throw error;
      }
    });
  }

  private async executeSync(
    syncId: string,
    options: SyncOptions
  ): Promise<SyncStatus> {
    const syncStarted = process.hrtime.bigint();
    const now = options.now ?? new Date();
    const backfillDays = options.backfillDays ?? 30;
    const overlapMinutes = options.overlapMinutes ?? 10;
    const windowDays = options.windowDays ?? 7;
    const maxMessagePagesPerWindow =
      options.maxMessagePagesPerWindow ??
      DEFAULT_MAX_MESSAGE_PAGES_PER_WINDOW;
    if (
      !Number.isInteger(maxMessagePagesPerWindow) ||
      maxMessagePagesPerWindow < 1
    ) {
      throw new Error("maxMessagePagesPerWindow must be a positive integer");
    }
    let analysisConfig = await this.getAnalysisJobConfig();
    this.status = {
      running: true,
      started_at: nowIso(),
      completed_at: null,
      results: [],
      last_error: null,
      progress: {
        phase: "collecting",
        source: null,
        window_index: null,
        window_count: null,
        page_index: null,
        received: 0,
        persisted: 0,
        message: "正在准备飞书只读同步",
        updated_at: nowIso()
      }
    };
    this.logger.info("lark.sync.started", {
      backfill_days: backfillDays,
      overlap_minutes: overlapMinutes,
      window_days: windowDays,
      max_message_pages_per_window: maxMessagePagesPerWindow,
      source_count: 5
    });

    const sources: LarkSyncSource[] = [
      "self",
      "mentions",
      "p2p",
      "calendar",
      "tasks"
    ];
    const results: SyncSourceResult[] = [];

    for (const source of sources) {
      const sourceStarted = process.hrtime.bigint();
      const previous = this.syncRepository.getCursor(source);
      const defaultStart = new Date(
        now.getTime() - backfillDays * 24 * 60 * 60 * 1000
      );
      const start = previous
        ? new Date(new Date(previous).getTime() - overlapMinutes * 60 * 1000)
        : defaultStart;
      const windows =
        source === "mentions" || source === "p2p" || source === "calendar"
          ? splitWindows(start, now, windowDays)
          : [{ start, end: now }];
      let sourceResult: SyncSourceResult = {
        source,
        ok: true,
        received: 0,
        persisted: 0,
        completed_at: now.toISOString()
      };
      this.updateProgress({
        phase: "collecting",
        source,
        window_index: 0,
        window_count: windows.length,
        page_index: 0,
        received: 0,
        persisted: 0,
        message: `正在同步 ${source}`
      });

      for (const [windowIndex, window] of windows.entries()) {
        let pageToken: string | undefined;
        let pageIndex = 0;
        const seenPageTokens = new Set<string>();
        let windowFailure:
          | { error: string; issue?: SyncSourceResult["issue"] }
          | undefined;
        this.logger.info("lark.sync.window.started", {
          source,
          window_index: windowIndex,
          start_at: window.start.toISOString(),
          end_at: window.end.toISOString()
        });

        while (true) {
          this.updateProgress({
            phase: "collecting",
            source,
            window_index: windowIndex,
            window_count: windows.length,
            page_index: pageIndex,
            received: sourceResult.received,
            persisted: sourceResult.persisted,
            message: `正在读取 ${source} 第 ${windowIndex + 1}/${windows.length} 个窗口，第 ${pageIndex + 1} 页`
          });
          const fetched = await this.adapter.fetchSource(
            source,
            window.start,
            window.end,
            pageToken
          );
          sourceResult.received += fetched.result.received;
          if (!fetched.result.ok) {
            windowFailure = {
              error: fetched.result.error ?? "飞书来源页面读取失败",
              ...(fetched.result.issue ? { issue: fetched.result.issue } : {})
            };
            break;
          }

          if (source === "self") {
            const identity = fetched.records[0]?.participants[0]?.provider_id;
            if (identity) {
              analysisConfig = {
                ...analysisConfig,
                currentUserId: personIdForIdentity("lark", identity)
              };
            }
          }

          const persisted = this.persistPage(fetched.records, analysisConfig);
          sourceResult.persisted += persisted;
          this.logger.info("lark.sync.page.completed", {
            source,
            window_index: windowIndex,
            page_index: pageIndex,
            received: fetched.result.received,
            persisted_total: sourceResult.persisted,
            has_more: fetched.pagination.hasMore
          });
          this.updateProgress({
            phase: "collecting",
            source,
            window_index: windowIndex,
            window_count: windows.length,
            page_index: pageIndex,
            received: sourceResult.received,
            persisted: sourceResult.persisted,
            message: `已提交 ${source} 第 ${pageIndex + 1} 页`
          });

          if (!isMessageSource(source) || !fetched.pagination.hasMore) break;
          const nextPageToken = fetched.pagination.nextPageToken;
          if (!nextPageToken) {
            windowFailure = {
              error:
                "飞书消息分页未完成：上游声明存在下一页，但未返回有效 page_token。"
            };
          } else if (
            nextPageToken === pageToken ||
            seenPageTokens.has(nextPageToken)
          ) {
            windowFailure = {
              error: "飞书消息分页未完成：上游返回了重复的 page_token。"
            };
          } else if (pageIndex + 1 >= maxMessagePagesPerWindow) {
            windowFailure = {
              error: `飞书消息分页未完成：窗口达到 ${maxMessagePagesPerWindow} 页安全上限后仍有下一页。`
            };
          }
          if (windowFailure) break;
          seenPageTokens.add(nextPageToken!);
          pageToken = nextPageToken;
          pageIndex += 1;
        }

        if (windowFailure) {
          sourceResult = {
            ...sourceResult,
            ok: false,
            error: windowFailure.error,
            ...(windowFailure.issue ? { issue: windowFailure.issue } : {}),
            completed_at: undefined
          };
          this.logger.warn("lark.sync.window.failed", {
            source,
            window_index: windowIndex,
            issue_kind: windowFailure.issue?.kind,
            issue_code: windowFailure.issue?.code,
            requires_action: windowFailure.issue?.requires_action ?? false,
            error_message: windowFailure.error
          });
          break;
        }
      }

      this.database.transaction(() => {
        if (sourceResult.ok) {
          this.syncRepository.setCursor(source, now.toISOString());
        }
        this.syncRepository.saveSourceResult(syncId, sourceResult);
      });
      results.push(sourceResult);
      this.status = { ...this.status, results: [...results] };
      this.logger.info("lark.sync.source.completed", {
        source,
        ok: sourceResult.ok,
        received: sourceResult.received,
        persisted: sourceResult.persisted,
        window_count: windows.length,
        duration_ms:
          Math.round(
            (Number(process.hrtime.bigint() - sourceStarted) / 1_000_000) * 100
          ) / 100
      });
    }

    const failed = results.filter(({ ok }) => !ok);
    this.status = {
      running: false,
      started_at: this.status.started_at,
      completed_at: nowIso(),
      results,
      last_error: (() => {
        if (!failed.length) return null;
        const actionable = failed.find(
          ({ issue }) => issue?.requires_action
        );
        return actionable
          ? `飞书同步需要人工处理：${actionable.source} - ${actionable.error ?? "权限或认证失败"}`
          : `飞书同步存在失败来源：${failed
              .map(({ source }) => source)
              .join("、")}；成功来源已保留。`;
      })(),
      progress: {
        phase: failed.length ? "failed" : "completed",
        source: null,
        window_index: null,
        window_count: null,
        page_index: null,
        received: results.reduce((sum, result) => sum + result.received, 0),
        persisted: results.reduce((sum, result) => sum + result.persisted, 0),
        message: failed.length
          ? "同步完成，但存在失败来源"
          : "同步已完成，分析任务已加入队列",
        updated_at: nowIso()
      }
    };
    const progress = this.status.progress;
    this.logger.info("lark.sync.completed", {
      ok: failed.length === 0,
      source_count: results.length,
      failed_source_count: failed.length,
      received: progress?.received ?? 0,
      persisted: progress?.persisted ?? 0,
      analysis_queue: this.jobs.counts(),
      duration_ms:
        Math.round(
          (Number(process.hrtime.bigint() - syncStarted) / 1_000_000) * 100
        ) / 100
    });
    return this.status;
  }

  private persistPage(
    records: NormalizedSourceRecord[],
    config: PersistentAnalysisJobConfig
  ): number {
    return this.database.transaction(() => {
      let inserted = 0;
      const analyzable: NormalizedSourceRecord[] = [];
      for (const record of records) {
        const result = this.context.upsertSource(record);
        if (result.inserted) inserted += 1;
        if (isAnalyzable(record)) analyzable.push(record);
      }
      if (analyzable.length) {
        const sourceIds = analyzable.map(({ sourceId }) => sourceId);
        const sourceHash = hashStableValue(
          analyzable.map(({ sourceId, text }) => ({ sourceId, text }))
        );
        this.jobs.enqueue({
          idempotencyKey: analysisJobIdempotencyKey({
            sourceIds,
            sourceHash,
            config
          }),
          sourceIds,
          config: config as unknown as Record<string, unknown>
        });
      }
      return inserted;
    });
  }

  private updateProgress(
    update: Partial<SyncProgress> & Pick<SyncProgress, "phase" | "message">
  ): void {
    const previous = this.status.progress;
    this.status = {
      ...this.status,
      progress: {
        phase: update.phase,
        source:
          "source" in update ? update.source ?? null : previous?.source ?? null,
        window_index:
          "window_index" in update
            ? update.window_index ?? null
            : previous?.window_index ?? null,
        window_count:
          "window_count" in update
            ? update.window_count ?? null
            : previous?.window_count ?? null,
        page_index:
          "page_index" in update
            ? update.page_index ?? null
            : previous?.page_index ?? null,
        received: update.received ?? previous?.received ?? 0,
        persisted: update.persisted ?? previous?.persisted ?? 0,
        message: update.message,
        updated_at: nowIso()
      }
    };
  }
}

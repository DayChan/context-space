import { randomUUID } from "node:crypto";
import type { PersistentAnalysisJobConfig } from "../../analysis/persistent-processor";
import { analysisJobIdempotencyKey } from "../../analysis/persistent-processor";
import type { NormalizedSourceRecord } from "../../core/types";
import { personIdForIdentity } from "../../core/people";
import {
  EMPTY_SYNC_STATUS,
  type LarkPermissionPreflight,
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
import {
  LarkPermissionPreflightError,
  type LarkPermissionChecker
} from "./permissions";

const DEFAULT_MAX_MESSAGE_PAGES_PER_WINDOW = 200;
const DEFAULT_BACKFILL_DAYS = 1;
const DEFAULT_RECONCILIATION_HOURS = 1;
const DEFAULT_WINDOW_DAYS = 7;
const HOUR_MILLISECONDS = 60 * 60 * 1_000;
const CALENDAR_HORIZON_HOURS = 24;

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
  reconciliationHours?: number;
  windowDays?: number;
  maxMessagePagesPerWindow?: number;
  now?: Date;
}

export type DefaultSyncOptions = Omit<SyncOptions, "now">;

function positiveInteger(
  value: number,
  name: string
): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function environmentInteger(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: number
): number {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return positiveInteger(Number(raw), key);
}

export function syncOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv
): DefaultSyncOptions {
  return {
    backfillDays: environmentInteger(
      environment,
      "CONTEXT_SPACE_BACKFILL_DAYS",
      DEFAULT_BACKFILL_DAYS
    ),
    reconciliationHours: environmentInteger(
      environment,
      "CONTEXT_SPACE_RECONCILIATION_HOURS",
      DEFAULT_RECONCILIATION_HOURS
    )
  };
}

export function synchronizationStart(input: {
  previousCursor: string | null;
  now: Date;
  backfillDays: number;
  reconciliationHours: number;
}): Date {
  const incrementalStart = input.previousCursor
    ? new Date(input.previousCursor)
    : new Date(
        input.now.getTime() - input.backfillDays * 24 * HOUR_MILLISECONDS
      );
  if (Number.isNaN(incrementalStart.getTime())) {
    throw new Error(`Invalid synchronization cursor: ${input.previousCursor}`);
  }
  const reconciliationStart = new Date(
    input.now.getTime() - input.reconciliationHours * HOUR_MILLISECONDS
  );
  return new Date(
    Math.min(incrementalStart.getTime(), reconciliationStart.getTime())
  );
}

export class LarkSyncService {
  private status: SyncStatus = { ...EMPTY_SYNC_STATUS };
  private permissionPreflight: LarkPermissionPreflight | null = null;
  private readonly logger: Logger;

  constructor(
    private readonly database: MachineDatabase,
    private readonly context: MachineContextRepository,
    private readonly syncRepository: SyncRepository,
    private readonly jobs: AnalysisJobRepository,
    private readonly adapter: LarkAdapter,
    private readonly permissionChecker: LarkPermissionChecker,
    private readonly getAnalysisJobConfig: () => Promise<PersistentAnalysisJobConfig>,
    logger: Logger = nullLogger,
    private readonly defaultOptions: DefaultSyncOptions = {}
  ) {
    this.logger = logger.child({ component: "lark-sync" });
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  getPermissionPreflight(): LarkPermissionPreflight | null {
    return this.permissionPreflight;
  }

  async checkPermissions(): Promise<LarkPermissionPreflight> {
    const checked = await this.permissionChecker.check();
    this.permissionPreflight = {
      ...checked,
      initial_sync_completed: this.syncRepository.hasSuccessfulRun()
    };
    this.logger.info("lark.permissions.checked", {
      state: this.permissionPreflight.state,
      ready: this.permissionPreflight.ready,
      initial_sync_completed: this.permissionPreflight.initial_sync_completed,
      granted_scope_count: this.permissionPreflight.granted_scopes.length,
      missing_scopes: this.permissionPreflight.missing_scopes
    });
    return this.permissionPreflight;
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
    const preflight = await this.checkPermissions();
    if (!preflight.ready && !preflight.initial_sync_completed) {
      this.logger.warn("lark.sync.preflight.blocked", {
        state: preflight.state,
        missing_scopes: preflight.missing_scopes
      });
      throw new LarkPermissionPreflightError(preflight);
    }
    if (!preflight.ready) {
      this.logger.warn("lark.sync.preflight.warning", {
        state: preflight.state,
        missing_scopes: preflight.missing_scopes
      });
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
    const backfillDays = positiveInteger(
      options.backfillDays ??
        this.defaultOptions.backfillDays ??
        DEFAULT_BACKFILL_DAYS,
      "backfillDays"
    );
    const reconciliationHours = positiveInteger(
      options.reconciliationHours ??
        this.defaultOptions.reconciliationHours ??
        DEFAULT_RECONCILIATION_HOURS,
      "reconciliationHours"
    );
    const windowDays = positiveInteger(
      options.windowDays ??
        this.defaultOptions.windowDays ??
        DEFAULT_WINDOW_DAYS,
      "windowDays"
    );
    const maxMessagePagesPerWindow =
      options.maxMessagePagesPerWindow ??
      this.defaultOptions.maxMessagePagesPerWindow ??
      DEFAULT_MAX_MESSAGE_PAGES_PER_WINDOW;
    positiveInteger(
      maxMessagePagesPerWindow,
      "maxMessagePagesPerWindow"
    );
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
      reconciliation_hours: reconciliationHours,
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
      const start =
        source === "calendar"
          ? new Date(
              now.getTime() - CALENDAR_HORIZON_HOURS * HOUR_MILLISECONDS
            )
          : synchronizationStart({
              previousCursor: previous,
              now,
              backfillDays,
              reconciliationHours
            });
      const end =
        source === "calendar"
          ? new Date(
              now.getTime() + CALENDAR_HORIZON_HOURS * HOUR_MILLISECONDS
            )
          : now;
      const windows =
        source === "mentions" || source === "p2p"
          ? splitWindows(start, end, windowDays)
          : [{ start, end }];
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
      if (sourceResult.issue?.kind === "installation") break;
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
      let persisted = 0;
      const analyzable: NormalizedSourceRecord[] = [];
      for (const record of records) {
        const result = this.context.upsertSource(record);
        if (result.changed) persisted += 1;
        if (result.changed && isAnalyzable(record)) analyzable.push(record);
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
      return persisted;
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

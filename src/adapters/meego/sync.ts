import type { MeegoSyncResult, MeegoSyncStatus } from "../../core/types";
import { MachineContextRepository } from "../../machine";
import { nullLogger, type Logger } from "../../logging";
import { MeegoConfigService } from "./config";
import { MeegoAdapter, type MeegoProject, type MeegoWorkItemType } from "./adapter";

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(values[index]);
      }
    })
  );
  return results;
}

export class MeegoSyncService {
  private status: MeegoSyncStatus = {
    enabled: false,
    running: false,
    startedAt: null,
    completedAt: null,
    results: [],
    lastError: null
  };
  private readonly logger: Logger;

  constructor(
    private readonly context: MachineContextRepository,
    private readonly config: MeegoConfigService,
    private readonly adapter: MeegoAdapter,
    logger: Logger = nullLogger
  ) {
    this.logger = logger.child({ component: "meego-sync" });
    this.status.enabled = config.get().enabled;
  }

  getStatus(): MeegoSyncStatus {
    return { ...this.status, enabled: this.config.get().enabled };
  }

  async sync(): Promise<MeegoSyncStatus> {
    if (this.status.running) throw new Error("Meego 同步已在运行");
    const config = this.config.get();
    if (!config.enabled) {
      this.status = { ...this.status, enabled: false, lastError: null };
      return this.getStatus();
    }
    const startedAt = new Date().toISOString();
    this.status = {
      enabled: true,
      running: true,
      startedAt,
      completedAt: null,
      results: [],
      lastError: null
    };
    try {
      if (!config.projectKeys.length) {
        throw new Error("请先在 Settings 配置至少一个 Meego project key");
      }
      await this.adapter.assertAuthenticated();
      const projectResults = await mapConcurrent(
        config.projectKeys,
        4,
        async (configuredKey): Promise<{
          project?: MeegoProject;
          types?: MeegoWorkItemType[];
          error?: MeegoSyncResult;
        }> => {
          try {
            const project = await this.adapter.resolveProject(configuredKey);
            return { project, types: await this.adapter.listTypes(project.projectKey) };
          } catch (error) {
            return {
              error: {
                projectKey: configuredKey,
                workItemType: null,
                ok: false,
                received: 0,
                persisted: 0,
                error: error instanceof Error ? error.message : String(error),
                completedAt: new Date().toISOString()
              }
            };
          }
        }
      );
      const scopes = projectResults.flatMap(({ project, types, error }) => {
        if (error) {
          this.status.results.push(error);
          return [];
        }
        return types!.map((type) => ({ project: project!, type }));
      });
      const scopeResults = await mapConcurrent(scopes, 4, async ({ project, type }) => {
        const base: MeegoSyncResult = {
          projectKey: project.projectKey,
          workItemType: type.apiName,
          ok: false,
          received: 0,
          persisted: 0
        };
        try {
          if (type.disabled) {
            return {
              ...base,
              ok: true,
              skipped: true,
              message: "工作项类型已停用",
              completedAt: new Date().toISOString()
            };
          }
          const fields = await this.adapter.listFieldKeys(project.projectKey, type.key);
          const missingCore = ["work_item_id", "name", "updated_at"].filter(
            (key) => !fields.has(key)
          );
          if (missingCore.length) {
            return {
              ...base,
              ok: true,
              skipped: true,
              message: `不是可同步的普通工作项，缺少字段: ${missingCore.join(", ")}`,
              completedAt: new Date().toISOString()
            };
          }
          if (config.qTagTimelineEnabled && !fields.has("tags")) {
            return {
              ...base,
              ok: true,
              skipped: true,
              message: "Q 标签模式要求工作项类型提供 tags 字段",
              completedAt: new Date().toISOString()
            };
          }
          const records = await this.adapter.queryParticipating(project, type, {
            includeTags: fields.has("tags"),
            completionField:
              ["finish_status", "archiving_status", "finish_time"].find(
                (key) => fields.has(key)
              ) ?? null
          });
          let persisted = 0;
          for (const record of records) {
            if (this.context.upsertSource(record).changed) persisted += 1;
          }
          return {
            ...base,
            ok: true,
            received: records.length,
            persisted,
            completedAt: new Date().toISOString()
          };
        } catch (error) {
          return {
            ...base,
            error: error instanceof Error ? error.message : String(error),
            completedAt: new Date().toISOString()
          };
        }
      });
      this.status.results.push(...scopeResults);
      const failures = this.status.results.filter(({ ok }) => !ok);
      const skipped = this.status.results.filter((result) => result.skipped);
      this.status.lastError = failures.length
        ? `${failures.length} 个 Meego 项目或类型同步失败`
        : null;
      this.logger.info("meego.sync.completed", {
        project_count: config.projectKeys.length,
        scope_count: this.status.results.length,
        failure_count: failures.length,
        skipped_count: skipped.length
      });
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error("meego.sync.failed", { error });
    } finally {
      this.status.running = false;
      this.status.completedAt = new Date().toISOString();
    }
    return this.getStatus();
  }
}

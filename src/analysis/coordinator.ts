import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextIndex } from "../core/index";
import { MarkdownStore } from "../core/markdown-store";
import { personIdForIdentity } from "../core/people";
import type {
  NormalizedSourceRecord,
  SourceMetadata,
  WorkspaceDocument
} from "../core/types";
import {
  nullLogger,
  withLogContext,
  type Logger
} from "../logging";
import { buildAnalysisBatches } from "./batch";
import {
  AnalysisProviderError,
  type AnalysisConfig,
  type AnalysisErrorCode,
  type AnalysisExecutionResult
} from "./contracts";
import { AnalysisConfigService } from "./config";
import { buildAnalysisPrompt, ANALYSIS_PROMPT_VERSION } from "./prompt";
import { AnalysisProviderRegistry } from "./providers/registry";
import {
  analysisRunId,
  AnalysisRunStore,
  hashStableValue
} from "./run-store";
import { analysisJsonSchema, ANALYSIS_SCHEMA_VERSION } from "./schema";
import {
  AnalysisValidationError,
  parseAndValidateAnalysis
} from "./validation";
import { DerivedDocumentWriter } from "./writer";

export interface AnalyzeOptions {
  force?: boolean;
  signal?: AbortSignal;
}

export interface ReanalysisResult {
  requested: number;
  succeeded: number;
  failed: number;
  batches: number;
  written: number;
  results: Array<{
    source_id: string;
    outcome: AnalysisExecutionResult["outcome"] | "failed";
    run_id?: string;
    error?: string;
  }>;
}

function sourceTextFromBody(body: string): string {
  const lines = body.split(/\r?\n/);
  const occurred = lines.findIndex((line) => line.startsWith("**Occurred:**"));
  const content = occurred >= 0 ? lines.slice(occurred + 1) : lines.slice(1);
  while (content[0] === "") content.shift();
  const text = content.join("\n").trim();
  return text === "_No text content._" ? "" : text;
}

export function normalizedRecordFromDocument(
  document: WorkspaceDocument<SourceMetadata>
): NormalizedSourceRecord {
  return {
    sourceId: document.data.source_id,
    provider: document.data.provider,
    kind: document.data.source_kind,
    title: document.data.title,
    text: sourceTextFromBody(document.body),
    occurredAt: document.data.occurred_at,
    participants: document.data.participants,
    metadata: document.data.provider_metadata
  };
}

function failureCode(error: unknown): AnalysisErrorCode {
  if (error instanceof AnalysisProviderError) return error.code;
  if (error instanceof AnalysisValidationError) return "invalid_output";
  const message = error instanceof Error ? error.message : String(error);
  if (/未注册的分析 Provider/.test(message)) return "configuration_error";
  if (/Prompt|prompt/i.test(message)) return "unsupported_prompt";
  return "provider_failed";
}

function safeFailureMessage(error: unknown): string {
  if (
    error instanceof AnalysisProviderError &&
    error.code === "tool_activity"
  ) {
    return error.message;
  }
  const summaries: Record<AnalysisErrorCode, string> = {
    provider_unavailable: "所选分析 Provider 不可用",
    authentication_failed: "所选分析 Provider 认证失败",
    timeout: "分析调用超时",
    cancelled: "分析调用已取消",
    output_too_large: "Provider 输出超过安全大小限制",
    provider_failed: "所选分析 Provider 调用失败",
    tool_activity: "Provider 产生了不允许的工具事件",
    invalid_output: "Provider 返回结果未通过结构或领域校验",
    unsupported_prompt: "工作区配置了不受支持的 Prompt 版本",
    configuration_error: "分析 Provider 配置无效"
  };
  return summaries[failureCode(error)];
}

export class AnalysisCoordinator {
  readonly runStore: AnalysisRunStore;
  readonly writer: DerivedDocumentWriter;
  private currentUserId = "self";

  constructor(
    private readonly store: MarkdownStore,
    private readonly index: ContextIndex,
    private readonly registry: AnalysisProviderRegistry,
    private readonly configService: AnalysisConfigService,
    logger: Logger = nullLogger
  ) {
    this.logger = logger.child({ component: "analysis" });
    this.runStore = new AnalysisRunStore(store);
    this.writer = new DerivedDocumentWriter(store, index);
    const currentUserSource = index
      .all<SourceMetadata>()
      .find(
        (document) =>
          document.data.type === "source" &&
          document.data.source_kind === "person"
      );
    const identity = currentUserSource?.data.participants[0]?.provider_id;
    if (identity) {
      this.currentUserId = personIdForIdentity(
        currentUserSource.data.provider,
        identity
      );
    }
  }

  private readonly logger: Logger;

  async analyze(
    record: NormalizedSourceRecord,
    options: AnalyzeOptions = {}
  ): Promise<AnalysisExecutionResult> {
    if (record.kind === "person") {
      this.rememberCurrentUser(record);
      return { run: null, outcome: "not_applicable", written: 0 };
    }
    if (record.kind === "task") {
      return {
        run: null,
        outcome: "succeeded",
        written: await this.writer.writeNativeTask(record)
      };
    }
    if (record.kind !== "mention" && record.kind !== "p2p") {
      return { run: null, outcome: "not_applicable", written: 0 };
    }
    const { config, timezone } = await this.analysisSnapshot();
    return this.executeMessageBatch([record], config, timezone, options);
  }

  async analyzeRecords(
    input: NormalizedSourceRecord[],
    options: AnalyzeOptions = {}
  ): Promise<ReanalysisResult> {
    const unique = new Map<string, NormalizedSourceRecord>();
    for (const record of input) unique.set(record.sourceId, record);
    const records = [...unique.values()];
    for (const record of records.filter(({ kind }) => kind === "person")) {
      this.rememberCurrentUser(record);
    }

    const resultBySource = new Map<string, ReanalysisResult["results"][number]>();
    let written = 0;
    for (const record of records) {
      if (record.kind === "person" || record.kind === "calendar") {
        resultBySource.set(record.sourceId, {
          source_id: record.sourceId,
          outcome: "not_applicable"
        });
      } else if (record.kind === "task") {
        try {
          written += await this.writer.writeNativeTask(record);
          resultBySource.set(record.sourceId, {
            source_id: record.sourceId,
            outcome: "succeeded"
          });
        } catch (error) {
          resultBySource.set(record.sourceId, {
            source_id: record.sourceId,
            outcome: "failed",
            error: safeFailureMessage(error)
          });
        }
      }
    }

    const messageRecords = records.filter(
      ({ kind }) => kind === "mention" || kind === "p2p"
    );
    let batches = 0;
    if (messageRecords.length) {
      const { config, timezone } = await this.analysisSnapshot();
      const messageBatches = buildAnalysisBatches(messageRecords, {
        maxRecords: config.max_batch_records,
        maxSourceCharacters: config.max_source_chars,
        maxBatchSourceCharacters: config.max_batch_source_chars
      });
      batches = messageBatches.length;
      this.logger.info("analysis.batches.created", {
        message_count: messageRecords.length,
        batch_count: batches,
        max_batch_records: config.max_batch_records,
        max_batch_source_characters: config.max_batch_source_chars
      });
      for (const batch of messageBatches) {
        try {
          const result = await this.executeMessageBatch(
            batch.records,
            config,
            timezone,
            options
          );
          written += result.written;
          for (const record of batch.records) {
            resultBySource.set(record.sourceId, {
              source_id: record.sourceId,
              outcome: result.outcome,
              ...(result.run ? { run_id: result.run.id } : {})
            });
          }
        } catch (error) {
          for (const record of batch.records) {
            resultBySource.set(record.sourceId, {
              source_id: record.sourceId,
              outcome: "failed",
              error: safeFailureMessage(error)
            });
          }
        }
      }
    }

    const results = records.map(
      (record) =>
        resultBySource.get(record.sourceId) ?? {
          source_id: record.sourceId,
          outcome: "not_applicable" as const
        }
    );
    const summary = {
      requested: records.length,
      succeeded: results.filter(({ outcome }) => outcome !== "failed").length,
      failed: results.filter(({ outcome }) => outcome === "failed").length,
      batches,
      written,
      results
    };
    const summaryFields = {
      requested: summary.requested,
      succeeded: summary.succeeded,
      failed: summary.failed,
      batch_count: summary.batches,
      written: summary.written
    };
    if (summary.failed) {
      this.logger.warn("analysis.records.completed", summaryFields);
    } else {
      this.logger.info("analysis.records.completed", summaryFields);
    }
    return summary;
  }

  async reanalyzeSource(
    sourceId: string,
    signal?: AbortSignal
  ): Promise<ReanalysisResult> {
    const document = this.index.byId<SourceMetadata>(sourceId);
    if (!document || document.data.type !== "source") {
      throw new Error(`来源不存在：${sourceId}`);
    }
    return this.reanalyzeDocuments([document], signal);
  }

  async reanalyzeRange(
    from: string,
    to: string,
    requestedLimit?: number,
    signal?: AbortSignal
  ): Promise<ReanalysisResult> {
    const config = (await this.configService.getEffective()).config;
    const limit = Math.min(
      requestedLimit ?? config.max_reanalysis_records,
      config.max_reanalysis_records
    );
    const fromTime = Date.parse(from);
    const toTime = Date.parse(to);
    const documents = this.index
      .all<SourceMetadata>()
      .filter(
        (document) =>
          document.data.type === "source" &&
          ["mention", "p2p"].includes(document.data.source_kind) &&
          Date.parse(document.data.occurred_at) >= fromTime &&
          Date.parse(document.data.occurred_at) <= toTime
      )
      .sort((left, right) =>
        left.data.occurred_at.localeCompare(right.data.occurred_at)
      )
      .slice(0, limit);
    return this.reanalyzeDocuments(documents, signal);
  }

  private rememberCurrentUser(record: NormalizedSourceRecord): void {
    const identity = record.participants[0]?.provider_id;
    if (identity) {
      this.currentUserId = personIdForIdentity(record.provider, identity);
    }
  }

  private async analysisSnapshot(): Promise<{
    config: AnalysisConfig;
    timezone: string;
  }> {
    const effective = await this.configService.getEffective();
    const config = { ...effective.config };
    if (config.prompt_version !== ANALYSIS_PROMPT_VERSION) {
      throw new AnalysisProviderError(
        "unsupported_prompt",
        `不支持的 Prompt 版本：${config.prompt_version}`,
        false
      );
    }
    const workspaceConfig = await this.store.read("config/workspace.md");
    const timezone =
      typeof workspaceConfig.data.timezone === "string"
        ? workspaceConfig.data.timezone
        : "Asia/Shanghai";
    return { config, timezone };
  }

  private async executeMessageBatch(
    records: NormalizedSourceRecord[],
    config: AnalysisConfig,
    timezone: string,
    options: AnalyzeOptions
  ): Promise<AnalysisExecutionResult> {
    const sourceIds = records.map(({ sourceId }) => sourceId);
    const prompt = buildAnalysisPrompt(records, {
      currentUserId: this.currentUserId,
      timezone,
      maxSourceChars: config.max_source_chars
    });
    const sourceHash = hashStableValue(records);
    const configHash = hashStableValue({
      provider: config.provider,
      model: config.model,
      timeout_ms: config.timeout_ms,
      max_source_chars: config.max_source_chars,
      max_batch_records: config.max_batch_records,
      max_batch_source_chars: config.max_batch_source_chars,
      max_output_bytes: config.max_output_bytes
    });
    const identity = {
      sourceIds,
      sourceHash,
      provider: config.provider,
      model: config.model,
      promptVersion: config.prompt_version,
      outputSchemaVersion: ANALYSIS_SCHEMA_VERSION,
      configHash
    };
    const runId = analysisRunId(identity);
    return withLogContext(
      { run_id: runId, batch_id: runId },
      async () => {
        const sourceCharacters = records.reduce(
          (sum, record) =>
            sum +
            Math.min(
              Array.from(record.text).length,
              config.max_source_chars
            ),
          0
        );
        const batchStarted = process.hrtime.bigint();
        const existing = await this.runStore.get(runId);
        if (existing?.data.status === "succeeded" && !options.force) {
          this.logger.info("analysis.batch.skipped", {
            source_count: records.length,
            source_characters: sourceCharacters,
            provider: config.provider,
            model: config.model,
            reason: "existing_success"
          });
          return { run: existing.data, outcome: "skipped", written: 0 };
        }

        this.logger.info("analysis.batch.started", {
          source_count: records.length,
          source_characters: sourceCharacters,
          provider: config.provider,
          model: config.model,
          prompt_version: config.prompt_version,
          force: Boolean(options.force)
        });
        let run;
        try {
          run = await this.runStore.start({
            ...identity,
            runId,
            promptHash: prompt.hash
          });
        } catch (error) {
          this.logger.error("analysis.run.start.failed", { error });
          throw error;
        }
        let eventTypes: string[] = [];
        let temporaryDirectory: string | null = null;
        try {
          const provider = this.registry.get(config.provider);
          const availability = await provider.getAvailability();
          this.logger.info("analysis.provider.availability.checked", {
            provider: config.provider,
            available: availability.available,
            version: availability.version
          });
          if (!availability.available) {
            throw new AnalysisProviderError(
              "provider_unavailable",
              availability.detail
            );
          }
          temporaryDirectory = await mkdtemp(
            path.join(os.tmpdir(), "context-space-analysis-")
          );
          const providerStarted = process.hrtime.bigint();
          this.logger.info("analysis.provider.started", {
            provider: config.provider,
            model: config.model,
            timeout_ms: config.timeout_ms,
            source_count: records.length,
            source_characters: sourceCharacters
          });
          const response = await provider.analyze(
            {
              runId,
              prompt: prompt.text,
              outputSchema: analysisJsonSchema,
              workingDirectory: temporaryDirectory,
              model: config.model,
              timeoutMs: config.timeout_ms,
              maxOutputBytes: config.max_output_bytes
            },
            options.signal ?? new AbortController().signal
          );
          eventTypes = response.eventTypes;
          this.logger.info("analysis.provider.completed", {
            provider: config.provider,
            model: response.model,
            duration_ms:
              Math.round(
                (Number(process.hrtime.bigint() - providerStarted) /
                  1_000_000) *
                  100
              ) / 100,
            output_bytes: Buffer.byteLength(response.finalResponse, "utf8"),
            event_types: response.eventTypes,
            usage: response.usage
          });
          if (response.diagnostic?.trim()) {
            this.logger.warn("analysis.provider.diagnostic", {
              provider: config.provider,
              diagnostic: response.diagnostic
            });
          }
          const output = parseAndValidateAnalysis(
            response.finalResponse,
            records,
            prompt
          );
          this.logger.info("analysis.output.validated", {
            item_count: output.items.length,
            person_insight_count: output.person_insights.length
          });
          run = await this.runStore.succeed(
            runId,
            {
              model: response.model,
              usage: response.usage,
              eventTypes: response.eventTypes,
              resultCount: output.items.length + output.person_insights.length
            },
            config.retain_runs
          );
          const written = await this.writer.write(records, output, run);
          this.logger.info("analysis.documents.written", {
            written,
            result_count: output.items.length + output.person_insights.length
          });
          this.logger.info("analysis.batch.completed", {
            outcome: "succeeded",
            written,
            duration_ms:
              Math.round(
                (Number(process.hrtime.bigint() - batchStarted) / 1_000_000) *
                  100
              ) / 100
          });
          return { run, outcome: "succeeded", written };
        } catch (error) {
          const failureEvents =
            error instanceof AnalysisProviderError && error.eventTypes.length
              ? error.eventTypes
              : eventTypes;
          try {
            await this.runStore.fail(
              runId,
              failureCode(error),
              safeFailureMessage(error),
              failureEvents,
              config.retain_runs
            );
          } catch (persistenceError) {
            this.logger.error("analysis.run.failure.persist.failed", {
              error: persistenceError
            });
          }
          this.logger.error("analysis.batch.failed", {
            error_code: failureCode(error),
            event_types: failureEvents,
            duration_ms:
              Math.round(
                (Number(process.hrtime.bigint() - batchStarted) / 1_000_000) *
                  100
              ) / 100,
            error
          });
          throw error;
        } finally {
          if (temporaryDirectory) {
            try {
              await rm(temporaryDirectory, { recursive: true, force: true });
            } catch (error) {
              this.logger.warn("analysis.temp.cleanup.failed", { error });
            }
          }
        }
      }
    );
  }

  private async reanalyzeDocuments(
    documents: Array<WorkspaceDocument<SourceMetadata>>,
    signal?: AbortSignal
  ): Promise<ReanalysisResult> {
    return this.analyzeRecords(documents.map(normalizedRecordFromDocument), {
      force: true,
      signal
    });
  }
}

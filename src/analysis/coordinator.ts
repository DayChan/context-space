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
  AnalysisProviderError,
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
import { AnalysisValidationError, parseAndValidateAnalysis } from "./validation";
import { DerivedDocumentWriter } from "./writer";

export interface AnalyzeOptions {
  force?: boolean;
  signal?: AbortSignal;
}

export interface ReanalysisResult {
  requested: number;
  succeeded: number;
  failed: number;
  results: Array<{
    source_id: string;
    outcome: AnalysisExecutionResult["outcome"] | "failed";
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
  if (/Prompt|prompt/i.test(message)) {
    return "unsupported_prompt";
  }
  return "provider_failed";
}

function safeFailureMessage(error: unknown): string {
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
    private readonly configService: AnalysisConfigService
  ) {
    this.runStore = new AnalysisRunStore(store);
    this.writer = new DerivedDocumentWriter(store, index);
    const currentUserSource = index
      .all<SourceMetadata>()
      .find(
        (document) =>
          document.data.type === "source" && document.data.source_kind === "person"
      );
    const identity = currentUserSource?.data.participants[0]?.provider_id;
    if (identity) {
      this.currentUserId = personIdForIdentity(
        currentUserSource.data.provider,
        identity
      );
    }
  }

  async analyze(
    record: NormalizedSourceRecord,
    options: AnalyzeOptions = {}
  ): Promise<AnalysisExecutionResult> {
    if (record.kind === "person") {
      const identity = record.participants[0]?.provider_id;
      if (identity) {
        this.currentUserId = personIdForIdentity(record.provider, identity);
      }
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
    const prompt = buildAnalysisPrompt(record, {
      currentUserId: this.currentUserId,
      timezone,
      maxSourceChars: config.max_source_chars
    });
    const sourceHash = hashStableValue(record);
    const configHash = hashStableValue({
      provider: config.provider,
      model: config.model,
      timeout_ms: config.timeout_ms,
      max_source_chars: config.max_source_chars,
      max_output_bytes: config.max_output_bytes
    });
    const identity = {
      sourceId: record.sourceId,
      sourceHash,
      provider: config.provider,
      model: config.model,
      promptVersion: config.prompt_version,
      outputSchemaVersion: ANALYSIS_SCHEMA_VERSION,
      configHash
    };
    const runId = analysisRunId(identity);
    const existing = await this.runStore.get(runId);
    if (existing?.data.status === "succeeded" && !options.force) {
      return { run: existing.data, outcome: "skipped", written: 0 };
    }

    let run = await this.runStore.start({
      ...identity,
      runId,
      promptHash: prompt.hash
    });
    let eventTypes: string[] = [];
    let temporaryDirectory: string | null = null;
    try {
      const provider = this.registry.get(config.provider);
      const availability = await provider.getAvailability();
      if (!availability.available) {
        throw new AnalysisProviderError(
          "provider_unavailable",
          availability.detail
        );
      }
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "context-space-analysis-"));
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
      const output = parseAndValidateAnalysis(response.finalResponse, record, prompt);
      run = await this.runStore.succeed(
        runId,
        {
          model: response.model,
          usage: response.usage,
          eventTypes: response.eventTypes,
          resultCount: output.items.length
        },
        config.retain_runs
      );
      const written = await this.writer.write(record, output, run);
      return { run, outcome: "succeeded", written };
    } catch (error) {
      await this.runStore.fail(
        runId,
        failureCode(error),
        safeFailureMessage(error),
        eventTypes,
        config.retain_runs
      );
      throw error;
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  async reanalyzeSource(sourceId: string, signal?: AbortSignal): Promise<ReanalysisResult> {
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
    const limit = Math.min(requestedLimit ?? config.max_reanalysis_records, config.max_reanalysis_records);
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
      .sort((left, right) => left.data.occurred_at.localeCompare(right.data.occurred_at))
      .slice(0, limit);
    return this.reanalyzeDocuments(documents, signal);
  }

  private async reanalyzeDocuments(
    documents: Array<WorkspaceDocument<SourceMetadata>>,
    signal?: AbortSignal
  ): Promise<ReanalysisResult> {
    const results: ReanalysisResult["results"] = [];
    for (const document of documents) {
      try {
        const result = await this.analyze(normalizedRecordFromDocument(document), {
          force: true,
          signal
        });
        results.push({ source_id: document.data.source_id, outcome: result.outcome });
      } catch (error) {
        results.push({
          source_id: document.data.source_id,
          outcome: "failed",
          error: safeFailureMessage(error)
        });
      }
    }
    return {
      requested: documents.length,
      succeeded: results.filter(({ outcome }) => outcome !== "failed").length,
      failed: results.filter(({ outcome }) => outcome === "failed").length,
      results
    };
  }
}

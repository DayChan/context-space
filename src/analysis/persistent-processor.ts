import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NormalizedSourceRecord } from "../core/types";
import {
  AnalysisJobRepository,
  AnalysisResultRepository,
  MachineContextRepository,
  type AnalysisCandidateInput,
  type AnalysisJob
} from "../machine";
import { nullLogger, withLogContext, type Logger } from "../logging";
import { analysisConfigSchema } from "./config";
import {
  AnalysisProviderError,
  sanitizedErrorMessage,
  type AnalysisConfig,
  type AnalysisErrorCode
} from "./contracts";
import { buildAnalysisPrompt, ANALYSIS_PROMPT_VERSION } from "./prompt";
import { AnalysisProviderRegistry } from "./providers/registry";
import { hashStableValue } from "./run-store";
import {
  analysisJsonSchema,
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisOutput
} from "./schema";
import {
  AnalysisValidationError,
  analysisItemKey,
  parseAndValidateAnalysis,
  personInsightKey
} from "./validation";

export interface PersistentAnalysisJobConfig {
  analysis: AnalysisConfig;
  timezone: string;
  currentUserId: string;
}

function candidateId(runId: string, key: string): string {
  return `candidate_${createHash("sha256")
    .update(`${runId}\u0000${key}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function errorCode(error: unknown): AnalysisErrorCode {
  if (error instanceof AnalysisProviderError) return error.code;
  if (error instanceof AnalysisValidationError) return "invalid_output";
  return "provider_failed";
}

function retryable(error: unknown): boolean {
  if (error instanceof AnalysisProviderError) return error.retryable;
  return error instanceof AnalysisValidationError;
}

function jobConfig(job: AnalysisJob): PersistentAnalysisJobConfig {
  const envelope = job.config as Partial<PersistentAnalysisJobConfig>;
  const analysis = analysisConfigSchema.parse(envelope.analysis ?? job.config);
  if (analysis.prompt_version !== ANALYSIS_PROMPT_VERSION) {
    throw new AnalysisProviderError(
      "unsupported_prompt",
      `不支持的 Prompt 版本：${analysis.prompt_version}`,
      false
    );
  }
  return {
    analysis,
    timezone:
      typeof envelope.timezone === "string"
        ? envelope.timezone
        : "Asia/Shanghai",
    currentUserId:
      typeof envelope.currentUserId === "string"
        ? envelope.currentUserId
        : "self"
  };
}

function normalizedRecord(
  source: NonNullable<ReturnType<MachineContextRepository["getSource"]>>
): NormalizedSourceRecord {
  if (source.body === null) {
    throw new AnalysisProviderError(
      "configuration_error",
      `来源正文已清理，无法分析：${source.id}`,
      false
    );
  }
  return {
    sourceId: source.id,
    provider: "lark",
    kind: source.kind,
    title: source.title,
    text: source.body,
    occurredAt: source.occurredAt,
    participants: source.participants,
    metadata: source.metadata
  };
}

function outputCandidates(
  runId: string,
  output: AnalysisOutput
): AnalysisCandidateInput[] {
  const items: AnalysisCandidateInput[] = output.items.map((item) => {
    const key = analysisItemKey(item);
    return {
      id: candidateId(runId, key),
      stableKey: key,
      kind: item.kind,
      title: item.title,
      data:
        item.kind === "todo"
          ? {
              status: item.status,
              direction: item.direction,
              due_at: item.due_at,
              explicit: item.explicit,
              stakeholders: item.stakeholders
            }
          : {
              knowledge_kind: item.knowledge_kind,
              summary: item.summary,
              tags: item.tags
            },
      sourceRefs: item.source_refs,
      confidence: item.confidence,
      reason: item.reason,
      evidence: item.evidence.map(({ source_ref, quote }) => ({
        sourceId: source_ref,
        quote
      }))
    };
  });
  const insights: AnalysisCandidateInput[] = output.person_insights.map(
    (insight) => {
      const key = personInsightKey(insight);
      return {
        id: candidateId(runId, key),
        stableKey: key,
        kind: "person_insight",
        title: insight.text.slice(0, 160),
        data: {
          person_id: insight.person_id,
          category: insight.category,
          text: insight.text
        },
        sourceRefs: insight.source_refs,
        confidence: insight.confidence,
        reason: insight.reason,
        evidence: insight.evidence.map(({ source_ref, quote }) => ({
          sourceId: source_ref,
          quote
        }))
      };
    }
  );
  return [...items, ...insights];
}

export class PersistentAnalysisProcessor {
  private readonly logger: Logger;

  constructor(
    private readonly sources: MachineContextRepository,
    private readonly jobs: AnalysisJobRepository,
    private readonly results: AnalysisResultRepository,
    private readonly registry: AnalysisProviderRegistry,
    logger: Logger = nullLogger
  ) {
    this.logger = logger.child({ component: "persistent-analysis" });
  }

  async process(job: AnalysisJob, workerId: string): Promise<void> {
    const config = jobConfig(job);
    const records = job.sourceIds.map((sourceId) => {
      const source = this.sources.getSource(sourceId);
      if (!source) {
        throw new AnalysisProviderError(
          "configuration_error",
          `分析来源不存在：${sourceId}`,
          false
        );
      }
      return normalizedRecord(source);
    });
    const prompt = buildAnalysisPrompt(records, {
      currentUserId: config.currentUserId,
      timezone: config.timezone,
      maxSourceChars: config.analysis.max_source_chars
    });
    const runId = `analysis_run_${hashStableValue({
      jobId: job.id,
      attempt: job.attempts
    }).slice(0, 24)}`;
    const configHash = hashStableValue(config.analysis);

    await withLogContext({ run_id: runId, batch_id: runId }, async () => {
      this.results.beginRun({
        id: runId,
        jobId: job.id,
        provider: config.analysis.provider,
        model: config.analysis.model,
        promptVersion: config.analysis.prompt_version,
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
        configHash
      });
      let temporaryDirectory: string | null = null;
      let eventTypes: string[] = [];
      try {
        const provider = this.registry.get(config.analysis.provider);
        const availability = await provider.getAvailability();
        if (!availability.available) {
          throw new AnalysisProviderError(
            "provider_unavailable",
            availability.detail
          );
        }
        temporaryDirectory = await mkdtemp(
          path.join(os.tmpdir(), "context-space-analysis-")
        );
        const response = await provider.analyze(
          {
            runId,
            prompt: prompt.text,
            outputSchema: analysisJsonSchema,
            workingDirectory: temporaryDirectory,
            model: config.analysis.model,
            timeoutMs: config.analysis.timeout_ms,
            maxOutputBytes: config.analysis.max_output_bytes
          },
          new AbortController().signal
        );
        eventTypes = response.eventTypes;
        const output = parseAndValidateAnalysis(
          response.finalResponse,
          records,
          prompt
        );
        this.results.completeRun({
          runId,
          jobId: job.id,
          workerId,
          sourceIds: job.sourceIds,
          candidates: outputCandidates(runId, output),
          eventTypes: response.eventTypes,
          usage: response.usage
        });
        this.logger.info("analysis.job.succeeded", {
          job_id: job.id,
          candidate_count: output.items.length + output.person_insights.length
        });
      } catch (error) {
        const code = errorCode(error);
        const message = sanitizedErrorMessage(error);
        this.results.failRun({
          runId,
          errorCode: code,
          errorMessage: message,
          eventTypes
        });
        this.jobs.fail(job.id, workerId, {
          retryable: retryable(error),
          code,
          message
        });
        this.logger.error("analysis.job.failed", {
          job_id: job.id,
          error_code: code,
          error
        });
      } finally {
        if (temporaryDirectory) {
          await rm(temporaryDirectory, { recursive: true, force: true });
        }
      }
    });
  }
}

export function analysisJobIdempotencyKey(input: {
  sourceIds: string[];
  sourceHash: string;
  config: PersistentAnalysisJobConfig;
}): string {
  return hashStableValue({
    source_ids: [...input.sourceIds].sort(),
    source_hash: input.sourceHash,
    prompt_version: input.config.analysis.prompt_version,
    schema_version: ANALYSIS_SCHEMA_VERSION,
    provider: input.config.analysis.provider,
    model: input.config.analysis.model,
    config: input.config.analysis
  });
}

export function newWorkerId(): string {
  return `worker_${randomUUID()}`;
}

import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { MarkdownStore } from "../core/markdown-store";
import { nowIso, type WorkspaceDocument } from "../core/types";
import {
  sanitizedErrorMessage,
  type AnalysisErrorCode,
  type AnalysisRunMetadata,
  type AnalysisStatusMetadata,
  type AnalysisUsage
} from "./contracts";

export interface AnalysisRunIdentity {
  sourceId: string;
  sourceHash: string;
  provider: string;
  model: string | null;
  promptVersion: string;
  outputSchemaVersion: string;
  configHash: string;
}

export interface StartAnalysisRunInput extends AnalysisRunIdentity {
  runId: string;
  promptHash: string;
}

export function hashStableValue(value: unknown): string {
  function stable(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, stable(nested)])
      );
    }
    return input;
  }
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function analysisRunId(input: AnalysisRunIdentity): string {
  return `analysis_run_${hashStableValue(input).slice(0, 24)}`;
}

function runPath(runId: string): string {
  if (!/^analysis_run_[a-f0-9]{24}$/.test(runId)) throw new Error("无效的分析运行 ID");
  return `.context/analysis/runs/${runId}.md`;
}

export class AnalysisRunStore {
  constructor(private readonly store: MarkdownStore) {}

  async get(runId: string): Promise<WorkspaceDocument<AnalysisRunMetadata> | null> {
    const path = runPath(runId);
    return (await this.store.exists(path))
      ? this.store.read<AnalysisRunMetadata>(path)
      : null;
  }

  async start(input: StartAnalysisRunInput): Promise<AnalysisRunMetadata> {
    const timestamp = nowIso();
    const existing = await this.get(input.runId);
    const metadata: AnalysisRunMetadata = {
      schema: "work-context/analysis-run@1",
      id: input.runId,
      type: "analysis-run",
      title: `LLM 分析运行 ${input.runId.slice(-8)}`,
      managed: "generated",
      created_at: existing?.data.created_at ?? timestamp,
      updated_at: timestamp,
      source_refs: [input.sourceId],
      status: "running",
      source_id: input.sourceId,
      source_hash: input.sourceHash,
      provider: input.provider,
      model: input.model,
      prompt_version: input.promptVersion,
      prompt_hash: input.promptHash,
      output_schema_version: input.outputSchemaVersion,
      config_hash: input.configHash,
      attempts: (existing?.data.attempts ?? 0) + 1,
      started_at: timestamp,
      completed_at: null,
      duration_ms: null,
      usage: null,
      event_types: [],
      result_count: 0,
      error_code: null,
      error_message: null
    };
    await this.store.write(runPath(input.runId), metadata, "", {
      ...(existing ? { expectedEtag: existing.etag } : { createOnly: true })
    });
    await this.updateStatus(metadata);
    return metadata;
  }

  async succeed(
    runId: string,
    input: {
      model: string | null;
      usage: AnalysisUsage | null;
      eventTypes: string[];
      resultCount: number;
    },
    retainRuns: number
  ): Promise<AnalysisRunMetadata> {
    const run = await this.require(runId);
    const completed = nowIso();
    const metadata: AnalysisRunMetadata = {
      ...run.data,
      updated_at: completed,
      status: "succeeded",
      completed_at: completed,
      duration_ms: Math.max(0, Date.now() - new Date(run.data.started_at).getTime()),
      usage: input.usage,
      model: input.model,
      event_types: input.eventTypes,
      result_count: input.resultCount,
      error_code: null,
      error_message: null
    };
    await this.store.write(run.path, metadata, "", { expectedEtag: run.etag });
    await this.updateStatus(metadata);
    await this.retain(retainRuns);
    return metadata;
  }

  async fail(
    runId: string,
    errorCode: AnalysisErrorCode,
    error: unknown,
    eventTypes: string[],
    retainRuns: number
  ): Promise<AnalysisRunMetadata> {
    const run = await this.require(runId);
    const completed = nowIso();
    const metadata: AnalysisRunMetadata = {
      ...run.data,
      updated_at: completed,
      status: "failed",
      completed_at: completed,
      duration_ms: Math.max(0, Date.now() - new Date(run.data.started_at).getTime()),
      event_types: eventTypes,
      error_code: errorCode,
      error_message: sanitizedErrorMessage(error)
    };
    await this.store.write(run.path, metadata, "", { expectedEtag: run.etag });
    await this.updateStatus(metadata);
    await this.retain(retainRuns);
    return metadata;
  }

  async recent(limit = 10): Promise<AnalysisRunMetadata[]> {
    const entries = await readdir(this.store.resolve(".context/analysis/runs"), {
      withFileTypes: true
    });
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) =>
          this.store.read<AnalysisRunMetadata>(`.context/analysis/runs/${entry.name}`)
        )
    );
    return runs
      .map(({ data }) => data)
      .sort((left, right) => right.started_at.localeCompare(left.started_at))
      .slice(0, limit);
  }

  async status(): Promise<AnalysisStatusMetadata> {
    const document = await this.store.read<AnalysisStatusMetadata>(
      ".context/analysis/status.md"
    );
    return document.data;
  }

  private async require(runId: string): Promise<WorkspaceDocument<AnalysisRunMetadata>> {
    const run = await this.get(runId);
    if (!run) throw new Error(`分析运行不存在：${runId}`);
    return run;
  }

  private async updateStatus(run: AnalysisRunMetadata): Promise<void> {
    const status = await this.store.read<AnalysisStatusMetadata>(
      ".context/analysis/status.md"
    );
    const completed = run.completed_at ?? status.data.last_completed_at;
    await this.store.write(
      status.path,
      {
        ...status.data,
        updated_at: nowIso(),
        last_run_id: run.id,
        last_status: run.status,
        last_provider: run.provider,
        last_completed_at: completed,
        last_error_code: run.error_code,
        last_error_message: run.error_message
      },
      "",
      { expectedEtag: status.etag }
    );
  }

  private async retain(limit: number): Promise<void> {
    const entries = await readdir(this.store.resolve(".context/analysis/runs"), {
      withFileTypes: true
    });
    const paths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => `.context/analysis/runs/${entry.name}`);
    if (paths.length <= limit) return;
    const documents = await Promise.all(paths.map((path) => this.store.read(path)));
    const expired = documents
      .sort((left, right) => right.data.updated_at.localeCompare(left.data.updated_at))
      .slice(limit);
    for (const document of expired) {
      await rm(this.store.resolve(document.path), { force: true });
    }
  }
}

import type { BaseMetadata } from "../core/types";

export const BUILT_IN_ANALYSIS_PROVIDERS = ["codex-sdk", "codex-exec"] as const;
export type BuiltInAnalysisProviderId = (typeof BUILT_IN_ANALYSIS_PROVIDERS)[number];

export const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export type AnalysisRunStatus = "queued" | "running" | "succeeded" | "failed";

export type AnalysisErrorCode =
  | "provider_unavailable"
  | "authentication_failed"
  | "timeout"
  | "cancelled"
  | "output_too_large"
  | "provider_failed"
  | "tool_activity"
  | "invalid_output"
  | "unsupported_prompt"
  | "configuration_error";

export interface ProviderAvailability {
  available: boolean;
  detail: string;
  version?: string;
}

export interface AnalysisUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface ProviderAnalysisRequest {
  runId: string;
  prompt: string;
  outputSchema: unknown;
  workingDirectory: string;
  model: string | null;
  reasoningEffort: CodexReasoningEffort;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProviderAnalysisResponse {
  finalResponse: string;
  model: string | null;
  usage: AnalysisUsage | null;
  eventTypes: string[];
  diagnostic?: string;
}

export interface AnalysisProvider {
  readonly id: string;
  getAvailability(): Promise<ProviderAvailability>;
  analyze(
    request: ProviderAnalysisRequest,
    signal: AbortSignal
  ): Promise<ProviderAnalysisResponse>;
}

export interface AnalysisConfig {
  provider: string;
  model: string | null;
  reasoning_effort: CodexReasoningEffort;
  timeout_ms: number;
  max_source_chars: number;
  max_batch_records: number;
  max_batch_source_chars: number;
  max_output_bytes: number;
  prompt_version: string;
  retain_runs: number;
  max_reanalysis_records: number;
}

export interface EffectiveAnalysisConfig {
  config: AnalysisConfig;
  source: "workspace" | "environment";
  provider_locked: boolean;
}

export interface AnalysisRunMetadata extends BaseMetadata {
  type: "analysis-run";
  status: AnalysisRunStatus;
  source_id: string;
  source_ids?: string[];
  source_hash: string;
  provider: string;
  model: string | null;
  prompt_version: string;
  prompt_hash: string;
  output_schema_version: string;
  config_hash: string;
  attempts: number;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  usage: AnalysisUsage | null;
  event_types: string[];
  result_count: number;
  error_code: AnalysisErrorCode | null;
  error_message: string | null;
}

export interface AnalysisStatusMetadata extends BaseMetadata {
  type: "analysis-status";
  last_run_id: string | null;
  last_status: AnalysisRunStatus | null;
  last_provider: string | null;
  last_completed_at: string | null;
  last_error_code: AnalysisErrorCode | null;
  last_error_message: string | null;
}

export interface AnalysisExecutionResult {
  run: AnalysisRunMetadata | null;
  outcome: "succeeded" | "skipped" | "not_applicable";
  written: number;
}

export class AnalysisProviderError extends Error {
  eventTypes: string[] = [];

  constructor(
    public readonly code: AnalysisErrorCode,
    message: string,
    public readonly retryable = true,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AnalysisProviderError";
  }
}

const NON_SIDE_EFFECTING_ITEM_TYPES = new Set([
  "agent_message",
  "reasoning",
  "todo_list",
  "error"
]);

export function assertNoToolActivity(eventTypes: string[]): void {
  const disallowed = [
    ...new Set(
      eventTypes.filter((type) => !NON_SIDE_EFFECTING_ITEM_TYPES.has(type))
    )
  ];
  if (disallowed.length) {
    const error = new AnalysisProviderError(
      "tool_activity",
      `分析运行包含不允许的工具事件：${disallowed.join("、")}`,
      false
    );
    error.eventTypes = [...eventTypes];
    throw error;
  }
}

export function minimalCodexEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY"
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => {
      const value = environment[key];
      return typeof value === "string" && value ? [[key, value]] : [];
    })
  );
}

export function sanitizedErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(?:sk-|sess-|Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "[已脱敏]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

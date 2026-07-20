import { z } from "zod";
import { MarkdownStore } from "../core/markdown-store";
import { nowIso } from "../core/types";
import type { AnalysisConfig, EffectiveAnalysisConfig } from "./contracts";
import { ANALYSIS_PROMPT_VERSION } from "./prompt";

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  provider: "codex-sdk",
  model: null,
  timeout_ms: 120_000,
  max_source_chars: 20_000,
  max_batch_records: 50,
  max_batch_source_chars: 60_000,
  max_output_bytes: 2_000_000,
  prompt_version: ANALYSIS_PROMPT_VERSION,
  retain_runs: 50,
  max_reanalysis_records: 50
};

const analysisConfigObjectSchema = z
  .object({
    provider: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(200).nullable(),
    timeout_ms: z.number().int().min(1_000).max(600_000),
    max_source_chars: z.number().int().min(500).max(100_000),
    max_batch_records: z.number().int().min(1).max(500),
    max_batch_source_chars: z.number().int().min(1_000).max(500_000),
    max_output_bytes: z.number().int().min(16_384).max(10_000_000),
    prompt_version: z.literal(ANALYSIS_PROMPT_VERSION),
    retain_runs: z.number().int().min(1).max(500),
    max_reanalysis_records: z.number().int().min(1).max(500)
  })
  .strict();

export const analysisConfigSchema = analysisConfigObjectSchema.superRefine(
  (config, context) => {
    if (config.max_batch_source_chars < config.max_source_chars) {
      context.addIssue({
        code: "custom",
        path: ["max_batch_source_chars"],
        message: "整批来源字符上限不得小于单条来源字符上限"
      });
    }
  }
);

const analysisConfigUpdateSchema = analysisConfigObjectSchema.partial();

export class AnalysisConfigService {
  constructor(
    private readonly store: MarkdownStore,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  async getEffective(): Promise<EffectiveAnalysisConfig> {
    const document = await this.store.read("config/analysis.md");
    const fromWorkspace = analysisConfigSchema.parse({
      ...DEFAULT_ANALYSIS_CONFIG,
      ...Object.fromEntries(
        Object.keys(DEFAULT_ANALYSIS_CONFIG).flatMap((key) =>
          document.data[key] === undefined ? [] : [[key, document.data[key]]]
        )
      )
    });
    const override = this.environment.CONTEXT_SPACE_ANALYSIS_PROVIDER?.trim();
    return {
      config: override ? { ...fromWorkspace, provider: override } : fromWorkspace,
      source: override ? "environment" : "workspace",
      provider_locked: Boolean(override)
    };
  }

  async update(input: unknown): Promise<EffectiveAnalysisConfig> {
    const update = analysisConfigUpdateSchema.parse(input);
    const current = await this.getEffective();
    if (
      current.provider_locked &&
      update.provider !== undefined &&
      update.provider !== current.config.provider
    ) {
      throw new Error("分析 Provider 已被环境变量锁定");
    }
    const existing = await this.store.read("config/analysis.md");
    const next = analysisConfigSchema.parse({
      ...DEFAULT_ANALYSIS_CONFIG,
      ...Object.fromEntries(
        Object.keys(DEFAULT_ANALYSIS_CONFIG).flatMap((key) =>
          existing.data[key] === undefined ? [] : [[key, existing.data[key]]]
        )
      ),
      ...update
    });
    await this.store.write(
      existing.path,
      { ...existing.data, ...next, updated_at: nowIso() },
      existing.body,
      { expectedEtag: existing.etag }
    );
    return this.getEffective();
  }
}

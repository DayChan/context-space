import { z } from "zod";
import { SettingsRepository } from "../../machine";
import type { MeegoConfig } from "../../core/types";

export const DEFAULT_MEEGO_CONFIG: MeegoConfig = {
  enabled: false,
  qTagTimelineEnabled: false,
  projectKeys: []
};

export const meegoConfigSchema = z
  .object({
    enabled: z.boolean(),
    qTagTimelineEnabled: z.boolean(),
    projectKeys: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9._:-]+$/, "project key 只能包含字母、数字、点、下划线、冒号和连字符")
      )
      .max(100)
  })
  .strict();

function normalize(config: MeegoConfig): MeegoConfig {
  return {
    ...config,
    projectKeys: [...new Set(config.projectKeys.map((key) => key.trim()).filter(Boolean))]
  };
}

export class MeegoConfigService {
  constructor(private readonly settings: SettingsRepository) {}

  get(): MeegoConfig {
    const parsed = meegoConfigSchema.safeParse(
      this.settings.get<unknown>("meego_config")
    );
    return parsed.success ? normalize(parsed.data) : { ...DEFAULT_MEEGO_CONFIG };
  }

  update(input: unknown): MeegoConfig {
    const config = normalize(meegoConfigSchema.parse(input));
    this.settings.set("meego_config", config);
    return config;
  }
}

import path from "node:path";
import { LOG_LEVELS, type LoggingConfig, type LoggingConfigWarning } from "./types";

export interface LoadedLoggingConfig {
  config: LoggingConfig;
  warnings: LoggingConfigWarning[];
}

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 14;

function booleanValue(
  environment: NodeJS.ProcessEnv,
  setting: string,
  fallback: boolean,
  warnings: LoggingConfigWarning[]
): boolean {
  const raw = environment[setting];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  warnings.push({ setting, reason: "invalid_boolean" });
  return fallback;
}

function integerValue(
  environment: NodeJS.ProcessEnv,
  setting: string,
  fallback: number,
  minimum: number,
  maximum: number,
  warnings: LoggingConfigWarning[]
): number {
  const raw = environment[setting];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    warnings.push({ setting, reason: "invalid_number" });
    return fallback;
  }
  if (parsed < minimum || parsed > maximum) {
    warnings.push({ setting, reason: "out_of_range" });
    return fallback;
  }
  return parsed;
}

export function loadLoggingConfig(
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = process.env
): LoadedLoggingConfig {
  const warnings: LoggingConfigWarning[] = [];
  const testing = environment.NODE_ENV === "test" || environment.VITEST === "true";
  const rawLevel = environment.CONTEXT_SPACE_LOG_LEVEL?.trim().toLowerCase();
  const level = rawLevel && LOG_LEVELS.includes(rawLevel as LoggingConfig["level"])
    ? (rawLevel as LoggingConfig["level"])
    : "info";
  if (rawLevel && !LOG_LEVELS.includes(rawLevel as LoggingConfig["level"])) {
    warnings.push({
      setting: "CONTEXT_SPACE_LOG_LEVEL",
      reason: "invalid_level"
    });
  }

  const rawDirectory = environment.CONTEXT_SPACE_LOG_DIR;
  if (rawDirectory !== undefined && !rawDirectory.trim()) {
    warnings.push({ setting: "CONTEXT_SPACE_LOG_DIR", reason: "empty" });
  }
  const directory = rawDirectory?.trim()
    ? path.resolve(rawDirectory.trim())
    : path.join(path.resolve(workspaceRoot), ".context", "logs");

  return {
    config: {
      level,
      consoleEnabled: booleanValue(
        environment,
        "CONTEXT_SPACE_LOG_CONSOLE",
        !testing,
        warnings
      ),
      fileEnabled: booleanValue(
        environment,
        "CONTEXT_SPACE_LOG_FILE",
        !testing,
        warnings
      ),
      directory,
      maxFileBytes: integerValue(
        environment,
        "CONTEXT_SPACE_LOG_MAX_BYTES",
        DEFAULT_MAX_FILE_BYTES,
        1_024,
        1024 * 1024 * 1024,
        warnings
      ),
      retentionDays: integerValue(
        environment,
        "CONTEXT_SPACE_LOG_RETENTION_DAYS",
        DEFAULT_RETENTION_DAYS,
        1,
        3_650,
        warnings
      ),
      service: "context-space"
    },
    warnings
  };
}

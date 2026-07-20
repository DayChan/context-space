export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent"
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type EmittedLogLevel = Exclude<LogLevel, "silent">;
export type LogFields = Record<string, unknown>;

export interface LoggingConfig {
  level: LogLevel;
  consoleEnabled: boolean;
  fileEnabled: boolean;
  directory: string;
  maxFileBytes: number;
  retentionDays: number;
  service: string;
}

export interface Logger {
  readonly config: Readonly<LoggingConfig>;
  trace(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  fatal(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface LoggingConfigWarning {
  setting: string;
  reason: "invalid_boolean" | "invalid_number" | "out_of_range" | "invalid_level" | "empty";
}

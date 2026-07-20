import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import path from "node:path";
import { currentLogContext } from "./context";
import { loadLoggingConfig } from "./config";
import { redactLogString, sanitizeLogFields } from "./redaction";
import type {
  EmittedLogLevel,
  Logger,
  LogFields,
  LoggingConfig,
  LoggingConfigWarning
} from "./types";

const LEVEL_PRIORITY: Record<EmittedLogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
};

const LOG_FILE_PATTERN =
  /^context-space-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface LoggerRuntimeOptions {
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface CreateLoggerOptions extends LoggerRuntimeOptions {
  workspaceRoot: string;
  environment?: NodeJS.ProcessEnv;
}

export interface CreateConfiguredLoggerOptions extends LoggerRuntimeOptions {
  config: LoggingConfig;
  warnings?: LoggingConfigWarning[];
}

function segmentFileName(date: string, segment: number): string {
  return segment === 0
    ? `context-space-${date}.jsonl`
    : `context-space-${date}.${segment}.jsonl`;
}

class JsonlFileTarget {
  private queue: Promise<void> = Promise.resolve();
  private activeDate: string | null = null;
  private activeSegment = 0;
  private activeBytes = 0;

  constructor(
    private readonly config: LoggingConfig,
    private readonly onFailure: (error: unknown) => void
  ) {}

  enqueue(line: string, date: string): void {
    this.queue = this.queue
      .then(() => this.write(line, date))
      .catch((error) => {
        this.onFailure(error);
      });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private async write(line: string, date: string): Promise<void> {
    if (date !== this.activeDate) {
      await this.selectActiveFile(date);
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.activeBytes > 0 && this.activeBytes + bytes > this.config.maxFileBytes) {
      this.activeSegment += 1;
      this.activeBytes = await this.existingFileSize(
        segmentFileName(date, this.activeSegment)
      );
    }
    const absolute = path.join(
      this.config.directory,
      segmentFileName(date, this.activeSegment)
    );
    await appendFile(absolute, line, {
      encoding: "utf8",
      mode: 0o600
    });
    await chmod(absolute, 0o600);
    this.activeBytes += bytes;
  }

  private async selectActiveFile(date: string): Promise<void> {
    await mkdir(this.config.directory, { recursive: true, mode: 0o700 });
    await chmod(this.config.directory, 0o700);
    await this.cleanupExpired(date);
    const entries = await readdir(this.config.directory, {
      withFileTypes: true
    });
    let segment = 0;
    let found = false;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = LOG_FILE_PATTERN.exec(entry.name);
      if (!match || match[1] !== date) continue;
      segment = Math.max(segment, Number(match[2] ?? 0));
      found = true;
    }
    this.activeDate = date;
    this.activeSegment = found ? segment : 0;
    this.activeBytes = await this.existingFileSize(
      segmentFileName(date, this.activeSegment)
    );
  }

  private async existingFileSize(fileName: string): Promise<number> {
    try {
      return (await stat(path.join(this.config.directory, fileName))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  private async cleanupExpired(currentDate: string): Promise<void> {
    const entries = await readdir(this.config.directory, {
      withFileTypes: true
    });
    const current = Date.parse(`${currentDate}T00:00:00.000Z`);
    const cutoff = current - this.config.retentionDays * DAY_MS;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = LOG_FILE_PATTERN.exec(entry.name);
      if (!match) continue;
      const timestamp = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (!Number.isFinite(timestamp) || timestamp >= cutoff) continue;
      try {
        await rm(path.join(this.config.directory, entry.name), {
          force: true
        });
      } catch (error) {
        this.onFailure(error);
      }
    }
  }
}

class LoggerCore {
  private readonly fileTarget: JsonlFileTarget | null;
  private closed = false;
  private emergencyReported = false;

  constructor(
    readonly config: Readonly<LoggingConfig>,
    private readonly now: () => Date,
    private readonly stdout: (line: string) => void,
    private readonly stderr: (line: string) => void
  ) {
    this.fileTarget = config.fileEnabled
      ? new JsonlFileTarget(config, (error) => this.reportTargetFailure(error))
      : null;
  }

  emit(
    level: EmittedLogLevel,
    event: string,
    bindings: LogFields,
    fields: LogFields
  ): void {
    if (this.closed || !this.enabled(level)) return;
    const timestamp = this.now();
    let line: string;
    try {
      const safeFields = sanitizeLogFields({
        ...bindings,
        ...currentLogContext(),
        ...fields
      });
      line = `${JSON.stringify({
        ...safeFields,
        timestamp: timestamp.toISOString(),
        level,
        service: this.config.service,
        event: redactLogString(event || "logging.unnamed", 200),
        pid: process.pid
      })}\n`;
    } catch (error) {
      this.reportTargetFailure(error);
      line = `${JSON.stringify({
        timestamp: timestamp.toISOString(),
        level: "error",
        service: this.config.service,
        event: "logging.serialization.failed",
        pid: process.pid
      })}\n`;
    }

    if (this.config.consoleEnabled) {
      try {
        (level === "warn" || level === "error" || level === "fatal"
          ? this.stderr
          : this.stdout)(line);
      } catch (error) {
        this.reportTargetFailure(error);
      }
    }
    this.fileTarget?.enqueue(line, timestamp.toISOString().slice(0, 10));
  }

  async flush(): Promise<void> {
    await this.fileTarget?.flush();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private enabled(level: EmittedLogLevel): boolean {
    if (this.config.level === "silent") return false;
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.config.level];
  }

  private reportTargetFailure(error: unknown): void {
    if (this.emergencyReported) return;
    this.emergencyReported = true;
    const message = redactLogString(
      error instanceof Error ? error.message : String(error),
      500
    );
    try {
      this.stderr(
        `${JSON.stringify({
          timestamp: this.now().toISOString(),
          level: "error",
          service: this.config.service,
          event: "logging.target.failed",
          pid: process.pid,
          error: { message }
        })}\n`
      );
    } catch {
      // 日志目标全部失效时不能继续递归报告。
    }
  }
}

class StructuredLogger implements Logger {
  readonly config: Readonly<LoggingConfig>;

  constructor(
    private readonly core: LoggerCore,
    private readonly bindings: LogFields = {}
  ) {
    this.config = core.config;
  }

  trace(event: string, fields: LogFields = {}): void {
    this.core.emit("trace", event, this.bindings, fields);
  }

  debug(event: string, fields: LogFields = {}): void {
    this.core.emit("debug", event, this.bindings, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.core.emit("info", event, this.bindings, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.core.emit("warn", event, this.bindings, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.core.emit("error", event, this.bindings, fields);
  }

  fatal(event: string, fields: LogFields = {}): void {
    this.core.emit("fatal", event, this.bindings, fields);
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger(this.core, { ...this.bindings, ...fields });
  }

  flush(): Promise<void> {
    return this.core.flush();
  }

  close(): Promise<void> {
    return this.core.close();
  }
}

function defaultStdout(line: string): void {
  process.stdout.write(line);
}

function defaultStderr(line: string): void {
  process.stderr.write(line);
}

export function createConfiguredLogger(
  options: CreateConfiguredLoggerOptions
): Logger {
  const core = new LoggerCore(
    Object.freeze({ ...options.config }),
    options.now ?? (() => new Date()),
    options.stdout ?? defaultStdout,
    options.stderr ?? defaultStderr
  );
  const logger = new StructuredLogger(core);
  for (const warning of options.warnings ?? []) {
    logger.warn("logging.config.invalid", { ...warning });
  }
  return logger;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const loaded = loadLoggingConfig(
    options.workspaceRoot,
    options.environment ?? process.env
  );
  return createConfiguredLogger({
    config: loaded.config,
    warnings: loaded.warnings,
    ...(options.now ? { now: options.now } : {}),
    ...(options.stdout ? { stdout: options.stdout } : {}),
    ...(options.stderr ? { stderr: options.stderr } : {})
  });
}

const nullConfig: LoggingConfig = {
  level: "silent",
  consoleEnabled: false,
  fileEnabled: false,
  directory: "",
  maxFileBytes: 10 * 1024 * 1024,
  retentionDays: 14,
  service: "context-space"
};

export const nullLogger: Logger = createConfiguredLogger({
  config: nullConfig
});

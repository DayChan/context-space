import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nullLogger, type Logger } from "../../logging";

const execFileAsync = promisify(execFile);

const READ_ONLY_COMMANDS = new Set([
  "auth:status",
  "project:search",
  "workitem:meta-types",
  "workitem:meta-fields",
  "workitem:query"
]);

export interface MeegleCommandRunner {
  run(args: string[]): Promise<unknown>;
}

export class UnsafeMeegleCommandError extends Error {}

export class MeegleCliError extends Error {
  constructor(
    message: string,
    readonly code?: string | number,
    readonly retryable = false
  ) {
    super(message);
    this.name = "MeegleCliError";
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function parseJsonOutput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // Fall through to the safe generic error below.
      }
    }
  }
  throw new MeegleCliError("meegle 返回了无法解析的输出");
}

function errorFromPayload(payload: unknown): MeegleCliError | null {
  const root = record(payload);
  const error = record(root.error);
  if (!Object.keys(error).length) return null;
  const message =
    typeof error.message === "string" && error.message
      ? error.message
      : "meegle 命令失败";
  const code =
    typeof error.code === "string" || typeof error.code === "number"
      ? error.code
      : undefined;
  const retryable =
    error.retryable === true || /rate limit|timeout|temporar|限流|超时/i.test(message);
  return new MeegleCliError(message, code, retryable);
}

export function assertReadOnlyMeegleCommand(args: string[]): void {
  const command = `${args[0] ?? ""}:${args[1] ?? ""}`;
  if (!READ_ONLY_COMMANDS.has(command)) {
    throw new UnsafeMeegleCommandError(
      `Meegle command is not in the read-only allowlist: ${command}`
    );
  }
}

export function prepareReadOnlyMeegleArgs(args: string[]): string[] {
  assertReadOnlyMeegleCommand(args);
  const normalized = [...args];
  if (!normalized.includes("--format")) normalized.push("--format", "json");
  return normalized;
}

export class MeegleCliCommandRunner implements MeegleCommandRunner {
  private readonly logger: Logger;
  private startQueue: Promise<void> = Promise.resolve();
  private nextStartAt = 0;

  constructor(
    private readonly binary = "meegle",
    logger: Logger = nullLogger,
    private readonly minimumStartIntervalMs = 220
  ) {
    this.logger = logger.child({ component: "meegle-cli" });
  }

  private async reserveStart(): Promise<void> {
    const previous = this.startQueue;
    let release!: () => void;
    this.startQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const delay = Math.max(0, this.nextStartAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    this.nextStartAt = Date.now() + this.minimumStartIntervalMs;
    release();
  }

  async run(args: string[]): Promise<unknown> {
    const normalized = prepareReadOnlyMeegleArgs(args);
    const command = `${normalized[0]} ${normalized[1]}`;
    await this.reserveStart();
    this.logger.info("meego.cli.started", {
      command,
      argument_names: normalized.filter((argument) => argument.startsWith("--"))
    });
    try {
      const { stdout } = await execFileAsync(this.binary, normalized, {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: 120_000,
        shell: false
      });
      const parsed = parseJsonOutput(stdout);
      const error = errorFromPayload(parsed);
      if (error) throw error;
      this.logger.info("meego.cli.completed", { command });
      return parsed;
    } catch (error) {
      if (error instanceof MeegleCliError) throw error;
      const processError = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
      for (const output of [processError.stdout, processError.stderr]) {
        try {
          const parsed = parseJsonOutput(output);
          const parsedError = errorFromPayload(parsed);
          if (parsedError) throw parsedError;
        } catch (parsedError) {
          if (parsedError instanceof MeegleCliError) throw parsedError;
        }
      }
      throw new MeegleCliError(
        typeof processError.message === "string"
          ? processError.message
          : "meegle 命令执行失败"
      );
    }
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  LarkCliUpdateNotice,
  LarkSyncIssue,
  LarkSyncIssueKind
} from "../../core/types";
import { nullLogger, type Logger } from "../../logging";

const execFileAsync = promisify(execFile);

const READ_ONLY_COMMANDS = new Set([
  "contact:+get-user",
  "im:+messages-search",
  "calendar:+agenda",
  "task:+get-my-tasks"
]);

export interface CommandRunner {
  run(args: string[]): Promise<unknown>;
}

export class UnsafeLarkCommandError extends Error {}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function code(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isExecutableNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function installationIssue(): LarkSyncIssue {
  return {
    kind: "installation",
    requires_action: true,
    message: "未检测到 lark-cli 可执行文件。",
    hint: "请运行 npm install -g @larksuite/cli 安装，确认 lark-cli 已加入 PATH，然后运行 lark-cli auth login 完成认证。"
  };
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (text(entry) ? [text(entry)!] : []));
  }
  const single = text(value);
  return single ? [single] : [];
}

function jsonRecord(value: unknown): JsonRecord {
  if (typeof value !== "string") return record(value);
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return record(JSON.parse(trimmed));
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return {};
    try {
      return record(JSON.parse(trimmed.slice(start, end + 1)));
    } catch {
      return {};
    }
  }
}

function updateNotice(envelope: JsonRecord): LarkCliUpdateNotice | undefined {
  const update = record(record(envelope._notice).update);
  const command = text(update.command);
  if (!command) return undefined;
  return {
    command,
    ...(text(update.current) ? { current: text(update.current) } : {}),
    ...(text(update.latest) ? { latest: text(update.latest) } : {}),
    ...(text(update.message) ? { message: text(update.message) } : {})
  };
}

function classifyIssue(
  error: JsonRecord,
  missingScopes: string[]
): { kind: LarkSyncIssueKind; requiresAction: boolean } {
  const errorType = text(error.type)?.toLowerCase() ?? "";
  const subtype = text(error.subtype)?.toLowerCase() ?? "";
  const errorCode = code(error.code);
  const message = text(error.message)?.toLowerCase() ?? "";
  const permission =
    missingScopes.length > 0 ||
    errorCode === 99991679 ||
    subtype.includes("scope") ||
    subtype.includes("permission") ||
    /permission|scope|forbidden|权限不足|缺少权限|未授权/.test(message);
  if (permission) return { kind: "permission", requiresAction: true };

  const authentication =
    errorType === "authorization" ||
    subtype.includes("auth") ||
    subtype.includes("token") ||
    /unauthor|login|credential|token expired|登录|认证|令牌/.test(message);
  if (authentication) return { kind: "authentication", requiresAction: true };

  if (
    errorCode === 99992402 ||
    subtype === "invalid_parameters" ||
    subtype.includes("validation") ||
    /field validation|invalid parameter|参数错误|字段校验/.test(message)
  ) {
    return { kind: "invalid_parameters", requiresAction: false };
  }
  return { kind: "command", requiresAction: false };
}

export function parseLarkCliIssue(value: unknown): LarkSyncIssue | null {
  const envelope = jsonRecord(value);
  const error = record(envelope.error);
  if (!Object.keys(error).length) return null;

  const missingScopes = stringList(error.missing_scopes);
  const classification = classifyIssue(error, missingScopes);
  const message = text(error.message) ?? "lark-cli 返回失败";
  const issue: LarkSyncIssue = {
    kind: classification.kind,
    requires_action: classification.requiresAction,
    message,
    ...(text(error.type) ? { type: text(error.type) } : {}),
    ...(text(error.subtype) ? { subtype: text(error.subtype) } : {}),
    ...(code(error.code) !== undefined ? { code: code(error.code) } : {}),
    ...(missingScopes.length ? { missing_scopes: missingScopes } : {}),
    ...(text(error.hint) ? { hint: text(error.hint) } : {}),
    ...(text(error.console_url) ? { console_url: text(error.console_url) } : {}),
    ...(text(error.log_id) ? { log_id: text(error.log_id) } : {}),
    ...(text(error.troubleshooter) ? { troubleshooter: text(error.troubleshooter) } : {}),
    ...(updateNotice(envelope) ? { update: updateNotice(envelope) } : {})
  };
  return issue;
}

export function formatLarkCliIssue(issue: LarkSyncIssue): string {
  const labels: Record<LarkSyncIssueKind, string> = {
    installation: "缺少 lark-cli",
    permission: "飞书权限不足",
    authentication: "飞书认证需要处理",
    invalid_parameters: "飞书请求参数无效",
    command: "飞书命令失败"
  };
  const suffix = issue.code === undefined ? "" : `（${issue.code}）`;
  return `${labels[issue.kind]}${suffix}：${issue.message}`;
}

export class LarkCliCommandError extends Error {
  constructor(
    readonly issue: LarkSyncIssue,
    options?: ErrorOptions
  ) {
    super(formatLarkCliIssue(issue), options);
    this.name = "LarkCliCommandError";
  }
}

export function assertReadOnlyLarkCommand(args: string[]): void {
  const command = `${args[0] ?? ""}:${args[1] ?? ""}`;
  if (!READ_ONLY_COMMANDS.has(command)) {
    throw new UnsafeLarkCommandError(`Lark command is not in the read-only allowlist: ${command}`);
  }
  const forbidden = new Set([
    "+create",
    "+update",
    "+send",
    "+reply",
    "+complete",
    "+assign",
    "create",
    "patch",
    "delete"
  ]);
  if (args.some((argument) => forbidden.has(argument))) {
    throw new UnsafeLarkCommandError(`Mutation-like argument rejected: ${args.join(" ")}`);
  }
}

export function prepareReadOnlyLarkArgs(args: string[]): string[] {
  assertReadOnlyLarkCommand(args);
  const normalized = [...args];
  if (!normalized.includes("--as")) normalized.push("--as", "user");
  if (!normalized.includes("--format") && args[0] !== "contact") {
    normalized.push("--format", "json");
  }
  return normalized;
}

export class LarkCliCommandRunner implements CommandRunner {
  private readonly logger: Logger;

  constructor(
    private readonly binary = "lark-cli",
    logger: Logger = nullLogger
  ) {
    this.logger = logger.child({ component: "lark-cli" });
  }

  async run(args: string[]): Promise<unknown> {
    const normalized = prepareReadOnlyLarkArgs(args);
    const command = `${normalized[0] ?? "unknown"} ${normalized[1] ?? ""}`.trim();
    const argumentNames = [
      ...new Set(normalized.filter((argument) => argument.startsWith("--")))
    ].sort();
    const started = process.hrtime.bigint();
    let outputBytes = 0;
    this.logger.info("lark.cli.started", {
      command,
      argument_names: argumentNames
    });
    try {
      const { stdout } = await execFileAsync(this.binary, normalized, {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: 120_000,
        shell: false
      });
      outputBytes = Buffer.byteLength(stdout, "utf8");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      if (parsed.ok === false) {
        const issue = parseLarkCliIssue(parsed);
        if (issue) throw new LarkCliCommandError(issue);
        throw new Error("lark-cli returned an unsuccessful response");
      }
      this.logger.info("lark.cli.completed", {
        command,
        argument_names: argumentNames,
        output_bytes: outputBytes,
        duration_ms:
          Math.round(
            (Number(process.hrtime.bigint() - started) / 1_000_000) * 100
          ) / 100
      });
      return parsed.data ?? parsed;
    } catch (error) {
      const processError = error as { stderr?: unknown; stdout?: unknown };
      if (!outputBytes && typeof processError.stdout === "string") {
        outputBytes = Buffer.byteLength(processError.stdout, "utf8");
      }
      const issue =
        error instanceof LarkCliCommandError
          ? error.issue
          : isExecutableNotFound(error)
          ? installationIssue()
          : parseLarkCliIssue(processError.stderr) ??
            parseLarkCliIssue(processError.stdout);
      const normalizedError = error instanceof LarkCliCommandError
        ? error
        : issue
        ? new LarkCliCommandError(issue, { cause: error })
        : error;
      const fields = {
        command,
        argument_names: argumentNames,
        output_bytes: outputBytes,
        duration_ms:
          Math.round(
            (Number(process.hrtime.bigint() - started) / 1_000_000) * 100
          ) / 100,
        ...(issue
          ? {
              issue_kind: issue.kind,
              issue_code: issue.code,
              log_id: issue.log_id,
              requires_action: issue.requires_action,
              missing_scope_count: issue.missing_scopes?.length ?? 0,
              update_available: Boolean(issue.update)
            }
          : {}),
        error: normalizedError
      };
      if (issue?.requires_action || issue?.kind === "invalid_parameters") {
        this.logger.warn("lark.cli.failed", fields);
      } else {
        this.logger.error("lark.cli.failed", fields);
      }
      if (issue) throw normalizedError;
      throw error;
    }
  }
}

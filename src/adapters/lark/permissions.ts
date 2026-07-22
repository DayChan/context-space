import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  LarkPermissionPreflight,
  LarkPermissionPreflightState
} from "../../core/types";

const execFileAsync = promisify(execFile);

export const REQUIRED_LARK_SYNC_SCOPES = [
  "auth:user.id:read",
  "search:message",
  "calendar:calendar.event:read",
  "task:task:read"
] as const;

export type LarkPermissionProbe = Omit<
  LarkPermissionPreflight,
  "initial_sync_completed"
>;

export interface LarkPermissionChecker {
  check(): Promise<LarkPermissionProbe>;
}

export class LarkPermissionPreflightError extends Error {
  constructor(readonly preflight: LarkPermissionPreflight) {
    super(preflight.message);
    this.name = "LarkPermissionPreflightError";
  }
}

interface LarkCliPermissionCheckerOptions {
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function authorizationCommand(scopes: readonly string[]): string {
  return `lark-cli auth login --scope "${scopes.join(" ")}"`;
}

function result(
  state: LarkPermissionPreflightState,
  input: {
    granted?: string[];
    missing?: string[];
    message: string;
    authorizationScopes?: readonly string[];
  }
): LarkPermissionProbe {
  return {
    state,
    ready: state === "ready",
    required_scopes: [...REQUIRED_LARK_SYNC_SCOPES],
    granted_scopes: input.granted ?? [],
    missing_scopes: input.missing ?? [],
    checked_at: new Date().toISOString(),
    message: input.message,
    authorization_command: input.authorizationScopes?.length
      ? authorizationCommand(input.authorizationScopes)
      : null
  };
}

export class LarkCliPermissionChecker implements LarkPermissionChecker {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(
    private readonly binary = "lark-cli",
    options: LarkCliPermissionCheckerOptions = {}
  ) {
    this.environment = options.environment ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async check(): Promise<LarkPermissionProbe> {
    const args = [
      "auth",
      "check",
      "--scope",
      REQUIRED_LARK_SYNC_SCOPES.join(" "),
      "--json"
    ];
    try {
      const { stdout } = await execFileAsync(this.binary, args, {
        encoding: "utf8",
        env: this.environment,
        maxBuffer: 256 * 1024,
        timeout: this.timeoutMs,
        shell: false
      });
      return this.fromOutput(stdout);
    } catch (error) {
      const processError = error as NodeJS.ErrnoException & {
        stdout?: unknown;
        stderr?: unknown;
      };
      if (processError.code === "ENOENT") {
        return result("cli_missing", {
          message: "未检测到 lark-cli，请先安装并完成用户身份认证。"
        });
      }
      const parsed = this.parsedResult(processError.stdout);
      if (parsed) return parsed;
      const diagnostic = [processError.stderr, processError.message]
        .filter((value): value is string => typeof value === "string")
        .join(" ");
      if (/auth|login|token|credential|unauthor|登录|认证|令牌/i.test(diagnostic)) {
        return result("authentication_required", {
          message: "lark-cli 用户身份未登录或认证已失效。",
          authorizationScopes: REQUIRED_LARK_SYNC_SCOPES
        });
      }
      return result("check_failed", {
        message: "无法确认飞书权限，请检查 lark-cli 版本和认证状态。"
      });
    }
  }

  private fromOutput(stdout: string): LarkPermissionProbe {
    return (
      this.parsedResult(stdout) ??
      result("check_failed", {
        message: "lark-cli 权限检查返回了无法识别的结果。"
      })
    );
  }

  private parsedResult(value: unknown): LarkPermissionProbe | null {
    const parsed = parseJson(value);
    if (!parsed) return null;
    const granted = stringList(parsed.granted).filter((scope) =>
      REQUIRED_LARK_SYNC_SCOPES.includes(
        scope as (typeof REQUIRED_LARK_SYNC_SCOPES)[number]
      )
    );
    const reportedMissing = stringList(parsed.missing);
    const missing = REQUIRED_LARK_SYNC_SCOPES.filter(
      (scope) => reportedMissing.includes(scope) || !granted.includes(scope)
    );
    if (parsed.ok === true && missing.length === 0) {
      return result("ready", {
        granted,
        message: "飞书同步所需权限已就绪。"
      });
    }
    return result("missing_permissions", {
      granted,
      missing: [...missing],
      message: `飞书同步缺少 ${missing.length} 项权限。`,
      authorizationScopes: missing
    });
  }
}

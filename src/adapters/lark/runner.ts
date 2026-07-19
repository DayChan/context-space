import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  constructor(private readonly binary = "lark-cli") {}

  async run(args: string[]): Promise<unknown> {
    const normalized = prepareReadOnlyLarkArgs(args);

    const { stdout } = await execFileAsync(this.binary, normalized, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
      shell: false
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (parsed.ok === false) {
      const error = parsed.error as { message?: string } | undefined;
      throw new Error(error?.message ?? "lark-cli returned an unsuccessful response");
    }
    return parsed.data ?? parsed;
  }
}

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  AnalysisProviderError,
  minimalCodexEnvironment,
  sanitizedErrorMessage,
  type ProviderAvailability
} from "../contracts";

export interface CodexExecRunInput {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

export interface CodexExecRunOutput {
  stdout: string;
  stderr: string;
}

export interface CodexExecRunner {
  getAvailability(): Promise<ProviderAvailability>;
  run(input: CodexExecRunInput): Promise<CodexExecRunOutput>;
}

export type SpawnCodexProcess = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    shell: false;
    stdio: ["pipe", "pipe", "pipe"];
  }
) => ChildProcessWithoutNullStreams;

export interface NodeCodexExecRunnerOptions {
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnCodexProcess;
}

export class NodeCodexExecRunner implements CodexExecRunner {
  readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawnProcess: SpawnCodexProcess;

  constructor(options: NodeCodexExecRunnerOptions = {}) {
    this.executable = options.executable ?? "codex";
    this.environment = options.environment ?? process.env;
    this.spawnProcess =
      options.spawnProcess ??
      ((executable, args, spawnOptions) =>
        spawn(executable, args, spawnOptions) as ChildProcessWithoutNullStreams);
  }

  async getAvailability(): Promise<ProviderAvailability> {
    return new Promise((resolve) => {
      execFile(
        this.executable,
        ["--version"],
        {
          env: minimalCodexEnvironment(this.environment),
          timeout: 5_000,
          maxBuffer: 64 * 1024,
          shell: false
        },
        (error, stdout) => {
          if (error) {
            resolve({
              available: false,
              detail: `codex CLI 不可用：${sanitizedErrorMessage(error)}`
            });
            return;
          }
          const version = stdout.trim();
          resolve({
            available: true,
            detail: version || "codex CLI 可用",
            ...(version ? { version } : {})
          });
        }
      );
    });
  }

  async run(input: CodexExecRunInput): Promise<CodexExecRunOutput> {
    if (input.signal.aborted) {
      throw new AnalysisProviderError("cancelled", "codex exec 分析已取消");
    }
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", cancel);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!child.killed) child.kill("SIGKILL");
        reject(error);
      };
      const cancel = () =>
        fail(new AnalysisProviderError("cancelled", "codex exec 分析已取消"));
      const timer = setTimeout(
        () => fail(new AnalysisProviderError("timeout", "codex exec 分析超时")),
        input.timeoutMs
      );
      input.signal.addEventListener("abort", cancel, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > input.maxOutputBytes) {
          fail(new AnalysisProviderError("output_too_large", "codex exec JSONL 输出超过大小限制"));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, 64 * 1024 - stderr.reduce((sum, item) => sum + item.length, 0));
        if (remaining) stderr.push(chunk.subarray(0, remaining));
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        const code = error.code === "ENOENT" ? "provider_unavailable" : "provider_failed";
        fail(new AnalysisProviderError(code, `无法启动 codex exec：${sanitizedErrorMessage(error)}`));
      });
      child.once("close", (code, terminationSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        const stderrText = Buffer.concat(stderr).toString("utf8");
        if (code !== 0 || terminationSignal) {
          const message = sanitizedErrorMessage(stderrText || `退出码 ${code ?? terminationSignal}`);
          const errorCode = /auth|unauthor|api key|login|credential/i.test(message)
            ? "authentication_failed"
            : "provider_failed";
          reject(new AnalysisProviderError(errorCode, `codex exec 调用失败：${message}`));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: stderrText
        });
      });
      child.stdin.once("error", (error) => fail(error));
      child.stdin.end(input.stdin, "utf8");
    });
  }
}

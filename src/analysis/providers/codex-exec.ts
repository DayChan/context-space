import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AnalysisProviderError,
  assertNoToolActivity,
  minimalCodexEnvironment,
  sanitizedErrorMessage,
  type AnalysisProvider,
  type AnalysisUsage,
  type ProviderAnalysisRequest,
  type ProviderAnalysisResponse,
  type ProviderAvailability
} from "../contracts";
import {
  NodeCodexExecRunner,
  type CodexExecRunner
} from "./codex-exec-runner";
import { codexExecSafetyArguments } from "./codex-safety";

export interface CodexExecProviderOptions {
  runner?: CodexExecRunner;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
}

export function buildCodexExecArguments(
  schemaPath: string,
  resultPath: string,
  model: string | null
): string[] {
  return [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    resultPath,
    "--skip-git-repo-check",
    ...codexExecSafetyArguments(),
    ...(model ? ["--model", model] : []),
    "-"
  ];
}

function parseJsonLines(stdout: string): {
  eventTypes: string[];
  usage: AnalysisUsage | null;
} {
  const eventTypes: string[] = [];
  let usage: AnalysisUsage | null = null;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new AnalysisProviderError("provider_failed", "codex exec 返回了无效 JSONL 事件");
    }
    const item =
      event.item && typeof event.item === "object"
        ? (event.item as Record<string, unknown>)
        : null;
    if (typeof item?.type === "string") eventTypes.push(item.type);
    if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
      const raw = event.usage as Record<string, unknown>;
      if (
        ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"].every(
          (key) => typeof raw[key] === "number"
        )
      ) {
        usage = {
          input_tokens: raw.input_tokens as number,
          cached_input_tokens: raw.cached_input_tokens as number,
          output_tokens: raw.output_tokens as number,
          reasoning_output_tokens: raw.reasoning_output_tokens as number
        };
      }
    }
  }
  return { eventTypes, usage };
}

export class CodexExecProvider implements AnalysisProvider {
  readonly id = "codex-exec";
  private readonly runner: CodexExecRunner;
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: CodexExecProviderOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.executable = options.executable ?? "codex";
    this.runner =
      options.runner ??
      new NodeCodexExecRunner({
        executable: this.executable,
        environment: this.environment
      });
  }

  getAvailability(): Promise<ProviderAvailability> {
    return this.runner.getAvailability();
  }

  async analyze(
    request: ProviderAnalysisRequest,
    signal: AbortSignal
  ): Promise<ProviderAnalysisResponse> {
    const schemaPath = path.join(request.workingDirectory, "output-schema.json");
    const resultPath = path.join(request.workingDirectory, "final-response.json");
    await writeFile(schemaPath, JSON.stringify(request.outputSchema), {
      encoding: "utf8",
      mode: 0o600
    });
    const args = buildCodexExecArguments(schemaPath, resultPath, request.model);
    const execution = await this.runner.run({
      executable: this.executable,
      args,
      cwd: request.workingDirectory,
      env: minimalCodexEnvironment(this.environment),
      stdin: request.prompt,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      signal
    });
    const parsedEvents = parseJsonLines(execution.stdout);
    assertNoToolActivity(parsedEvents.eventTypes);

    let resultSize: number;
    try {
      resultSize = (await stat(resultPath)).size;
    } catch (error) {
      throw new AnalysisProviderError(
        "invalid_output",
        `codex exec 没有生成最终响应：${sanitizedErrorMessage(error)}`
      );
    }
    if (resultSize > request.maxOutputBytes) {
      throw new AnalysisProviderError("output_too_large", "codex exec 最终响应超过大小限制");
    }
    const finalResponse = await readFile(resultPath, "utf8");
    if (!finalResponse.trim()) {
      throw new AnalysisProviderError("invalid_output", "codex exec 最终响应为空");
    }
    return {
      finalResponse,
      model: request.model,
      usage: parsedEvents.usage,
      eventTypes: parsedEvents.eventTypes,
      diagnostic: execution.stderr ? sanitizedErrorMessage(execution.stderr) : undefined
    };
  }
}

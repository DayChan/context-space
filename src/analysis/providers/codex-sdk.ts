import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";
import {
  AnalysisProviderError,
  assertNoToolActivity,
  minimalCodexEnvironment,
  sanitizedErrorMessage,
  type AnalysisProvider,
  type ProviderAnalysisRequest,
  type ProviderAnalysisResponse,
  type ProviderAvailability
} from "../contracts";
import { codexSdkSafetyConfig } from "./codex-safety";

export interface CodexSdkTurnLike {
  items: Array<{ type: string }>;
  finalResponse: string;
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
  } | null;
}

export interface CodexSdkThreadLike {
  run(
    prompt: string,
    options: { outputSchema: unknown; signal: AbortSignal }
  ): Promise<CodexSdkTurnLike>;
}

export interface CodexSdkClientLike {
  startThread(options: ThreadOptions): CodexSdkThreadLike;
}

export type CodexSdkClientFactory = (options: CodexOptions) => CodexSdkClientLike;

export interface CodexSdkProviderOptions {
  clientFactory?: CodexSdkClientFactory;
  environment?: NodeJS.ProcessEnv;
}

function providerError(error: unknown, timedOut: boolean, cancelled: boolean): AnalysisProviderError {
  if (timedOut) return new AnalysisProviderError("timeout", "Codex SDK 分析超时");
  if (cancelled) return new AnalysisProviderError("cancelled", "Codex SDK 分析已取消");
  const message = sanitizedErrorMessage(error);
  if (/auth|unauthor|api key|login|credential/i.test(message)) {
    return new AnalysisProviderError("authentication_failed", `Codex SDK 认证失败：${message}`);
  }
  return new AnalysisProviderError("provider_failed", `Codex SDK 调用失败：${message}`);
}

export class CodexSdkProvider implements AnalysisProvider {
  readonly id = "codex-sdk";
  private readonly clientFactory: CodexSdkClientFactory;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: CodexSdkProviderOptions = {}) {
    this.clientFactory =
      options.clientFactory ??
      ((codexOptions) => new Codex(codexOptions) as unknown as CodexSdkClientLike);
    this.environment = options.environment ?? process.env;
  }

  async getAvailability(): Promise<ProviderAvailability> {
    try {
      this.clientFactory({
        env: minimalCodexEnvironment(this.environment),
        config: codexSdkSafetyConfig()
      });
      return {
        available: true,
        detail: "Codex SDK 已安装；认证将在分析调用时验证"
      };
    } catch (error) {
      return {
        available: false,
        detail: `Codex SDK 不可用：${sanitizedErrorMessage(error)}`
      };
    }
  }

  async analyze(
    request: ProviderAnalysisRequest,
    signal: AbortSignal
  ): Promise<ProviderAnalysisResponse> {
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, request.timeoutMs);
    const combined = AbortSignal.any([signal, timeoutController.signal]);

    try {
      const client = this.clientFactory({
        env: minimalCodexEnvironment(this.environment),
        config: codexSdkSafetyConfig()
      });
      const thread = client.startThread({
        ...(request.model ? { model: request.model } : {}),
        modelReasoningEffort: request.reasoningEffort,
        workingDirectory: request.workingDirectory,
        skipGitRepoCheck: true,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        additionalDirectories: []
      });
      const turn = await thread.run(request.prompt, {
        outputSchema: request.outputSchema,
        signal: combined
      });
      const eventTypes = turn.items.map(({ type }) => type);
      assertNoToolActivity(eventTypes);
      if (!turn.finalResponse?.trim()) {
        throw new AnalysisProviderError("invalid_output", "Codex SDK 没有返回最终响应");
      }
      if (Buffer.byteLength(turn.finalResponse, "utf8") > request.maxOutputBytes) {
        throw new AnalysisProviderError("output_too_large", "Codex SDK 最终响应超过大小限制");
      }
      return {
        finalResponse: turn.finalResponse,
        model: request.model,
        usage: turn.usage,
        eventTypes
      };
    } catch (error) {
      if (error instanceof AnalysisProviderError) throw error;
      throw providerError(error, timedOut, signal.aborted);
    } finally {
      clearTimeout(timer);
    }
  }
}

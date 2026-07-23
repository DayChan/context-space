import type { AgentKind } from "../core/types";
import { ClaudeAgentRuntime, TraexAgentRuntime } from "./cli-runtime";
import { CodexAgentRuntime } from "./codex-runtime";
import type { AgentRuntime, AgentRuntimeInput, AgentRuntimeResult } from "./contracts";

export class MultiAgentRuntime implements AgentRuntime {
  constructor(private readonly runtimes: Record<AgentKind, AgentRuntime> = {
    codex: new CodexAgentRuntime(),
    traex: new TraexAgentRuntime(),
    claude: new ClaudeAgentRuntime()
  }) {}

  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    return this.runtimes[input.agent].run(input);
  }
}

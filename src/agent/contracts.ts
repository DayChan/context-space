import { z } from "zod";
import type { AgentKind, AgentOutcome, AgentWorkspaceMode } from "../core/types";

const agentConfirmationSchema = z.object({
  kind: z.enum(["decision", "action_approval", "workspace_upgrade"]),
  question: z.string().min(1).max(2_000),
  options: z.array(z.string().min(1).max(200)).min(2).max(8)
}).strict();

export const agentTurnTransportSchema = z.object({
  message: z.string().min(1).max(100_000),
  outcome: z.enum(["completed", "needs_confirmation", "awaiting_reply", "blocked"]),
  confirmation: agentConfirmationSchema.nullable()
}).strict();

export const agentTurnResultSchema = agentTurnTransportSchema.superRefine((value, context) => {
  if (value.outcome === "needs_confirmation" && !value.confirmation) {
    context.addIssue({ code: "custom", message: "needs_confirmation 必须包含 confirmation" });
  }
  if (value.outcome !== "needs_confirmation" && value.confirmation) {
    context.addIssue({ code: "custom", message: "非确认结果的 confirmation 必须为 null" });
  }
});

function toCodexCompatibleJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCodexCompatibleJsonSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
      if (key === "$schema") return [];
      return [[key === "oneOf" ? "anyOf" : key, toCodexCompatibleJsonSchema(nested)]];
    })
  );
}

export const AGENT_TURN_OUTPUT_SCHEMA = toCodexCompatibleJsonSchema(
  z.toJSONSchema(agentTurnTransportSchema)
);

export interface AgentRuntimeEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface AgentRuntimeResult {
  threadId: string;
  message: string;
  outcome: AgentOutcome;
  confirmation?: {
    kind: "decision" | "action_approval" | "workspace_upgrade";
    question: string;
    options: string[];
  };
  usage: Record<string, number> | null;
}

export interface AgentRuntimeInput {
  agent: AgentKind;
  model: string | null;
  threadId: string | null;
  workingDirectory: string;
  mode: AgentWorkspaceMode;
  prompt: string;
  signal: AbortSignal;
  onEvent(event: AgentRuntimeEvent): void;
}

export interface AgentRuntime {
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>;
}

export const AGENT_PROMPT_SUFFIX = `

<context_space_contract>
你正在由 Context Space 人工驱动的 Agent 会话中工作。
- 不要自行 push、合并、创建 MR 或修改 Todo/Meego 外部状态。
- 如果需要用户做决定、批准动作或从只读升级为可写，请停止当前轮次并返回 needs_confirmation。
- 如果工作已经完成，返回 completed；仍需普通补充信息时返回 awaiting_reply；无法继续时返回 blocked。
- 只有 needs_confirmation 可以返回 confirmation 对象；其他 outcome 必须返回 confirmation: null。
- 最终输出必须遵循提供的 JSON Schema，message 是展示给用户的简体中文回复。
</context_space_contract>`;

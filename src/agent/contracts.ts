import { z } from "zod";
import type { AgentOutcome, AgentWorkspaceMode } from "../core/types";

export const agentTurnResultSchema = z.object({
  message: z.string().min(1).max(100_000),
  outcome: z.enum(["completed", "needs_confirmation", "awaiting_reply", "blocked"]),
  confirmation: z.object({
    kind: z.enum(["decision", "action_approval", "workspace_upgrade"]).default("decision"),
    question: z.string().min(1).max(2_000),
    options: z.array(z.string().min(1).max(200)).min(2).max(8)
  }).optional()
}).superRefine((value, context) => {
  if (value.outcome === "needs_confirmation" && !value.confirmation) {
    context.addIssue({ code: "custom", message: "needs_confirmation 必须包含 confirmation" });
  }
});

export const AGENT_TURN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    outcome: { type: "string", enum: ["completed", "needs_confirmation", "awaiting_reply", "blocked"] },
    confirmation: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["decision", "action_approval", "workspace_upgrade"] },
        question: { type: "string" },
        options: { type: "array", minItems: 2, maxItems: 8, items: { type: "string" } }
      },
      required: ["kind", "question", "options"]
    }
  },
  required: ["message", "outcome"]
} as const;

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
- 最终输出必须遵循提供的 JSON Schema，message 是展示给用户的简体中文回复。
</context_space_contract>`;

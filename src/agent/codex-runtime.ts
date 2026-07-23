import { Codex, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import {
  AGENT_PROMPT_SUFFIX,
  AGENT_TURN_OUTPUT_SCHEMA,
  agentTurnResultSchema,
  type AgentRuntime,
  type AgentRuntimeEvent,
  type AgentRuntimeInput,
  type AgentRuntimeResult
} from "./contracts";

function bounded(value: string, limit = 16_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…[truncated]`;
}

function eventProjection(event: ThreadEvent): AgentRuntimeEvent {
  if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
    const item = event.item as ThreadItem;
    if (item.type === "command_execution") {
      return { type: `${event.type}:command_execution`, data: {
        id: item.id, command: bounded(item.command, 4_000), status: item.status,
        exitCode: item.exit_code, output: bounded(item.aggregated_output)
      } };
    }
    if (item.type === "file_change") {
      return { type: `${event.type}:file_change`, data: { id: item.id, status: item.status, changes: item.changes.slice(0, 200) } };
    }
    if (item.type === "todo_list") {
      return { type: `${event.type}:todo_list`, data: { id: item.id, items: item.items.slice(0, 100) } };
    }
    if (item.type === "agent_message") {
      return { type: `${event.type}:agent_message`, data: { id: item.id } };
    }
    if (item.type === "error") {
      return { type: `${event.type}:error`, data: { id: item.id, message: bounded(item.message, 4_000) } };
    }
    return { type: `${event.type}:${item.type}`, data: { id: item.id } };
  }
  if (event.type === "thread.started") return { type: event.type, data: { threadId: event.thread_id } };
  if (event.type === "turn.completed") return { type: event.type, data: { usage: event.usage } };
  if (event.type === "turn.failed") return { type: event.type, data: { message: bounded(event.error.message, 4_000) } };
  if (event.type === "error") return { type: event.type, data: { message: bounded(event.message, 4_000) } };
  return { type: event.type, data: {} };
}

export class CodexAgentRuntime implements AgentRuntime {
  constructor(private readonly client = new Codex()) {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    if (input.agent !== "codex") throw new Error(`Codex Runtime 不支持 Agent：${input.agent}`);
    const options = {
      workingDirectory: input.workingDirectory,
      sandboxMode: input.mode === "read_only" ? "read-only" as const : "workspace-write" as const,
      approvalPolicy: "never" as const,
      networkAccessEnabled: false,
      webSearchMode: "disabled" as const,
      additionalDirectories: [],
      ...(input.model ? { model: input.model } : {})
    };
    const thread = input.threadId
      ? this.client.resumeThread(input.threadId, options)
      : this.client.startThread(options);
    const streamed = await thread.runStreamed(`${input.prompt}${AGENT_PROMPT_SUFFIX}`, {
      outputSchema: AGENT_TURN_OUTPUT_SCHEMA,
      signal: input.signal
    });
    let threadId = input.threadId;
    let finalText = "";
    let usage: Record<string, number> | null = null;
    for await (const event of streamed.events) {
      input.onEvent(eventProjection(event));
      if (event.type === "thread.started") threadId = event.thread_id;
      if (event.type === "item.completed" && event.item.type === "agent_message") {
        finalText = event.item.text;
      }
      if (event.type === "turn.completed") usage = { ...event.usage };
      if (event.type === "turn.failed") throw new Error(event.error.message);
      if (event.type === "error") throw new Error(event.message);
    }
    const parsed = agentTurnResultSchema.parse(JSON.parse(finalText));
    const resolvedThreadId = threadId ?? thread.id;
    if (!resolvedThreadId) throw new Error("Codex 未返回可恢复的 Thread ID");
    return {
      threadId: resolvedThreadId,
      message: parsed.message,
      outcome: parsed.outcome,
      ...(parsed.confirmation ? { confirmation: parsed.confirmation } : {}),
      usage
    };
  }
}

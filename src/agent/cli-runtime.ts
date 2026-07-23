import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_PROMPT_SUFFIX,
  AGENT_TURN_OUTPUT_SCHEMA,
  agentTurnResultSchema,
  type AgentRuntime,
  type AgentRuntimeEvent,
  type AgentRuntimeInput,
  type AgentRuntimeResult
} from "./contracts";

const MAX_DIAGNOSTIC_CHARS = 16_000;

function bounded(value: string, limit = MAX_DIAGNOSTIC_CHARS): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…[truncated]`;
}

function numericUsage(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number");
  return entries.length ? Object.fromEntries(entries) : null;
}

function jsonSuffix(
  value: string
): { candidate: unknown; displayMessage: string | null } | undefined {
  let start = value.lastIndexOf("{");
  while (start >= 0) {
    try {
      const candidate = JSON.parse(value.slice(start));
      return {
        candidate,
        displayMessage: value.slice(0, start).trim() || null
      };
    } catch {
      // 继续向前寻找能够覆盖完整 JSON 对象的起点。
    }
    start = start > 0 ? value.lastIndexOf("{", start - 1) : -1;
  }
  return undefined;
}

function candidateMessage(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== "object") return null;
  const message = (candidate as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function parseFinal(
  value: unknown,
  options: { allowPlainText?: boolean } = {}
): Omit<AgentRuntimeResult, "threadId" | "usage"> {
  let candidate = value;
  let displayMessage: string | null = null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    try {
      candidate = JSON.parse(trimmed);
    } catch (error) {
      const structuredSuffix = options.allowPlainText
        ? jsonSuffix(trimmed)
        : undefined;
      if (structuredSuffix !== undefined) {
        candidate = structuredSuffix.candidate;
        displayMessage = structuredSuffix.displayMessage;
      } else {
        if (
          !options.allowPlainText ||
          !trimmed ||
          trimmed.startsWith("{") ||
          trimmed.startsWith("[")
        ) {
          throw error;
        }
        return {
          message: trimmed,
          outcome: "awaiting_reply"
        };
      }
    }
  }
  const parsed = agentTurnResultSchema.safeParse(candidate);
  if (!parsed.success) {
    const fallbackMessage = displayMessage ?? candidateMessage(candidate);
    if (options.allowPlainText && fallbackMessage) {
      return {
        message: fallbackMessage,
        outcome: "awaiting_reply"
      };
    }
    throw parsed.error;
  }
  return {
    message: displayMessage ?? parsed.data.message,
    outcome: parsed.data.outcome,
    ...(parsed.data.confirmation ? { confirmation: parsed.data.confirmation } : {})
  };
}

interface ProcessResult {
  stderr: string;
}

async function runJsonLinesProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  stdin: string;
  signal: AbortSignal;
  onJson(value: Record<string, unknown>): void;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ stderr: bounded(stderr) });
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error("Agent Turn 已取消"));
    };
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) {
      abort();
      return;
    }
    child.once("error", (error) => finish(error));
    child.stdin.once("error", (error) => finish(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = bounded(`${stderr}${chunk}`);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        try {
          input.onJson(JSON.parse(line) as Record<string, unknown>);
        } catch (error) {
          child.kill("SIGTERM");
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (stdoutBuffer.trim()) {
        try {
          input.onJson(JSON.parse(stdoutBuffer) as Record<string, unknown>);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      if (code !== 0) {
        finish(new Error(`${input.executable} 执行失败（${signal ?? `exit ${code}`}）：${bounded(stderr) || "无错误详情"}`));
        return;
      }
      finish();
    });
    child.stdin.end(input.stdin);
  });
}

function traexEvent(event: Record<string, unknown>): AgentRuntimeEvent {
  if (event.type === "thread.started") {
    return { type: "thread.started", data: { threadId: event.thread_id } };
  }
  const item = event.item && typeof event.item === "object"
    ? event.item as Record<string, unknown>
    : null;
  if (item && typeof item.type === "string") {
    return {
      type: `${String(event.type ?? "item.updated")}:${item.type}`,
      data: {
        ...(typeof item.id === "string" ? { id: item.id } : {}),
        ...(typeof item.status === "string" ? { status: item.status } : {}),
        ...(typeof item.command === "string" ? { command: bounded(item.command, 4_000) } : {})
      }
    };
  }
  return { type: String(event.type ?? "traex.event"), data: {} };
}

export function buildTraexAgentArguments(input: {
  threadId: string | null;
  model: string | null;
  mode: AgentRuntimeInput["mode"];
  schemaPath: string;
  resultPath: string;
}): string[] {
  const shared = [
    "--json",
    "--output-last-message", input.resultPath,
    "--skip-git-repo-check",
    "--ignore-rules",
    "-c", "approval_policy=\"never\"",
    ...(input.model ? ["--model", input.model] : [])
  ];
  if (input.threadId) {
    return ["exec", "resume", ...shared, input.threadId, "-"];
  }
  return [
    "exec",
    "--sandbox", input.mode === "read_only" ? "read-only" : "workspace-write",
    "--output-schema", input.schemaPath,
    ...shared,
    "-"
  ];
}

export class TraexAgentRuntime implements AgentRuntime {
  constructor(private readonly executable = "traex") {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    if (input.agent !== "traex") throw new Error(`TraeX Runtime 不支持 Agent：${input.agent}`);
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "context-space-traex-"));
    try {
      const schemaPath = path.join(temporaryDirectory, "output-schema.json");
      const resultPath = path.join(temporaryDirectory, "final-response.json");
      await writeFile(schemaPath, JSON.stringify(AGENT_TURN_OUTPUT_SCHEMA), { encoding: "utf8", mode: 0o600 });
      let threadId = input.threadId;
      let usage: Record<string, number> | null = null;
      await runJsonLinesProcess({
        executable: this.executable,
        args: buildTraexAgentArguments({ ...input, schemaPath, resultPath }),
        cwd: input.workingDirectory,
        stdin: `${input.prompt}${AGENT_PROMPT_SUFFIX}`,
        signal: input.signal,
        onJson: (event) => {
          const projected = traexEvent(event);
          input.onEvent(projected);
          if (projected.type === "thread.started" && typeof projected.data.threadId === "string") {
            threadId = projected.data.threadId;
          }
          if (event.type === "turn.completed") usage = numericUsage(event.usage);
        }
      });
      if (!threadId) throw new Error("TraeX 未返回可恢复的 Session ID");
      const parsed = parseFinal(await readFile(resultPath, "utf8"), {
        allowPlainText: Boolean(input.threadId)
      });
      return { threadId, ...parsed, usage };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function claudeToolType(name: string): string {
  if (name === "Bash") return "command_execution";
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) return "file_change";
  if (name === "TodoWrite") return "todo_list";
  return "tool_call";
}

function projectClaudeEvent(event: Record<string, unknown>): AgentRuntimeEvent[] {
  if (event.type === "system" && event.subtype === "init") {
    return [{ type: "thread.started", data: { threadId: event.session_id } }];
  }
  if (event.type !== "assistant") return [{ type: `claude.${String(event.type ?? "event")}`, data: {} }];
  const message = event.message && typeof event.message === "object"
    ? event.message as Record<string, unknown>
    : null;
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.flatMap((block): AgentRuntimeEvent[] => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    if (item.type !== "tool_use" || typeof item.name !== "string") return [];
    return [{
      type: `item.started:${claudeToolType(item.name)}`,
      data: {
        ...(typeof item.id === "string" ? { id: item.id } : {}),
        tool: item.name
      }
    }];
  });
}

export function buildClaudeAgentArguments(input: {
  threadId: string | null;
  model: string | null;
  mode: AgentRuntimeInput["mode"];
}): string[] {
  return [
    "--print",
    "--verbose",
    "--output-format", "stream-json",
    "--json-schema", JSON.stringify(AGENT_TURN_OUTPUT_SCHEMA),
    "--permission-mode", input.mode === "read_only" ? "plan" : "acceptEdits",
    "--disallowedTools", "WebFetch,WebSearch",
    "--append-system-prompt", AGENT_PROMPT_SUFFIX,
    ...(input.threadId ? ["--resume", input.threadId] : []),
    ...(input.model ? ["--model", input.model] : [])
  ];
}

export class ClaudeAgentRuntime implements AgentRuntime {
  constructor(private readonly executable = "claude") {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    if (input.agent !== "claude") throw new Error(`Claude Runtime 不支持 Agent：${input.agent}`);
    let threadId = input.threadId;
    let usage: Record<string, number> | null = null;
    const state: { final: Omit<AgentRuntimeResult, "threadId" | "usage"> | null } = { final: null };
    await runJsonLinesProcess({
      executable: this.executable,
      args: buildClaudeAgentArguments(input),
      cwd: input.workingDirectory,
      stdin: input.prompt,
      signal: input.signal,
      onJson: (event) => {
        for (const projected of projectClaudeEvent(event)) {
          input.onEvent(projected);
          if (projected.type === "thread.started" && typeof projected.data.threadId === "string") {
            threadId = projected.data.threadId;
          }
        }
        if (event.type === "result") {
          if (typeof event.session_id === "string") threadId = event.session_id;
          usage = numericUsage(event.usage);
          state.final = parseFinal(event.structured_output ?? event.result);
        }
      }
    });
    if (!threadId) throw new Error("Claude 未返回可恢复的 Session ID");
    if (!state.final) throw new Error("Claude 未返回有效的结构化终态");
    return { threadId, ...state.final, usage };
  }
}

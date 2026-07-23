import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildClaudeAgentArguments,
  buildTraexAgentArguments,
  ClaudeAgentRuntime,
  MultiAgentRuntime,
  TraexAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeInput,
  type AgentRuntimeResult
} from "../src/agent";

const temporaryDirectories: string[] = [];

async function executable(name: string, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `context-space-${name}-`));
  temporaryDirectories.push(directory);
  const file = path.join(directory, name);
  await writeFile(file, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(file, 0o700);
  return file;
}

function runtimeInput(overrides: Partial<AgentRuntimeInput> = {}): AgentRuntimeInput {
  return {
    agent: "traex",
    model: null,
    threadId: null,
    workingDirectory: process.cwd(),
    mode: "read_only",
    prompt: "检查任务",
    signal: new AbortController().signal,
    onEvent: () => undefined,
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("Agent Runtime 选择", () => {
  it("仅在用户选择模型时向 TraeX 和 Claude 传 --model", () => {
    const traexDefault = buildTraexAgentArguments({
      threadId: null,
      model: null,
      mode: "read_only",
      schemaPath: "/tmp/schema",
      resultPath: "/tmp/result"
    });
    expect(traexDefault).not.toContain("--model");
    expect(traexDefault).toContain("read-only");

    const traexResume = buildTraexAgentArguments({
      threadId: "session-1",
      model: "custom-model",
      mode: "isolated_worktree",
      schemaPath: "/tmp/schema",
      resultPath: "/tmp/result"
    });
    expect(traexResume).toEqual(expect.arrayContaining(["resume", "--model", "custom-model", "session-1"]));

    expect(buildClaudeAgentArguments({
      threadId: null,
      model: null,
      mode: "read_only"
    })).not.toContain("--model");
    expect(buildClaudeAgentArguments({
      threadId: "session-2",
      model: "sonnet",
      mode: "isolated_worktree"
    })).toEqual(expect.arrayContaining(["--resume", "session-2", "--model", "sonnet", "acceptEdits"]));
  });

  it("解析 TraeX JSONL、持久 Session ID 和结构化终态", async () => {
    const command = await executable("fake-traex", `
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(output, JSON.stringify({ message: "TraeX 完成", outcome: "completed", confirmation: null }));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "traex-session" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }) + "\\n");
`);
    const events: string[] = [];
    const result = await new TraexAgentRuntime(command).run(runtimeInput({
      onEvent: (event) => events.push(event.type)
    }));
    expect(result).toMatchObject({
      threadId: "traex-session",
      message: "TraeX 完成",
      outcome: "completed",
      usage: { input_tokens: 3, output_tokens: 2 }
    });
    expect(events).toContain("thread.started");
  });

  it("将 TraeX Resume 返回的普通文本安全降级为等待回复", async () => {
    const command = await executable("fake-traex-resume", `
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(output, "好的，我们来讨论方案细节。");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "traex-session" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`);
    const result = await new TraexAgentRuntime(command).run(runtimeInput({
      threadId: "traex-session"
    }));
    expect(result).toMatchObject({
      threadId: "traex-session",
      message: "好的，我们来讨论方案细节。",
      outcome: "awaiting_reply",
      usage: null
    });
  });

  it("优先解析 TraeX Resume 正文末尾的结构化结果", async () => {
    const command = await executable("fake-traex-mixed-output", `
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
const result = {
  message: "请确认方案。",
  outcome: "needs_confirmation",
  confirmation: {
    kind: "decision",
    question: "是否继续？",
    options: ["继续", "调整"]
  }
};
fs.writeFileSync(output, "这里是详细方案，示例代码包含 { braces: true }。\\n\\n" + JSON.stringify(result));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "traex-session" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`);
    const result = await new TraexAgentRuntime(command).run(runtimeInput({
      threadId: "traex-session"
    }));
    expect(result).toMatchObject({
      threadId: "traex-session",
      message: "这里是详细方案，示例代码包含 { braces: true }。",
      outcome: "needs_confirmation",
      confirmation: {
        kind: "decision",
        question: "是否继续？",
        options: ["继续", "调整"]
      }
    });
    expect(result.message).not.toContain('"outcome"');
  });

  it("TraeX Resume 控制字段非法时保留 message 正文", async () => {
    const command = await executable("fake-traex-invalid-control", `
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(output, JSON.stringify({
  message: "当前环境为只读模式，需要升级工作区后继续。",
  outcome: "needs_confirmation",
  confirmation: {
    kind: "permission",
    question: "是否允许写入？",
    options: ["允许", "拒绝"]
  }
}));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "traex-session" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`);
    const result = await new TraexAgentRuntime(command).run(runtimeInput({
      threadId: "traex-session"
    }));
    expect(result).toMatchObject({
      threadId: "traex-session",
      message: "当前环境为只读模式，需要升级工作区后继续。",
      outcome: "awaiting_reply",
      usage: null
    });
    expect(result.confirmation).toBeUndefined();
  });

  it("不把 TraeX Resume 返回的损坏 JSON 降级为普通文本", async () => {
    const command = await executable("fake-traex-invalid-json", `
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(output, '{"message":');
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "traex-session" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`);
    await expect(new TraexAgentRuntime(command).run(runtimeInput({
      threadId: "traex-session"
    }))).rejects.toThrow(/JSON/);
  });

  it("解析 Claude stream-json 的 Session ID 和 structured_output", async () => {
    const command = await executable("fake-claude", `
process.stdin.resume();
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result",
  session_id: "claude-session",
  usage: { input_tokens: 4, output_tokens: 1 },
  structured_output: { message: "Claude 完成", outcome: "awaiting_reply", confirmation: null }
}) + "\\n");
`);
    const result = await new ClaudeAgentRuntime(command).run(runtimeInput({
      agent: "claude"
    }));
    expect(result).toMatchObject({
      threadId: "claude-session",
      message: "Claude 完成",
      outcome: "awaiting_reply",
      usage: { input_tokens: 4, output_tokens: 1 }
    });
  });

  it("按 Session 固化的 Agent 路由，不跨 Runtime 恢复", async () => {
    const calls: string[] = [];
    const fake = (name: string): AgentRuntime => ({
      async run(): Promise<AgentRuntimeResult> {
        calls.push(name);
        return { threadId: name, message: name, outcome: "completed", usage: null };
      }
    });
    const runtime = new MultiAgentRuntime({
      codex: fake("codex"),
      traex: fake("traex"),
      claude: fake("claude")
    });
    await runtime.run(runtimeInput({ agent: "claude", threadId: "claude-existing" }));
    expect(calls).toEqual(["claude"]);
  });
});

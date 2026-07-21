import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentCoordinator,
  AgentLoopService,
  AgentSessionEvents,
  GitWorkspaceService,
  type AgentRuntime,
  type AgentRuntimeInput,
  type AgentRuntimeResult
} from "../src/agent";
import type { CommandRunner } from "../src/adapters/lark/runner";
import { createTodoMetadata } from "../src/core/todo";
import { createLogger } from "../src/logging";
import { AgentRepositoryStore, openMachineDatabase, type MachineDatabase } from "../src/machine";
import { createApp } from "../src/server/app";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const databases: MachineDatabase[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createGitRepository(parent: string): Promise<string> {
  const repository = path.join(parent, "project");
  await execFileAsync("git", ["init", repository]);
  await git(repository, ["config", "user.email", "agent-loop@example.test"]);
  await git(repository, ["config", "user.name", "Agent Loop Test"]);
  await writeFile(path.join(repository, "README.md"), "# Test\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "initial"]);
  return repository;
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待 Agent 状态超时");
}

class FakeAgentRuntime implements AgentRuntime {
  calls: AgentRuntimeInput[] = [];
  constructor(private readonly results: AgentRuntimeResult[]) {}
  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    input.onEvent({ type: "thread.started", data: { threadId: input.threadId ?? "thread_1" } });
    input.onEvent({ type: "item.completed:command_execution", data: { command: "npm test", status: "completed" } });
    const result = this.results.shift();
    if (!result) throw new Error("Fake Runtime 没有结果");
    return result;
  }
}

class EmptyRunner implements CommandRunner {
  async run(args: string[]): Promise<unknown> {
    if (args[0] === "contact") return { open_id: "ou_self", name: "Me" };
    return args[0] === "task" ? { tasks: [] } : args[0] === "calendar" ? { events: [] } : { messages: [] };
  }
}

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  })));
});

describe.sequential("人工 Agent Loop", () => {
  it("注册仓库并为隔离开发创建和清理独立 worktree", async () => {
    const root = await tempRoot("context-space-agent-git-");
    const repositoryPath = await createGitRepository(root);
    const database = await openMachineDatabase(root);
    databases.push(database);
    const store = new AgentRepositoryStore(database);
    const workspaces = new GitWorkspaceService(root);
    const inspected = await workspaces.inspectLocation(repositoryPath);
    const repository = store.addRepository(inspected);
    const workspace = await workspaces.createWorktree(repository, "session_test", inspected.headCommit);

    expect(workspace.path).not.toBe(repository.path);
    expect(repository.kind).toBe("git");
    expect(workspace.branch).toBe("context-space/session_test");
    expect(await git(workspace.path, ["rev-parse", "HEAD"])).toBe(inspected.headCommit);
    expect(await workspaces.status(repository, workspace.path, inspected.headCommit!)).toEqual({ dirty: false, unmergedCommits: 0 });

    await workspaces.removeWorktree(repository, workspace.path, workspace.branch, inspected.headCommit!);
    expect(await git(repository.path, ["branch", "--list", workspace.branch])).toBe("");
  }, 15_000);

  it("展开 ~/ 路径并允许普通目录启动只读会话", async () => {
    const root = await tempRoot("context-space-agent-directory-");
    const fakeHome = path.join(root, "home");
    const notesPath = path.join(fakeHome, "notes");
    await mkdir(notesPath, { recursive: true });
    const database = await openMachineDatabase(root);
    databases.push(database);
    const store = new AgentRepositoryStore(database);
    const workspaces = new GitWorkspaceService(root, undefined, fakeHome);
    const inspected = await workspaces.inspectLocation("~/notes");
    const canonicalNotesPath = await realpath(notesPath);
    expect(inspected).toMatchObject({ path: canonicalNotesPath, kind: "directory", headCommit: null, branch: null });
    const repository = store.addRepository(inspected);
    const runtime = new FakeAgentRuntime([
      { threadId: "thread_directory", message: "只读分析完成", outcome: "completed", usage: null }
    ]);
    const coordinator = new AgentCoordinator(store, runtime, new AgentSessionEvents(), createLogger({ workspaceRoot: root, environment: { NODE_ENV: "test" } }));
    const service = new AgentLoopService(store, workspaces, coordinator);

    const session = await service.start({
      title: "分析笔记",
      sourceKind: "todo",
      sourceId: "todo_directory",
      repositoryId: repository.id,
      mode: "read_only",
      prompt: "总结目录内容"
    });
    const completed = await waitFor(() => service.get(session.id)!, ({ attention }) => attention === "review_required");
    expect(completed).toMatchObject({ workspacePath: canonicalNotesPath, baseCommit: null, mode: "read_only" });
    expect(runtime.calls[0]).toMatchObject({ workingDirectory: canonicalNotesPath, mode: "read_only" });
    await expect(service.start({
      title: "修改笔记",
      sourceKind: "todo",
      sourceId: "todo_directory_write",
      repositoryId: repository.id,
      mode: "isolated_worktree",
      prompt: "修改目录内容"
    })).rejects.toThrow("普通目录仅支持只读模式");
  }, 15_000);

  it("串行运行多轮会话并把结构化确认与完成验收分开", async () => {
    const root = await tempRoot("context-space-agent-service-");
    const repositoryPath = await createGitRepository(root);
    const database = await openMachineDatabase(root);
    databases.push(database);
    const store = new AgentRepositoryStore(database);
    const workspaces = new GitWorkspaceService(root);
    const repository = store.addRepository(await workspaces.inspectLocation(repositoryPath));
    const runtime = new FakeAgentRuntime([
      {
        threadId: "thread_1",
        message: "需要选择实现方式",
        outcome: "needs_confirmation",
        confirmation: { kind: "decision", question: "采用哪个方案？", options: ["方案 A", "方案 B"] },
        usage: { input_tokens: 10, output_tokens: 5 }
      },
      { threadId: "thread_1", message: "实现完成，等待验收", outcome: "completed", usage: null }
    ]);
    const events = new AgentSessionEvents();
    const coordinator = new AgentCoordinator(store, runtime, events, createLogger({ workspaceRoot: root, environment: { NODE_ENV: "test" } }));
    const service = new AgentLoopService(store, workspaces, coordinator);

    const session = await service.start({
      title: "实现功能",
      sourceKind: "todo",
      sourceId: "todo_1",
      repositoryId: repository.id,
      mode: "read_only",
      prompt: "先分析实现方式"
    });
    const waiting = await waitFor(
      () => service.get(session.id)!,
      (value) => value.attention === "confirmation_required"
    );
    expect(waiting.mode).toBe("read_only");
    expect(waiting.confirmations).toHaveLength(1);
    expect(runtime.calls[0].workingDirectory).toBe(repository.path);
    expect(runtime.calls[0].mode).toBe("read_only");

    await service.answer(waiting.confirmations![0].id, { selection: "方案 A" });
    const review = await waitFor(
      () => service.get(session.id)!,
      (value) => value.attention === "review_required"
    );
    expect(review.threadId).toBe("thread_1");
    expect(review.messages?.map(({ role }) => role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(runtime.calls[1].threadId).toBe("thread_1");
    expect(service.accept(session.id).status).toBe("completed");
  }, 15_000);

  it("只读会话经人工批准后从原基线升级到独立 worktree", async () => {
    const root = await tempRoot("context-space-agent-upgrade-");
    const repositoryPath = await createGitRepository(root);
    const database = await openMachineDatabase(root);
    databases.push(database);
    const store = new AgentRepositoryStore(database);
    const workspaces = new GitWorkspaceService(root);
    const repository = store.addRepository(await workspaces.inspectLocation(repositoryPath));
    const runtime = new FakeAgentRuntime([
      { threadId: "thread_upgrade", message: "需要写入才能继续", outcome: "awaiting_reply", usage: null },
      { threadId: "thread_upgrade", message: "已在隔离工作区继续", outcome: "completed", usage: null }
    ]);
    const coordinator = new AgentCoordinator(store, runtime, new AgentSessionEvents(), createLogger({ workspaceRoot: root, environment: { NODE_ENV: "test" } }));
    const service = new AgentLoopService(store, workspaces, coordinator);
    const session = await service.start({
      title: "升级工作区",
      sourceKind: "todo",
      sourceId: "todo_upgrade",
      repositoryId: repository.id,
      mode: "read_only",
      prompt: "分析并实现"
    });
    await waitFor(() => service.get(session.id)!, ({ attention }) => attention === "reply_required");

    const requested = service.upgrade(session.id);
    const confirmation = requested.confirmations?.find(({ kind, status }) => kind === "workspace_upgrade" && status === "pending");
    expect(requested.mode).toBe("read_only");
    expect(confirmation).toBeDefined();
    await service.answer(confirmation!.id, { selection: "approve" });

    const upgraded = await waitFor(() => service.get(session.id)!, ({ attention }) => attention === "review_required");
    expect(upgraded.mode).toBe("isolated_worktree");
    expect(upgraded.workspacePath).not.toBe(repository.path);
    expect(upgraded.baseCommit).toBe(repository.headCommit);
    expect(runtime.calls[1]).toMatchObject({ mode: "isolated_worktree", workingDirectory: upgraded.workspacePath });
    expect(upgraded.events?.some(({ type }) => type === "workspace.switched")).toBe(true);

    service.accept(session.id);
    const cleanup = await service.cleanup(session.id);
    expect(cleanup.confirmation?.kind).toBe("workspace_cleanup");
    await service.answer(cleanup.confirmation!.id, { selection: "approve" });
    expect(service.get(session.id)?.workspaceLifecycle).toBe("removed");
  }, 15_000);

  it("服务启动时把遗留 running Turn 标记为 interrupted", async () => {
    const root = await tempRoot("context-space-agent-recovery-");
    const database = await openMachineDatabase(root);
    databases.push(database);
    const store = new AgentRepositoryStore(database);
    const repository = store.addRepository({
      name: "recovery",
      path: root,
      kind: "git",
      headCommit: "a".repeat(40),
      branch: "main"
    });
    const session = store.createSession({
      title: "恢复测试",
      sourceKind: "todo",
      sourceId: "todo_recovery",
      repositoryId: repository.id,
      mode: "read_only",
      workspacePath: root,
      branch: null,
      baseCommit: repository.headCommit,
      prompt: "执行任务"
    });
    const turn = store.nextQueuedTurn(session.id)!;
    store.startTurn(turn.id);

    new AgentCoordinator(
      store,
      new FakeAgentRuntime([]),
      new AgentSessionEvents(),
      createLogger({ workspaceRoot: root, environment: { NODE_ENV: "test" } })
    );
    expect(store.getTurn(turn.id)).toMatchObject({ status: "interrupted", error: "服务重启中断了运行" });
    expect(store.getSession(session.id)?.attention).toBe("reply_required");
  }, 15_000);

  it("通过受 CSRF 保护的 API 从 Todo 人工启动只读 Agent", async () => {
    const root = await tempRoot("context-space-agent-api-");
    const repositoryPath = await createGitRepository(root);
    const plainDirectory = path.join(root, "plain-notes");
    await mkdir(plainDirectory);
    const runtime = new FakeAgentRuntime([
      { threadId: "thread_api", message: "分析完成", outcome: "completed", usage: null }
    ]);
    const context = await createApp({
      workspaceRoot: root,
      commandRunner: new EmptyRunner(),
      agentRuntime: runtime,
      environment: { NODE_ENV: "test" }
    });
    databases.push(context.runtime.database);
    await context.runtime.store.write(
      "todos/items/agent_api.md",
      createTodoMetadata({ id: "agent_api", title: "API Agent Todo" }),
      "# API Agent Todo"
    );
    await context.runtime.index.rebuild(context.runtime.store);
    const csrf = (await request(context.app).get("/api/security/csrf")).body.token as string;
    const repository = await request(context.app)
      .post("/api/agent/repositories")
      .set("x-context-space-csrf", csrf)
      .send({ path: repositoryPath })
      .expect(201);
    const directory = await request(context.app)
      .post("/api/agent/repositories")
      .set("x-context-space-csrf", csrf)
      .send({ path: plainDirectory })
      .expect(201);
    expect(directory.body).toMatchObject({ kind: "directory", headCommit: null, branch: null });
    await request(context.app)
      .post("/api/agent/sessions")
      .set("x-context-space-csrf", csrf)
      .send({ sourceKind: "todo", sourceId: "agent_api", repositoryId: directory.body.id, mode: "isolated_worktree", prompt: "修改这个目录" })
      .expect(400, { error: "普通目录仅支持只读模式，无法创建 Git worktree" });
    const started = await request(context.app)
      .post("/api/agent/sessions")
      .set("x-context-space-csrf", csrf)
      .send({ sourceKind: "todo", sourceId: "agent_api", repositoryId: repository.body.id, mode: "read_only", prompt: "分析这个任务" })
      .expect(202);
    const completed = await waitFor(
      () => context.runtime.agentLoop.get(started.body.id)!,
      (value) => value.attention === "review_required"
    );
    expect(completed.workspacePath).toBe(repository.body.path);
    expect(completed.messages?.at(-1)?.content).toBe("分析完成");
    expect((await request(context.app).get("/api/loop").expect(200)).body).toMatchObject({
      enabled: true,
      automaticExecutionEnabled: false,
      sessions: [{ id: started.body.id }]
    });

    const server = context.app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试 HTTP Server 未监听 TCP 端口");
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/events`, { signal: controller.signal });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const first = await response.body!.getReader().read();
      expect(new TextDecoder().decode(first.value)).toContain("event: ready");
      controller.abort();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});

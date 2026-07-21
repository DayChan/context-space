import { randomUUID } from "node:crypto";
import { AgentConflictError, AgentRequestError } from "../core/agent-errors";
import type { AgentSession, AgentWorkspaceMode } from "../core/types";
import { AgentRepositoryStore } from "../machine";
import { AgentCoordinator } from "./coordinator";
import { GitWorkspaceService } from "./git-workspace";

export class AgentLoopService {
  constructor(
    private readonly store: AgentRepositoryStore,
    private readonly workspaces: GitWorkspaceService,
    private readonly coordinator: AgentCoordinator
  ) {}

  async registerRepository(inputPath: string) {
    return this.store.addRepository(await this.workspaces.inspectLocation(inputPath));
  }
  repositories() { return this.store.listRepositories(); }
  removeRepository(id: string) {
    if (!this.store.removeRepository(id)) throw new AgentRequestError("工作目录记录不存在");
  }

  async start(input: {
    title: string; sourceKind: "todo" | "meego"; sourceId: string;
    repositoryId: string; mode: AgentWorkspaceMode; prompt: string;
  }): Promise<AgentSession> {
    const registered = this.store.getRepository(input.repositoryId);
    if (!registered) throw new AgentRequestError("Agent 工作目录不存在");
    const current = await this.workspaces.inspectLocation(registered.path);
    const repository = this.store.updateRepositorySnapshot(registered.id, current);
    if (input.mode === "isolated_worktree" && repository.kind !== "git") {
      throw new AgentRequestError("普通目录仅支持只读模式，无法创建 Git worktree");
    }
    const sessionId = `session_${randomUUID()}`;
    const workspace = input.mode === "isolated_worktree"
      ? await this.workspaces.createWorktree(repository, sessionId, repository.headCommit)
      : { path: repository.path, branch: null, baseCommit: repository.headCommit };
    const session = this.store.createSession({ ...input, id: sessionId, workspacePath: workspace.path,
      branch: workspace.branch, baseCommit: workspace.baseCommit });
    this.coordinator.schedule(session.id);
    return session;
  }

  list() { return this.store.listSessions(); }
  get(id: string) { return this.store.getSession(id, true); }
  send(id: string, content: string) {
    const turn = this.store.enqueueMessage(id, content);
    this.coordinator.events.changed(id);
    this.coordinator.schedule(id);
    return turn;
  }
  async answer(id: string, answer: { selection?: string; text?: string }) {
    const confirmation = this.store.getConfirmation(id);
    if (!confirmation) throw new AgentRequestError("人工确认不存在");
    const isWorkspaceAction = confirmation.kind === "workspace_upgrade" || confirmation.kind === "workspace_cleanup";
    if (confirmation.status === "pending" && isWorkspaceAction && answer.selection === "approve") {
      if (confirmation.kind === "workspace_upgrade") await this.performUpgrade(confirmation.sessionId);
      else await this.performCleanup(confirmation.sessionId);
    }
    const result = this.store.answerConfirmation(id, answer, confirmation.kind !== "workspace_cleanup");
    this.coordinator.events.changed(result.confirmation.sessionId);
    if (result.turn) this.coordinator.schedule(result.confirmation.sessionId);
    return result;
  }
  stop(id: string) { return this.coordinator.stop(id); }
  accept(id: string) {
    const session = this.store.finishSession(id, "completed");
    this.coordinator.events.changed(id);
    return session;
  }
  cancel(id: string) {
    this.coordinator.stop(id);
    const session = this.store.finishSession(id, "cancelled");
    this.coordinator.events.changed(id);
    return session;
  }

  upgrade(id: string) {
    const session = this.store.getSession(id);
    if (!session) throw new AgentRequestError("Agent 会话不存在");
    if (session.status !== "active") throw new AgentConflictError("Agent 会话已结束");
    if (session.mode !== "read_only") return this.store.getSession(id, true)!;
    const repository = this.store.getRepository(session.repositoryId);
    if (!repository) throw new AgentRequestError("Agent 工作目录不存在");
    if (repository.kind !== "git") throw new AgentRequestError("普通目录仅支持只读模式，无法升级到 Git worktree");
    this.store.createConfirmation({
      sessionId: id,
      kind: "workspace_upgrade",
      question: "是否从当前基线创建独立 worktree，并允许 Agent 在其中继续写入？",
      options: ["approve", "reject"]
    });
    this.coordinator.events.changed(id);
    return this.store.getSession(id, true)!;
  }

  private async performUpgrade(id: string): Promise<AgentSession> {
    const session = this.store.getSession(id);
    if (!session) throw new AgentRequestError("Agent 会话不存在");
    if (session.status !== "active") throw new AgentConflictError("Agent 会话已结束");
    if (session.mode !== "read_only") return this.store.getSession(id, true)!;
    const repository = this.store.getRepository(session.repositoryId);
    if (!repository) throw new AgentRequestError("Agent 仓库不存在");
    const workspace = await this.workspaces.createWorktree(repository, session.id, session.baseCommit);
    const updated = this.store.switchWorkspace(id, workspace);
    this.store.addEvent(id, null, "workspace.switched", { mode: "isolated_worktree", path: workspace.path, branch: workspace.branch });
    return updated;
  }

  async cleanup(id: string): Promise<{ removed: boolean; confirmation?: ReturnType<AgentRepositoryStore["createConfirmation"]> }> {
    const session = this.store.getSession(id);
    if (!session) throw new AgentRequestError("Agent 会话不存在");
    if (session.mode !== "isolated_worktree" || !session.branch || session.workspaceLifecycle === "removed") return { removed: false };
    if (!session.baseCommit) throw new AgentConflictError("隔离开发会话缺少 Git 基线");
    const repository = this.store.getRepository(session.repositoryId);
    if (!repository) throw new AgentRequestError("Agent 仓库不存在");
    const state = await this.workspaces.status(repository, session.workspacePath, session.baseCommit);
    const risk = state.dirty || state.unmergedCommits > 0
      ? `工作区包含${state.dirty ? "未提交修改" : ""}${state.dirty && state.unmergedCommits ? "和" : ""}${state.unmergedCommits ? `${state.unmergedCommits} 个未合并提交` : ""}。`
      : "工作区当前干净。";
    const confirmation = this.store.createConfirmation({
      sessionId: id,
      kind: "workspace_cleanup",
      question: `${risk}确认删除 worktree 和会话分支吗？`,
      options: ["approve", "reject"]
    });
    this.coordinator.events.changed(id);
    return { removed: false, confirmation };
  }

  private async performCleanup(id: string): Promise<void> {
    const session = this.store.getSession(id);
    if (!session || session.mode !== "isolated_worktree" || !session.branch || session.workspaceLifecycle === "removed") return;
    if (!session.baseCommit) throw new AgentConflictError("隔离开发会话缺少 Git 基线");
    const repository = this.store.getRepository(session.repositoryId);
    if (!repository) throw new AgentRequestError("Agent 仓库不存在");
    await this.workspaces.removeWorktree(repository, session.workspacePath, session.branch, session.baseCommit, true);
    this.store.markWorkspaceRemoved(id);
    this.store.addEvent(id, null, "workspace.removed", { path: session.workspacePath, branch: session.branch });
  }
}

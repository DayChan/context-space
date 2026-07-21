import { execFile } from "node:child_process";
import { realpath, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentRepository } from "../core/types";

const execFileAsync = promisify(execFile);

export interface GitCommandRunner {
  run(cwd: string, args: string[]): Promise<string>;
}

export class NodeGitCommandRunner implements GitCommandRunner {
  async run(cwd: string, args: string[]): Promise<string> {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000
    });
    return result.stdout.trim();
  }
}

export class InvalidAgentRepositoryError extends Error {}
export class UnsafeWorktreeCleanupError extends Error {
  constructor(readonly dirty: boolean, readonly unmergedCommits: number) {
    super("worktree 包含未提交修改或未合并提交，需要人工确认");
  }
}

export class GitWorkspaceService {
  private readonly worktreeRoot: string;
  constructor(
    workspaceRoot: string,
    private readonly git: GitCommandRunner = new NodeGitCommandRunner(),
    private readonly homeDirectory = homedir()
  ) {
    this.worktreeRoot = path.join(path.resolve(workspaceRoot), ".context", "agent-worktrees");
  }

  async inspectLocation(inputPath: string): Promise<{
    name: string;
    path: string;
    kind: AgentRepository["kind"];
    headCommit: string | null;
    branch: string | null;
  }> {
    const expandedPath = inputPath === "~"
      ? this.homeDirectory
      : inputPath.startsWith("~/")
        ? path.join(this.homeDirectory, inputPath.slice(2))
        : inputPath;
    let resolved: string;
    try { resolved = await realpath(path.resolve(expandedPath)); }
    catch { throw new InvalidAgentRepositoryError("工作目录路径不存在"); }
    if (!(await stat(resolved)).isDirectory()) throw new InvalidAgentRepositoryError("路径不是目录");
    let top: string;
    try { top = await this.git.run(resolved, ["rev-parse", "--show-toplevel"]); }
    catch {
      return {
        name: path.basename(resolved) || resolved,
        path: resolved,
        kind: "directory",
        headCommit: null,
        branch: null
      };
    }
    const canonical = await realpath(top);
    const headCommit = await this.git.run(canonical, ["rev-parse", "HEAD"]);
    const branchText = await this.git.run(canonical, ["branch", "--show-current"]);
    return { name: path.basename(canonical), path: canonical, kind: "git", headCommit, branch: branchText || null };
  }

  async createWorktree(repository: AgentRepository, sessionId: string, baseCommit = repository.headCommit): Promise<{ path: string; branch: string; baseCommit: string }> {
    if (repository.kind !== "git" || !baseCommit) {
      throw new InvalidAgentRepositoryError("普通目录仅支持只读模式，无法创建 Git worktree");
    }
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const target = path.join(this.worktreeRoot, repository.id, safeSession);
    const branch = `context-space/${safeSession}`;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await this.git.run(repository.path, ["worktree", "add", "-b", branch, target, baseCommit]);
    return { path: target, branch, baseCommit };
  }

  async status(repository: AgentRepository, workspacePath: string, baseCommit: string): Promise<{ dirty: boolean; unmergedCommits: number }> {
    const dirty = Boolean(await this.git.run(workspacePath, ["status", "--porcelain"]));
    const count = Number(await this.git.run(workspacePath, ["rev-list", "--count", `${baseCommit}..HEAD`])) || 0;
    return { dirty, unmergedCommits: count };
  }

  async removeWorktree(repository: AgentRepository, workspacePath: string, branch: string, baseCommit: string, confirmed = false): Promise<void> {
    const expectedRoot = path.join(this.worktreeRoot, repository.id) + path.sep;
    const resolved = path.resolve(workspacePath);
    if (!resolved.startsWith(expectedRoot)) throw new Error("拒绝清理 Context Space 管理目录之外的 worktree");
    const state = await this.status(repository, workspacePath, baseCommit);
    if ((state.dirty || state.unmergedCommits > 0) && !confirmed) {
      throw new UnsafeWorktreeCleanupError(state.dirty, state.unmergedCommits);
    }
    await this.git.run(repository.path, ["worktree", "remove", ...(confirmed ? ["--force"] : []), workspacePath]);
    await this.git.run(repository.path, ["branch", "-D", branch]);
  }
}

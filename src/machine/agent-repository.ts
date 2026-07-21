import { randomUUID } from "node:crypto";
import { AgentConflictError, AgentRequestError } from "../core/agent-errors";
import type {
  AgentAttention,
  AgentConfirmation,
  AgentEvent,
  AgentMessage,
  AgentOutcome,
  AgentRepository,
  AgentSession,
  AgentTurn,
  AgentWorkspaceMode
} from "../core/types";
import { MachineDatabase } from "./database";
import { decodeJson, encodeJson } from "./json";

interface RepositoryRow {
  id: string; name: string; path: string; head_commit: string; branch: string | null;
  kind: AgentRepository["kind"];
  created_at: string; updated_at: string;
}
interface SessionRow {
  id: string; title: string; source_kind: "todo" | "meego"; source_id: string;
  repository_id: string; mode: AgentWorkspaceMode; workspace_path: string;
  branch: string | null; base_commit: string; thread_id: string | null;
  status: AgentSession["status"]; attention: AgentAttention;
  workspace_lifecycle: AgentSession["workspaceLifecycle"];
  created_at: string; updated_at: string; ended_at: string | null;
}
interface MessageRow {
  id: string; session_id: string; turn_id: string | null;
  role: AgentMessage["role"]; content: string; created_at: string;
}
interface TurnRow {
  id: string; session_id: string; input_message_id: string; status: AgentTurn["status"];
  outcome: AgentOutcome | null; usage_json: string | null; error: string | null;
  created_at: string; started_at: string | null; completed_at: string | null;
}
interface EventRow {
  sequence: number; id: string; session_id: string; turn_id: string | null;
  type: string; data_json: string; created_at: string;
}
interface ConfirmationRow {
  id: string; session_id: string; turn_id: string | null;
  kind: AgentConfirmation["kind"]; question: string; options_json: string;
  status: AgentConfirmation["status"]; answer_json: string | null;
  created_at: string; answered_at: string | null;
}

function nowIso(): string { return new Date().toISOString(); }

export class AgentRepositoryStore {
  constructor(private readonly database: MachineDatabase) {}

  addRepository(input: { name: string; path: string; kind: AgentRepository["kind"]; headCommit: string | null; branch: string | null }): AgentRepository {
    const timestamp = nowIso();
    const existing = this.database.connection.prepare("SELECT * FROM agent_repositories WHERE path = ?").get(input.path) as RepositoryRow | undefined;
    if (existing) {
      this.database.connection.prepare(
        "UPDATE agent_repositories SET name = ?, kind = ?, head_commit = ?, branch = ?, updated_at = ? WHERE id = ?"
      ).run(input.name, input.kind, input.headCommit ?? "", input.branch, timestamp, existing.id);
      return this.getRepository(existing.id)!;
    }
    const id = `repo_${randomUUID()}`;
    this.database.connection.prepare(
      `INSERT INTO agent_repositories(id, name, path, head_commit, branch, created_at, updated_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.name, input.path, input.headCommit ?? "", input.branch, timestamp, timestamp, input.kind);
    return this.getRepository(id)!;
  }

  listRepositories(): AgentRepository[] {
    return (this.database.connection.prepare("SELECT * FROM agent_repositories ORDER BY name, path").all() as RepositoryRow[])
      .map((row) => this.hydrateRepository(row));
  }

  getRepository(id: string): AgentRepository | null {
    const row = this.database.connection.prepare("SELECT * FROM agent_repositories WHERE id = ?").get(id) as RepositoryRow | undefined;
    return row ? this.hydrateRepository(row) : null;
  }

  updateRepositorySnapshot(id: string, input: {
    kind: AgentRepository["kind"];
    headCommit: string | null;
    branch: string | null;
  }): AgentRepository {
    const changed = this.database.connection.prepare(
      "UPDATE agent_repositories SET kind = ?, head_commit = ?, branch = ?, updated_at = ? WHERE id = ?"
    ).run(input.kind, input.headCommit ?? "", input.branch, nowIso(), id);
    if (!changed.changes) throw new AgentRequestError("Agent 工作目录不存在");
    return this.getRepository(id)!;
  }

  removeRepository(id: string): boolean {
    const active = this.database.connection.prepare(
      "SELECT 1 FROM agent_sessions WHERE repository_id = ? AND status = 'active' LIMIT 1"
    ).get(id);
    if (active) throw new AgentConflictError("工作目录仍被活跃 Agent 会话使用");
    return this.database.connection.prepare("DELETE FROM agent_repositories WHERE id = ?").run(id).changes === 1;
  }

  createSession(input: {
    title: string; sourceKind: "todo" | "meego"; sourceId: string;
    repositoryId: string; mode: AgentWorkspaceMode; workspacePath: string;
    branch: string | null; baseCommit: string | null; prompt: string; id?: string;
  }): AgentSession {
    const id = input.id ?? `session_${randomUUID()}`;
    const messageId = `message_${randomUUID()}`;
    const turnId = `turn_${randomUUID()}`;
    const timestamp = nowIso();
    this.database.transaction(() => {
      this.database.connection.prepare(
        `INSERT INTO agent_sessions(
          id, title, source_kind, source_id, repository_id, mode, workspace_path,
          branch, base_commit, status, attention, workspace_lifecycle, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'none', 'ready', ?, ?)`
      ).run(id, input.title, input.sourceKind, input.sourceId, input.repositoryId, input.mode,
        input.workspacePath, input.branch, input.baseCommit ?? "", timestamp, timestamp);
      this.insertMessage({ id: messageId, sessionId: id, turnId, role: "user", content: input.prompt, createdAt: timestamp });
      this.database.connection.prepare(
        `INSERT INTO agent_turns(id, session_id, input_message_id, status, created_at)
         VALUES (?, ?, ?, 'queued', ?)`
      ).run(turnId, id, messageId, timestamp);
    });
    return this.getSession(id, true)!;
  }

  enqueueMessage(sessionId: string, content: string): AgentTurn {
    const session = this.getSession(sessionId);
    if (!session) throw new AgentRequestError("Agent 会话不存在");
    if (session.status !== "active") throw new AgentConflictError("Agent 会话已结束");
    const messageId = `message_${randomUUID()}`;
    const turnId = `turn_${randomUUID()}`;
    const timestamp = nowIso();
    this.database.transaction(() => {
      this.insertMessage({ id: messageId, sessionId, turnId, role: "user", content, createdAt: timestamp });
      this.database.connection.prepare(
        "INSERT INTO agent_turns(id, session_id, input_message_id, status, created_at) VALUES (?, ?, ?, 'queued', ?)"
      ).run(turnId, sessionId, messageId, timestamp);
      this.database.connection.prepare(
        "UPDATE agent_sessions SET attention = 'none', updated_at = ? WHERE id = ?"
      ).run(timestamp, sessionId);
    });
    return this.getTurn(turnId)!;
  }

  nextQueuedTurn(sessionId: string): AgentTurn | null {
    const row = this.database.connection.prepare(
      "SELECT * FROM agent_turns WHERE session_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1"
    ).get(sessionId) as TurnRow | undefined;
    return row ? this.hydrateTurn(row) : null;
  }

  startTurn(turnId: string): AgentTurn {
    const timestamp = nowIso();
    const changed = this.database.connection.prepare(
      "UPDATE agent_turns SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'"
    ).run(timestamp, turnId);
    if (!changed.changes) throw new Error(`Agent Turn 不可启动：${turnId}`);
    this.database.connection.prepare(
      "UPDATE agent_sessions SET attention = 'none', updated_at = ? WHERE id = (SELECT session_id FROM agent_turns WHERE id = ?)"
    ).run(timestamp, turnId);
    return this.getTurn(turnId)!;
  }

  completeTurn(input: {
    turnId: string; threadId: string; message: string; outcome: AgentOutcome;
    usage: Record<string, number> | null;
    confirmation?: { kind?: AgentConfirmation["kind"]; question: string; options: string[] };
  }): void {
    const turn = this.getTurn(input.turnId);
    if (!turn || turn.status !== "running") throw new Error(`Agent Turn 不在运行：${input.turnId}`);
    const timestamp = nowIso();
    const attention: AgentAttention = input.outcome === "needs_confirmation"
      ? "confirmation_required"
      : input.outcome === "completed" ? "review_required" : "reply_required";
    this.database.transaction(() => {
      this.database.connection.prepare(
        `UPDATE agent_turns SET status = 'succeeded', outcome = ?, usage_json = ?, completed_at = ? WHERE id = ?`
      ).run(input.outcome, input.usage ? encodeJson(input.usage) : null, timestamp, input.turnId);
      this.insertMessage({ id: `message_${randomUUID()}`, sessionId: turn.sessionId, turnId: turn.id,
        role: "assistant", content: input.message, createdAt: timestamp });
      this.database.connection.prepare(
        "UPDATE agent_sessions SET thread_id = ?, attention = ?, updated_at = ? WHERE id = ?"
      ).run(input.threadId, attention, timestamp, turn.sessionId);
      if (input.outcome === "needs_confirmation" && input.confirmation) {
        this.database.connection.prepare(
          `INSERT INTO agent_confirmations(
            id, session_id, turn_id, kind, question, options_json, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
        ).run(`confirmation_${randomUUID()}`, turn.sessionId, turn.id,
          input.confirmation.kind ?? "decision", input.confirmation.question,
          encodeJson(input.confirmation.options), timestamp);
      }
    });
  }

  failTurn(turnId: string, error: string, status: "failed" | "cancelled" | "interrupted" = "failed"): void {
    const timestamp = nowIso();
    this.database.connection.prepare(
      "UPDATE agent_turns SET status = ?, error = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'running')"
    ).run(status, error, timestamp, turnId);
    this.database.connection.prepare(
      "UPDATE agent_sessions SET attention = 'reply_required', updated_at = ? WHERE id = (SELECT session_id FROM agent_turns WHERE id = ?)"
    ).run(timestamp, turnId);
  }

  updateThreadId(sessionId: string, threadId: string): void {
    this.database.connection.prepare("UPDATE agent_sessions SET thread_id = ?, updated_at = ? WHERE id = ?")
      .run(threadId, nowIso(), sessionId);
  }

  addEvent(sessionId: string, turnId: string | null, type: string, data: Record<string, unknown>): AgentEvent {
    const id = `event_${randomUUID()}`;
    const timestamp = nowIso();
    this.database.connection.prepare(
      "INSERT INTO agent_events(id, session_id, turn_id, type, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, sessionId, turnId, type, encodeJson(data), timestamp);
    const row = this.database.connection.prepare("SELECT * FROM agent_events WHERE id = ?").get(id) as EventRow;
    return this.hydrateEvent(row);
  }

  createConfirmation(input: {
    sessionId: string;
    kind: AgentConfirmation["kind"];
    question: string;
    options: string[];
    turnId?: string | null;
  }): AgentConfirmation {
    const session = this.getSession(input.sessionId);
    if (!session) throw new AgentRequestError("Agent 会话不存在");
    const existing = this.database.connection.prepare(
      "SELECT * FROM agent_confirmations WHERE session_id = ? AND kind = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
    ).get(input.sessionId, input.kind) as ConfirmationRow | undefined;
    if (existing) return this.hydrateConfirmation(existing);
    const id = `confirmation_${randomUUID()}`;
    const timestamp = nowIso();
    this.database.transaction(() => {
      this.database.connection.prepare(
        `INSERT INTO agent_confirmations(
          id, session_id, turn_id, kind, question, options_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
      ).run(id, input.sessionId, input.turnId ?? null, input.kind, input.question, encodeJson(input.options), timestamp);
      this.database.connection.prepare(
        "UPDATE agent_sessions SET attention = 'confirmation_required', updated_at = ? WHERE id = ?"
      ).run(timestamp, input.sessionId);
    });
    return this.getConfirmation(id)!;
  }

  answerConfirmation(
    id: string,
    answer: { selection?: string; text?: string },
    enqueueTurn = true
  ): { confirmation: AgentConfirmation; turn: AgentTurn | null } {
    return this.database.transaction(() => {
      const before = this.getConfirmation(id);
      if (!before) throw new AgentRequestError("人工确认不存在");
      if (before.status !== "pending") return { confirmation: before, turn: null };
      const timestamp = nowIso();
      const status = answer.selection === "reject" ? "rejected" : answer.selection === "approve" ? "approved" : "answered";
      this.database.connection.prepare(
        "UPDATE agent_confirmations SET status = ?, answer_json = ?, answered_at = ? WHERE id = ? AND status = 'pending'"
      ).run(status, encodeJson(answer), timestamp, id);
      const content = `人工确认回答：${answer.selection ?? answer.text ?? "已回答"}`;
      const turn = enqueueTurn ? this.enqueueMessage(before.sessionId, content) : null;
      if (!enqueueTurn) {
        this.insertMessage({ id: `message_${randomUUID()}`, sessionId: before.sessionId, turnId: null,
          role: "user", content, createdAt: timestamp });
        this.database.connection.prepare(
          "UPDATE agent_sessions SET attention = 'none', updated_at = ? WHERE id = ?"
        ).run(timestamp, before.sessionId);
      }
      return { confirmation: this.getConfirmation(id)!, turn };
    });
  }

  finishSession(id: string, status: "completed" | "cancelled"): AgentSession {
    const timestamp = nowIso();
    const changed = this.database.connection.prepare(
      "UPDATE agent_sessions SET status = ?, attention = 'none', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'active'"
    ).run(status, timestamp, timestamp, id);
    if (!changed.changes) throw new AgentConflictError("Agent 会话不存在或已结束");
    return this.getSession(id, true)!;
  }

  switchWorkspace(id: string, input: { path: string; branch: string; baseCommit: string }): AgentSession {
    const timestamp = nowIso();
    this.database.transaction(() => {
      this.database.connection.prepare(
        `UPDATE agent_sessions SET mode = 'isolated_worktree', workspace_path = ?, branch = ?,
          base_commit = ?, updated_at = ? WHERE id = ? AND status = 'active'`
      ).run(input.path, input.branch, input.baseCommit, timestamp, id);
      this.insertMessage({ id: `message_${randomUUID()}`, sessionId: id, turnId: null, role: "system",
        content: `工作区已切换为独立 worktree：${input.branch}`, createdAt: timestamp });
    });
    return this.getSession(id, true)!;
  }

  markWorkspaceRemoved(id: string): void {
    this.database.connection.prepare(
      "UPDATE agent_sessions SET workspace_lifecycle = 'removed', updated_at = ? WHERE id = ?"
    ).run(nowIso(), id);
  }

  reconcileInterrupted(): number {
    const timestamp = nowIso();
    return this.database.transaction(() => {
      const result = this.database.connection.prepare(
        "UPDATE agent_turns SET status = 'interrupted', error = '服务重启中断了运行', completed_at = ? WHERE status = 'running'"
      ).run(timestamp);
      this.database.connection.prepare(
        `UPDATE agent_sessions SET attention = 'reply_required', updated_at = ?
         WHERE id IN (SELECT DISTINCT session_id FROM agent_turns WHERE status = 'interrupted') AND status = 'active'`
      ).run(timestamp);
      return result.changes;
    });
  }

  listSessions(): AgentSession[] {
    return (this.database.connection.prepare("SELECT * FROM agent_sessions ORDER BY updated_at DESC").all() as SessionRow[])
      .map((row) => this.getSession(row.id, true)!);
  }

  getSession(id: string, details = false): AgentSession | null {
    const row = this.database.connection.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) return null;
    const session = this.hydrateSession(row);
    session.repository = this.getRepository(session.repositoryId) ?? undefined;
    if (details) {
      session.messages = this.listMessages(id);
      session.turns = this.listTurns(id);
      session.events = this.listEvents(id);
      session.confirmations = this.listConfirmations(id);
    }
    return session;
  }

  getTurn(id: string): AgentTurn | null {
    const row = this.database.connection.prepare("SELECT * FROM agent_turns WHERE id = ?").get(id) as TurnRow | undefined;
    return row ? this.hydrateTurn(row) : null;
  }

  getMessage(id: string): AgentMessage | null {
    const row = this.database.connection.prepare("SELECT * FROM agent_messages WHERE id = ?").get(id) as MessageRow | undefined;
    return row ? this.hydrateMessage(row) : null;
  }

  getConfirmation(id: string): AgentConfirmation | null {
    const row = this.database.connection.prepare("SELECT * FROM agent_confirmations WHERE id = ?").get(id) as ConfirmationRow | undefined;
    return row ? this.hydrateConfirmation(row) : null;
  }

  private insertMessage(message: AgentMessage): void {
    this.database.connection.prepare(
      "INSERT INTO agent_messages(id, session_id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(message.id, message.sessionId, message.turnId, message.role, message.content, message.createdAt);
  }
  private listMessages(id: string): AgentMessage[] { return (this.database.connection.prepare("SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at, id").all(id) as MessageRow[]).map((r) => this.hydrateMessage(r)); }
  private listTurns(id: string): AgentTurn[] { return (this.database.connection.prepare("SELECT * FROM agent_turns WHERE session_id = ? ORDER BY created_at, id").all(id) as TurnRow[]).map((r) => this.hydrateTurn(r)); }
  private listEvents(id: string): AgentEvent[] { return (this.database.connection.prepare("SELECT * FROM agent_events WHERE session_id = ? ORDER BY sequence DESC LIMIT 200").all(id) as EventRow[]).reverse().map((r) => this.hydrateEvent(r)); }
  private listConfirmations(id: string): AgentConfirmation[] { return (this.database.connection.prepare("SELECT * FROM agent_confirmations WHERE session_id = ? ORDER BY created_at").all(id) as ConfirmationRow[]).map((r) => this.hydrateConfirmation(r)); }
  private hydrateRepository(r: RepositoryRow): AgentRepository { return { id: r.id, name: r.name, path: r.path, kind: r.kind, headCommit: r.head_commit || null, branch: r.branch, createdAt: r.created_at, updatedAt: r.updated_at }; }
  private hydrateSession(r: SessionRow): AgentSession { return { id: r.id, title: r.title, sourceKind: r.source_kind, sourceId: r.source_id, repositoryId: r.repository_id, mode: r.mode, workspacePath: r.workspace_path, branch: r.branch, baseCommit: r.base_commit || null, threadId: r.thread_id, status: r.status, attention: r.attention, workspaceLifecycle: r.workspace_lifecycle, createdAt: r.created_at, updatedAt: r.updated_at, endedAt: r.ended_at }; }
  private hydrateMessage(r: MessageRow): AgentMessage { return { id: r.id, sessionId: r.session_id, turnId: r.turn_id, role: r.role, content: r.content, createdAt: r.created_at }; }
  private hydrateTurn(r: TurnRow): AgentTurn { return { id: r.id, sessionId: r.session_id, inputMessageId: r.input_message_id, status: r.status, outcome: r.outcome, usage: r.usage_json ? decodeJson<Record<string, number>>(r.usage_json) : null, error: r.error, createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at }; }
  private hydrateEvent(r: EventRow): AgentEvent { return { id: r.id, sequence: r.sequence, sessionId: r.session_id, turnId: r.turn_id, type: r.type, data: decodeJson<Record<string, unknown>>(r.data_json), createdAt: r.created_at }; }
  private hydrateConfirmation(r: ConfirmationRow): AgentConfirmation { return { id: r.id, sessionId: r.session_id, turnId: r.turn_id, kind: r.kind, question: r.question, options: decodeJson<string[]>(r.options_json), status: r.status, answer: r.answer_json ? decodeJson<{ selection?: string; text?: string }>(r.answer_json) : null, createdAt: r.created_at, answeredAt: r.answered_at }; }
}

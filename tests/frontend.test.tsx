// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  AgentSession,
  LeaderConfig,
  LarkPermissionPreflight,
  Overview,
  OpenSpecChangeSummary,
  OpenSpecReadiness,
  OpenSpecWorkflow,
  PersonMetadata,
  SourceMetadata,
  SyncStatus,
  TodoMetadata
} from "../src/core/types";
import {
  DEFAULT_AUTOMATION,
  EMPTY_MEEGO_SYNC_STATUS,
  EMPTY_SYNC_STATUS,
  type MeegoConfig,
  type MeegoSyncStatus
} from "../src/core/types";
import type { AnalysisConfig } from "../src/analysis/contracts";
import type { StoredCandidate } from "../src/machine";
import { AppView } from "../src/web/App";

const owedTodo: TodoMetadata = {
  schema: "work-context/todo@1",
  id: "todo_owed",
  type: "todo",
  title: "准备发布计划",
  managed: "hybrid",
  created_at: "2026-07-20T00:00:00Z",
  updated_at: "2026-07-20T00:00:00Z",
  source_refs: ["lark:message:om_1"],
  status: "open",
  direction: "owed_by_me",
  owner: "self",
  stakeholders: ["person_leader"],
  due_at: "2026-07-21T00:00:00Z",
  explicit: true,
  upstream: "extracted_context",
  confidence: 0.9,
  analysis: {
    run_id: "analysis_run_123",
    item_key: "item_123",
    provider: "codex-sdk",
    prompt_version: "context-analysis@4",
    schema_version: "work-context/analysis@2",
    analyzed_at: "2026-07-20T01:00:00Z",
    evidence: ["准备发布计划"],
    reason: "明确行动项"
  },
  priority: {
    base: 50,
    manual: null,
    effective: 80,
    reasons: [{ key: "leader", label: "Leader 相关交付", value: 20 }]
  },
  automation: DEFAULT_AUTOMATION
};

const waitingTodo: TodoMetadata = {
  ...owedTodo,
  id: "todo_waiting",
  title: "等待 Alice 评审",
  direction: "waiting_on_them",
  priority: { ...owedTodo.priority, effective: 58, reasons: [] }
};

const personWithInsight: PersonMetadata = {
  schema: "work-context/person@1",
  id: "person_alice",
  type: "person",
  title: "Alice",
  managed: "hybrid",
  created_at: "2026-07-20T00:00:00Z",
  updated_at: "2026-07-20T02:00:00Z",
  source_refs: ["lark:message:person_1", "lark:message:person_2"],
  identities: [
    {
      provider: "lark",
      external_id: "ou_alice",
      display_name: "Alice"
    }
  ],
  role: null,
  role_origin: null,
  is_leader: false,
  leader_boost: 20,
  observations: [
    {
      text: "在关键评审前主动汇总阻塞项。",
      evidence: ["Alice 负责发布流程", "Alice 会在评审前汇总阻塞项"],
      confidence: 0.86,
      observed_at: "2026-07-20T02:00:00Z",
      origin: "inferred",
      category: "collaboration_style",
      source_refs: ["lark:message:person_1", "lark:message:person_2"],
      insight_key: "insight_1",
      stale: false
    }
  ],
  last_interaction_at: "2026-07-20T02:00:00Z"
};

const personBob: PersonMetadata = {
  ...personWithInsight,
  id: "person_bob",
  title: "Bob",
  source_refs: ["lark:message:bob_1"],
  identities: [
    {
      provider: "lark",
      external_id: "ou_bob",
      display_name: "Robert"
    }
  ],
  role: "后端负责人",
  role_origin: "manual",
  observations: [
    {
      text: "负责数据库容量规划。",
      evidence: ["Bob 维护容量基线"],
      confidence: 0.92,
      observed_at: "2026-07-19T02:00:00Z",
      origin: "inferred",
      category: "responsibility",
      source_refs: ["lark:message:bob_1"]
    }
  ]
};

const personProvenanceSources = Array.from({ length: 11 }, (_, index) => {
  if (index === 0) {
    return {
      id: "lark:message:person_2",
      provider: "lark",
      title: "Alice",
      body: "# Alice\n\n**Occurred:** 2026-07-20T02:00:00Z\n\nAlice 会在评审前汇总阻塞项",
      occurred_at: "2026-07-20T02:00:00Z",
      source_kind: "p2p",
      conversation: { type: "direct" as const, name: "Alice" },
      sender: {
        person_id: "person_sender_private",
        display_name: "私聊发送者"
      }
    };
  }
  if (index === 1) {
    return {
      id: "lark:message:person_1",
      provider: "lark",
      title: "发布评审群",
      body: "# 发布评审群\n\n**Occurred:** 2026-07-20T01:30:00Z\n\nAlice 负责发布流程",
      occurred_at: "2026-07-20T01:30:00Z",
      source_kind: "mention",
      conversation: { type: "group" as const, name: "发布评审群" },
      sender: {
        person_id: "person_sender_group",
        display_name: "群聊发送者"
      }
    };
  }
  return {
    id: `lark:message:person_extra_${index}`,
    provider: "lark",
    title: `历史讨论 ${index}`,
    body: `# 历史讨论 ${index}\n\n第 ${index} 条历史消息`,
    occurred_at: `2026-07-${String(20 - index).padStart(2, "0")}T00:00:00Z`,
    source_kind: "p2p",
    conversation: { type: "direct" as const, name: `历史讨论 ${index}` },
    sender: null
  };
});

const overview: Overview = {
  topTodos: [owedTodo],
  upcomingCalendar: Array.from({ length: 6 }, (_, index) => ({
    schema: "work-context/source@1" as const,
    id: `calendar_home_${index + 1}`,
    type: "source" as const,
    title: index === 0 ? "发布评审会议" : `未来日程 ${index + 1}`,
    managed: "generated" as const,
    created_at: `2026-07-22T${String(10 + index).padStart(2, "0")}:00:00Z`,
    updated_at: `2026-07-22T${String(10 + index).padStart(2, "0")}:00:00Z`,
    source_refs: [],
    provider: "lark" as const,
    source_kind: "calendar" as const,
    source_id: `lark:calendar:calendar_home_${index + 1}`,
    occurred_at: `2026-07-22T${String(10 + index).padStart(2, "0")}:00:00Z`,
    participants: [],
    provider_metadata: {
      end: `2026-07-22T${String(11 + index).padStart(2, "0")}:00:00Z`,
      location: index === 0 ? "发布会议室" : ""
    }
  })),
  recentMentions: [],
  upstreamTasks: [],
  waitingItems: [waitingTodo],
  reviewCandidates: [],
  knowledgeChanges: [],
  loopReadiness: {
    futureAutomatable: [],
    confirmationRequired: [],
    blocked: [],
    recentRuns: []
  },
  syncStatus: EMPTY_SYNC_STATUS,
  counts: { todos: 2, people: 1, knowledge: 0, inbox: 0 }
};

const timelineItems: SourceMetadata[] = Array.from(
  { length: 21 },
  (_, index) => {
    const occurredAt = `2026-07-${String(20 - Math.floor(index / 2)).padStart(2, "0")}T${String(23 - (index % 2)).padStart(2, "0")}:00:00Z`;
    return {
      schema: "work-context/source@1",
      id: `timeline_item_${index + 1}`,
      type: "source",
      title: `Timeline item ${index + 1}`,
      managed: "generated",
      created_at: occurredAt,
      updated_at: occurredAt,
      source_refs: [],
      provider: "lark",
      source_kind: "calendar",
      source_id: `lark:calendar:timeline_item_${index + 1}`,
      occurred_at: occurredAt,
      participants: [],
      provider_metadata: {}
    };
  }
);

function jsonResponse(payload: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  } as Response);
}

let selectedProvider = "codex-sdk";
let selectedModel: string | null = null;
let selectedReasoningEffort: AnalysisConfig["reasoning_effort"] = "medium";
let selectedWorkerCount = 1;
let selectedSyncSchedule = {
  enabled: false,
  interval: 1,
  unit: "hours" as "minutes" | "hours"
};
let larkStatus: SyncStatus = EMPTY_SYNC_STATUS;
let larkPermissionPreflight: LarkPermissionPreflight;
let meegoConfig: MeegoConfig = {
  enabled: false,
  qTagTimelineEnabled: false,
  projectKeys: []
};
let meegoStatus: MeegoSyncStatus = EMPTY_MEEGO_SYNC_STATUS;
let owedTodoStatus: TodoMetadata["status"] = "open";
let configuredLeaders: LeaderConfig[] = [];
let inboxCandidates: Array<StoredCandidate & { acceptance: null }> = [];
let agentRepositories: AgentRepository[] = [];
let agentSessions: AgentSession[] = [];
let openSpecReadiness: OpenSpecReadiness;
let openSpecChanges: OpenSpecChangeSummary[] = [];
let openSpecWorkflows: Record<string, OpenSpecWorkflow> = {};

function configResponse() {
  return {
    leaders: configuredLeaders,
    lark: {
      status: larkStatus,
      readOnly: true,
      identity: "user",
      schedule: {
        config: selectedSyncSchedule,
        running: true,
        next_run_at: null
      }
    },
    meego: {
      config: meegoConfig,
      status: meegoStatus,
      readOnly: true
    },
    loop: { enabled: true, automaticExecutionEnabled: false, executionEndpoint: "/api/agent/sessions" },
    retention: { source_body_days: 90 },
    analysis: {
      current_provider: selectedProvider,
      config_source: "workspace",
      provider_locked: false,
      worker_count: selectedWorkerCount,
      worker_count_source: "workspace",
      worker_count_locked: false,
      config: {
        provider: selectedProvider,
        model: selectedModel,
        reasoning_effort: selectedReasoningEffort,
        timeout_ms: 120000,
        max_source_chars: 20000,
        max_batch_records: 50,
        max_batch_source_chars: 60000,
        max_output_bytes: 2000000,
        prompt_version: "context-analysis@4",
        retain_runs: 50,
        max_reanalysis_records: 50
      },
      providers: [
        { id: "codex-sdk", available: true, detail: "SDK 可用" },
        { id: "codex-exec", available: true, detail: "CLI 可用" },
        { id: "traex", available: true, detail: "traex CLI 可用" }
      ],
      prompt_version: "context-analysis@4",
      schema_version: "work-context/analysis@2",
      status: {
        schema: "work-context/analysis-status@1",
        id: "analysis_status",
        type: "analysis-status",
        title: "LLM 分析状态",
        managed: "generated",
        created_at: "2026-07-20T00:00:00Z",
        updated_at: "2026-07-20T01:00:00Z",
        source_refs: [],
        last_run_id: "analysis_run_123",
        last_status: "succeeded",
        last_provider: "codex-sdk",
        last_completed_at: "2026-07-20T01:00:00Z",
        last_error_code: null,
        last_error_message: null
      },
      queue: {
        queued: 0,
        leased: 0,
        succeeded: 1,
        failed_retryable: 0,
        failed_terminal: 0
      },
      failed_jobs: [],
      recent_runs: []
    }
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  selectedProvider = "codex-sdk";
  selectedModel = null;
  selectedReasoningEffort = "medium";
  selectedWorkerCount = 1;
  selectedSyncSchedule = { enabled: false, interval: 1, unit: "hours" };
  larkStatus = EMPTY_SYNC_STATUS;
  larkPermissionPreflight = {
    state: "ready",
    ready: true,
    required_scopes: [
      "auth:user.id:read",
      "search:message",
      "calendar:calendar.event:read",
      "task:task:read"
    ],
    granted_scopes: [
      "auth:user.id:read",
      "search:message",
      "calendar:calendar.event:read",
      "task:task:read"
    ],
    missing_scopes: [],
    checked_at: "2026-07-22T00:00:00.000Z",
    initial_sync_completed: false,
    message: "飞书同步所需权限已就绪。",
    authorization_command: null
  };
  meegoConfig = {
    enabled: false,
    qTagTimelineEnabled: false,
    projectKeys: []
  };
  meegoStatus = EMPTY_MEEGO_SYNC_STATUS;
  owedTodoStatus = "open";
  configuredLeaders = [];
  agentRepositories = [];
  agentSessions = [];
  openSpecReadiness = { initialized: true, skillsReady: true, ready: true, missing: [] };
  openSpecChanges = [];
  openSpecWorkflows = {};
  inboxCandidates = [
    {
      id: "candidate_frontend",
      runId: "analysis_run_frontend",
      stableKey: "candidate-key",
      kind: "knowledge",
      status: "proposed",
      title: "确认上线检查项",
      data: {
        knowledge_kind: "playbook",
        summary: "上线前需要检查关键项目。",
        tags: ["release"]
      },
      sourceRefs: ["lark:message:frontend"],
      confidence: 0.9,
      reason: "需要人工确认后进入知识库。",
      provider: "codex-sdk",
      promptVersion: "context-analysis@4",
      analyzedAt: "2026-07-20T01:00:00Z",
      createdAt: "2026-07-20T01:00:00Z",
      reviewedAt: null,
      evidence: [
        {
          sourceId: "lark:message:frontend",
          quote: "确认上线检查项"
        }
      ],
      acceptance: null
    }
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/security/csrf") {
        return jsonResponse({ token: "frontend-csrf-token" });
      }
      if (url === "/api/config/analysis") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          provider?: string;
          model?: string | null;
          reasoning_effort?: AnalysisConfig["reasoning_effort"];
        };
        if (body.provider) selectedProvider = body.provider;
        if ("model" in body) selectedModel = body.model ?? null;
        if (body.reasoning_effort) selectedReasoningEffort = body.reasoning_effort;
        return jsonResponse({
          config: {
            provider: selectedProvider,
            model: selectedModel,
            reasoning_effort: selectedReasoningEffort
          }
        });
      }
      if (url === "/api/config/analysis/workers") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          worker_count: number;
        };
        selectedWorkerCount = body.worker_count;
        return jsonResponse({
          worker_count: selectedWorkerCount,
          source: "workspace",
          locked: false
        });
      }
      if (url === "/api/config/leaders") {
        configuredLeaders = JSON.parse(
          String(init?.body ?? "[]")
        ) as LeaderConfig[];
        return jsonResponse(configuredLeaders);
      }
      if (url === "/api/config/lark-sync-schedule") {
        selectedSyncSchedule = JSON.parse(
          String(init?.body ?? "{}")
        ) as typeof selectedSyncSchedule;
        return jsonResponse({
          config: selectedSyncSchedule,
          running: true,
          next_run_at: null
        });
      }
      if (url === "/api/config/meego") {
        meegoConfig = JSON.parse(String(init?.body ?? "{}")) as MeegoConfig;
        return jsonResponse({
          config: meegoConfig,
          status: { ...meegoStatus, enabled: meegoConfig.enabled },
          readOnly: true
        });
      }
      if (url === "/api/agent/repositories") {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}")) as { path: string };
          const kind: AgentRepository["kind"] = body.path.includes("notes") ? "directory" : "git";
          const repository: AgentRepository = {
            id: "repo_frontend",
            name: "context-space",
            path: body.path,
            kind,
            headCommit: kind === "git" ? "1234567890abcdef" : null,
            branch: kind === "git" ? "main" : null,
            createdAt: "2026-07-21T00:00:00Z",
            updatedAt: "2026-07-21T00:00:00Z"
          };
          agentRepositories = [repository];
          return jsonResponse(repository, 201);
        }
        return jsonResponse(agentRepositories);
      }
      if (url.includes("/api/agent/repositories/") && url.endsWith("/openspec-readiness")) {
        return jsonResponse(openSpecReadiness);
      }
      if (url.startsWith("/api/agent/repositories/") && init?.method === "DELETE") {
        const id = decodeURIComponent(url.split("/").at(-1) ?? "");
        agentRepositories = agentRepositories.filter((repository) => repository.id !== id);
        return jsonResponse(null, 204);
      }
      if (url === "/api/agent/sessions" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          sourceKind: "todo" | "meego";
          sourceId: string;
          repositoryId: string;
          mode: AgentSession["mode"];
          workflow?: { kind: AgentSession["workflowKind"]; initializeIfMissing?: boolean };
          prompt: string;
        };
        const repository = agentRepositories.find(({ id }) => id === body.repositoryId)!;
        const session: AgentSession = {
          id: "session_frontend",
          title: body.sourceId === "todo_owed" ? owedTodo.title : "Q 标签需求",
          sourceKind: body.sourceKind,
          sourceId: body.sourceId,
          repositoryId: body.repositoryId,
          repository,
          mode: body.mode,
          workflowKind: body.workflow?.kind ?? "direct",
          workspacePath: repository.path,
          branch: body.mode === "isolated_worktree" ? "context-space/session_frontend" : null,
          baseCommit: repository.headCommit,
          threadId: null,
          status: "active",
          attention: "none",
          workspaceLifecycle: "ready",
          createdAt: "2026-07-21T00:00:00Z",
          updatedAt: "2026-07-21T00:00:00Z",
          endedAt: null,
          messages: [{ id: "message_frontend", sessionId: "session_frontend", turnId: "turn_frontend", role: "user", content: body.workflow?.kind === "openspec" ? `$openspec-explore\n\n${body.prompt}` : body.prompt, createdAt: "2026-07-21T00:00:00Z" }],
          turns: [{ id: "turn_frontend", sessionId: "session_frontend", inputMessageId: "message_frontend", status: "queued", outcome: null, usage: null, error: null, createdAt: "2026-07-21T00:00:00Z", startedAt: null, completedAt: null }],
          events: [],
          confirmations: []
        };
        agentSessions = [session];
        return jsonResponse(session, 202);
      }
      if (/\/api\/agent\/sessions\/[^/]+\/openspec\/changes$/.test(url)) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}")) as { name: string; description: string };
          openSpecChanges = [{ name: body.name, completedTasks: 0, totalTasks: 0, status: "no-tasks", lastModified: "2026-07-21T00:04:00Z" }, ...openSpecChanges];
          openSpecWorkflows[body.name] = { changeName: body.name, schemaName: "spec-driven", relativePath: `openspec/changes/${body.name}`, isComplete: false, nodes: [{ id: "proposal", description: "Proposal", outputPath: "proposal.md", requires: [], status: "ready", missingDeps: [] }] };
          return jsonResponse({ id: "turn_openspec_new", status: "queued" }, 202);
        }
        return jsonResponse(openSpecChanges);
      }
      if (url.includes("/openspec/changes/") && url.endsWith("/workflow")) {
        const name = decodeURIComponent(url.split("/openspec/changes/")[1].split("/workflow")[0]);
        return jsonResponse(openSpecWorkflows[name]);
      }
      if (url.startsWith("/api/agent/sessions/")) {
        const id = decodeURIComponent(url.split("/")[4] ?? "");
        return jsonResponse(agentSessions.find((session) => session.id === id));
      }
      if (url.startsWith("/api/candidates/") && url.endsWith("/accept")) {
        const id = decodeURIComponent(url.split("/")[3]);
        const confirmed = inboxCandidates.find(
          (candidate) => candidate.id === id
        );
        inboxCandidates = inboxCandidates.filter(
          (candidate) => candidate.id !== id
        );
        return jsonResponse({
          candidateId: confirmed?.id,
          state: "accepted",
          documentId: confirmed ? `knowledge_${confirmed.id}` : null
        });
      }
      if (url === "/api/sync/lark/preflight") {
        return jsonResponse(larkPermissionPreflight);
      }
      if (url === "/api/sync/lark/status") return jsonResponse(larkStatus);
      if (url === "/api/sync/lark") return jsonResponse(larkStatus);
      if (url === "/api/sync/meego/status") {
        return jsonResponse({ ...meegoStatus, enabled: meegoConfig.enabled });
      }
      if (url === "/api/sync/meego") {
        meegoStatus = {
          enabled: meegoConfig.enabled,
          running: false,
          startedAt: "2026-07-21T01:00:00Z",
          completedAt: "2026-07-21T01:01:00Z",
          results: [],
          lastError: null
        };
        return jsonResponse(meegoStatus);
      }
      if (url === "/api/meego") {
        const qItem = {
          id: "meegle:project_1:story:101",
          title: "Q 标签需求",
          projectKey: "project_1",
          projectName: "Demo Project",
          workItemType: "story",
          workItemTypeName: "需求",
          workItemId: "101",
          updatedAt: "2026-07-20T01:00:00Z",
          tags: ["Q30828"],
          qTags: [{
            raw: "Q30828",
            quarter: 3,
            month: 8,
            day: 28,
            sortKey: 30828
          }],
          primaryQTag: {
            raw: "Q30828",
            quarter: 3,
            month: 8,
            day: 28,
            sortKey: 30828
          },
          completed: false,
          url: "https://project.feishu.cn/demo/story/detail/101"
        };
        return jsonResponse(
          meegoConfig.qTagTimelineEnabled
            ? {
                mode: "q_tag_time",
                items: [qItem],
                groups: [{ qTag: qItem.primaryQTag, items: [qItem] }]
              }
            : { mode: "updated_at", items: [qItem], groups: [] }
        );
      }
      if (url === "/api/todos/todo_owed/status") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          status: TodoMetadata["status"];
        };
        owedTodoStatus = body.status;
        return jsonResponse({
          path: "todos/owed.md",
          data: { ...owedTodo, status: owedTodoStatus },
          body: "",
          etag: "updated"
        });
      }
      if (url === "/api/config") return jsonResponse(configResponse());
      if (url.startsWith("/api/overview")) {
        return jsonResponse({
          ...overview,
          analysisQueue: {
            queued: 0,
            leased: 0,
            succeeded: 1,
            failed_retryable: 0,
            failed_terminal: 0
          }
        });
      }
      if (url.startsWith("/api/timeline")) {
        const parsed = new URL(url, "http://context-space.local");
        const page = Number(parsed.searchParams.get("page") ?? "1");
        const pageSize = Number(parsed.searchParams.get("page_size") ?? "20");
        const pageStart = (page - 1) * pageSize;
        return jsonResponse({
          items: timelineItems.slice(pageStart, pageStart + pageSize),
          pagination: {
            page,
            page_size: pageSize,
            total: timelineItems.length,
            total_pages: Math.ceil(timelineItems.length / pageSize)
          }
        });
      }
      if (url.startsWith("/api/documents?type=todo")) {
        return jsonResponse([
          { path: "todos/owed.md", data: { ...owedTodo, status: owedTodoStatus }, body: "", etag: "1" },
          { path: "todos/waiting.md", data: waitingTodo, body: "", etag: "2" }
        ]);
      }
      if (url === "/api/candidates") {
        return jsonResponse(inboxCandidates);
      }
      if (url === "/api/markdown/diagnostics") return jsonResponse([]);
      if (url === "/api/markdown/status") {
        return jsonResponse({
          watcherRunning: true,
          lastReconciledAt: "2026-07-20T00:00:00Z",
          lastIncrementalAt: null,
          reconcileMilliseconds: 300000
        });
      }
      if (url.startsWith("/api/documents?type=person")) {
        return jsonResponse([
          {
            path: "people/person_alice.md",
            data: personWithInsight,
            body: "# Alice",
            etag: "person-etag"
          },
          {
            path: "people/person_bob.md",
            data: personBob,
            body: "# Bob",
            etag: "person-bob-etag"
          }
        ]);
      }
      if (url.startsWith("/api/loop")) {
        return jsonResponse({
          enabled: true,
          automaticExecutionEnabled: false,
          message: "仅支持人工启动 Agent；自动执行仍未启用。",
          readiness: overview.loopReadiness,
          sessions: agentSessions
        });
      }
      if (url.startsWith("/api/documents/todo_owed")) {
        return jsonResponse({
          path: "todos/owed.md",
          data: { ...owedTodo, status: owedTodoStatus },
          body: "# 准备发布计划\n\n来自群聊上下文。",
          etag: "1",
          provenanceSources: [
            {
              id: "lark:message:om_1",
              provider: "lark",
              title: "发布计划讨论",
              body: "# 发布计划讨论\n\n请在周五前准备发布计划",
              occurred_at: "2026-07-20T01:00:00Z",
              source_kind: "mention",
              conversation: { type: "group", name: "发布计划讨论" },
              sender: {
                person_id: "person_sender_todo",
                display_name: "Alice"
              }
            }
          ],
          provenancePagination: {
            page: 1,
            page_size: 10,
            total: 1,
            total_pages: 1
          }
        });
      }
      if (url.startsWith("/api/documents/candidate_frontend")) {
        return jsonResponse({
          path: ".context/machine/candidates/candidate_frontend",
          data: {
            schema: "work-context/candidate@1",
            id: "candidate_frontend",
            type: "candidate",
            title: "确认上线检查项",
            managed: "generated",
            created_at: "2026-07-20T01:00:00Z",
            updated_at: "2026-07-20T01:00:00Z",
            source_refs: ["lark:message:frontend"],
            status: "proposed",
            confidence: 0.9,
            candidate_kind: "knowledge"
          },
          body: "上线前确认检查项",
          etag: "candidate-etag",
          provenanceSources: [
            {
              id: "lark:message:frontend",
              provider: "lark",
              title: "上线讨论",
              body: "上线前确认检查项",
              occurred_at: "2026-07-20T01:00:00Z",
              source_kind: "mention",
              conversation: { type: "group", name: "上线讨论" },
              sender: {
                person_id: "person_sender_frontend",
                display_name: "Alice"
              }
            }
          ],
          provenancePagination: {
            page: 1,
            page_size: 10,
            total: 1,
            total_pages: 1
          }
        });
      }
      if (url.startsWith("/api/documents/knowledge_candidate_frontend")) {
        return jsonResponse({
          path: "knowledge/playbooks/knowledge_candidate_frontend.md",
          data: {
            schema: "work-context/knowledge@1",
            type: "knowledge",
            id: "knowledge_candidate_frontend",
            title: "确认上线检查项",
            managed: "manual",
            created_at: "2026-07-20T01:00:00Z",
            updated_at: "2026-07-20T01:00:00Z",
            source_refs: ["lark:message:frontend"],
            status: "curated",
            knowledge_kind: "playbook",
            curation_state: "curated",
            superseded_by: null,
            tags: ["release"],
            candidate_id: "candidate_frontend"
          },
          body: "# 确认上线检查项\n\n已确认依据",
          etag: "accepted-etag",
          provenanceSources: [
            {
              id: "lark:message:frontend",
              provider: "lark",
              title: "上线讨论",
              body: "上线前确认检查项",
              occurred_at: "2026-07-20T01:00:00Z",
              source_kind: "mention",
              conversation: { type: "group", name: "上线讨论" },
              sender: {
                person_id: "person_sender_frontend",
                display_name: "Alice"
              }
            }
          ],
          provenancePagination: {
            page: 1,
            page_size: 10,
            total: 1,
            total_pages: 1
          }
        });
      }
      if (url.startsWith("/api/documents/person_alice")) {
        const parsed = new URL(url, "http://context-space.local");
        const page = Number(parsed.searchParams.get("provenance_page") ?? "1");
        const pageSize = Number(
          parsed.searchParams.get("provenance_page_size") ?? "10"
        );
        const pageStart = (page - 1) * pageSize;
        return jsonResponse({
          path: "people/person_alice.md",
          data: personWithInsight,
          body: "# Alice",
          etag: "person-etag",
          relationships: {
            owedByMe: [],
            waitingOnThem: [],
            shared: []
          },
          provenanceSources: personProvenanceSources.slice(
            pageStart,
            pageStart + pageSize
          ),
          provenancePagination: {
            page,
            page_size: pageSize,
            total: personProvenanceSources.length,
            total_pages: Math.ceil(personProvenanceSources.length / pageSize)
          }
        });
      }
      return jsonResponse([]);
    })
  );
});

describe("Context Space workbench", () => {
  it("renders Now content and all eight primary navigation routes", async () => {
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}><AppView /></MemoryRouter>);
    expect(await screen.findByText("准备发布计划")).toBeInTheDocument();
    expect(screen.getByText("Leader 相关交付")).toBeInTheDocument();
    const calendar = screen.getByLabelText("未来 24 小时日程");
    expect(calendar).toHaveClass("calendar-list");
    expect(within(calendar).getByText("发布评审会议")).toBeInTheDocument();
    expect(within(calendar).getAllByRole("link")).toHaveLength(6);
    for (const label of ["Now", "Inbox", "Todos", "People", "Knowledge", "Timeline", "Meego", "Loop", "Settings"]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("searches and filters People by profile content", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/people"]}><AppView /></MemoryRouter>);
    const search = await screen.findByLabelText("搜索 People");
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();

    await user.type(search, "后端");
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "阻塞项");
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
  });

  it("paginates calendar-only Timeline and gives the time column enough structure", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/timeline"]}><AppView /></MemoryRouter>);
    const firstItem = await screen.findByText("Timeline item 1");
    expect(screen.queryByText("Timeline item 21")).not.toBeInTheDocument();
    expect(screen.getAllByText("日历")).toHaveLength(20);
    expect(screen.getByText(/第 1 \/ 2 页/)).toBeInTheDocument();
    expect(
      firstItem.closest(".timeline-item")?.firstElementChild
    ).toHaveClass("timeline-time");

    await user.click(screen.getByRole("button", { name: "下一页 Timeline" }));
    expect(await screen.findByText("Timeline item 21")).toBeInTheDocument();
    expect(screen.queryByText("Timeline item 1")).not.toBeInTheDocument();
    expect(screen.getByText(/第 2 \/ 2 页/)).toBeInTheDocument();
  });

  it("filters Todo items waiting on another person", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/todos"]}><AppView /></MemoryRouter>);
    expect(await screen.findByText("准备发布计划")).toBeInTheDocument();
    expect(screen.getByText("等待 Alice 评审")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "等待对方" }));
    expect(screen.queryByText("准备发布计划")).not.toBeInTheDocument();
    expect(screen.getByText("等待 Alice 评审")).toBeInTheDocument();
  });

  it("confirms an Inbox knowledge candidate and removes it from the review queue", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/inbox"]}><AppView /></MemoryRouter>);
    expect(await screen.findByText("确认上线检查项")).toBeInTheDocument();
    const rejectButton = screen.getByRole("button", {
      name: "拒绝 确认上线检查项"
    });
    const acceptButton = screen.getByRole("button", {
      name: "确认 确认上线检查项"
    });
    expect(rejectButton).toHaveClass("candidate-action");
    expect(acceptButton).toHaveClass("candidate-action");
    await user.click(acceptButton);
    expect(fetch).toHaveBeenCalledWith(
      "/api/candidates/candidate_frontend/accept",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-context-space-csrf": "frontend-csrf-token"
        })
      })
    );
    expect(await screen.findByText("Inbox 已清空")).toBeInTheDocument();
    expect(screen.queryByText("确认上线检查项")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/documents/knowledge_candidate_frontend"),
      expect.anything()
    );
  });

  it("shows source content on an Inbox candidate detail", async () => {
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/documents/candidate_frontend"]}><AppView /></MemoryRouter>);
    expect(await screen.findByText("群聊 · 上线讨论")).toBeInTheDocument();
    expect(screen.getAllByText("上线前确认检查项").length).toBeGreaterThan(0);
    expect(screen.getByText("lark:message:frontend")).toBeInTheDocument();
  });

  it("marks a Todo complete from the list", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/todos"]}><AppView /></MemoryRouter>);
    const toggle = await screen.findByRole("button", { name: "标记完成 准备发布计划" });
    await user.click(toggle);
    await waitFor(() => {
      expect(screen.queryByText("准备发布计划")).not.toBeInTheDocument();
    });
    expect(owedTodoStatus).toBe("done");
    expect(fetch).toHaveBeenCalledWith(
      "/api/todos/todo_owed/status",
      expect.objectContaining({ method: "PATCH" })
    );
    await user.click(screen.getByRole("button", { name: "已完成" }));
    expect(await screen.findByRole("button", { name: "重新打开 准备发布计划" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "我来处理" }));
    expect(screen.queryByText("准备发布计划")).not.toBeInTheDocument();
  });

  it("shows provenance and disabled automation on Todo detail", async () => {
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/documents/todo_owed"]}><AppView /></MemoryRouter>);
    expect(await screen.findByText("lark:message:om_1")).toBeInTheDocument();
    expect(screen.getByText("群聊 · 发布计划讨论")).toBeInTheDocument();
    expect(screen.getByText("请在周五前准备发布计划")).toBeInTheDocument();
    expect(screen.getByText(/lark · mention/)).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("ou_todo_sender")).not.toBeInTheDocument();
    expect(screen.getByText("外部执行不可用")).toBeInTheDocument();
    expect(screen.getByText("需要人工确认")).toBeInTheDocument();
    expect(screen.getByText("codex-sdk")).toBeInTheDocument();
    expect(screen.getByText("context-analysis@4")).toBeInTheDocument();
  });

  it("shows categorized, evidence-backed person observations", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/documents/person_alice"]}><AppView /></MemoryRouter>);
    expect(await screen.findByText("职场观察")).toBeInTheDocument();
    expect(screen.getByText("协作方式")).toBeInTheDocument();
    expect(screen.getByText("在关键评审前主动汇总阻塞项。")).toBeInTheDocument();
    expect(screen.getAllByText("Alice 会在评审前汇总阻塞项").length).toBeGreaterThan(0);
    expect(screen.getByText(/86%/)).toBeInTheDocument();
    expect(screen.getByText("群聊 · 发布评审群")).toBeInTheDocument();
    expect(screen.getByText("私聊发送者")).toBeInTheDocument();
    expect(screen.getByText("群聊发送者")).toBeInTheDocument();
    expect(screen.getByText("私聊 · Alice")).toBeInTheDocument();
    expect(screen.getAllByText("Alice 负责发布流程").length).toBeGreaterThan(0);
    expect(screen.getByText(/第 1 \/ 2 页/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一页 Provenance" }));
    expect(await screen.findByText("私聊 · 历史讨论 10")).toBeInTheDocument();
    expect(screen.queryByText("群聊 · 发布评审群")).not.toBeInTheDocument();
    expect(screen.getByText(/第 2 \/ 2 页/)).toBeInTheDocument();
  });

  it("shows the current synchronization activity", async () => {
    larkStatus = {
      running: true,
      started_at: "2026-07-20T01:00:00Z",
      completed_at: null,
      last_error: null,
      results: [],
      progress: {
        phase: "collecting",
        source: "p2p",
        window_index: 1,
        window_count: 3,
        page_index: 4,
        received: 125,
        persisted: 80,
        message: "正在读取 p2p 第 2/3 个窗口，第 5 页",
        updated_at: "2026-07-20T01:00:10Z"
      }
    };
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/settings"]}><AppView /></MemoryRouter>);
    expect(await screen.findByText("正在读取 p2p 第 2/3 个窗口，第 5 页")).toBeInTheDocument();
    expect(screen.getByText("P2P 消息")).toBeInTheDocument();
    expect(screen.getByText("125 / 80")).toBeInTheDocument();
  });

  it("configures Meego collection and Q tag filtering in Settings", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/settings"]}><AppView /></MemoryRouter>);

    const enabled = await screen.findByLabelText("开启 Meego 抓取");
    const qTags = screen.getByLabelText("按 Q 标签过滤并排序");
    await user.click(enabled);
    await user.click(qTags);
    await user.type(screen.getByLabelText("Meego Project keys"), "project_1\nproject_2");
    await user.click(screen.getByRole("button", { name: "保存 Meego 配置" }));

    expect(await screen.findByText("Meego 配置已保存。开关只影响后续抓取和页面过滤，不会删除已有数据。")).toBeInTheDocument();
    expect(meegoConfig).toEqual({
      enabled: true,
      qTagTimelineEnabled: true,
      projectKeys: ["project_1", "project_2"]
    });
  });

  it("renders participating Meego items in Q tag groups", async () => {
    meegoConfig = {
      enabled: true,
      qTagTimelineEnabled: true,
      projectKeys: ["project_1"]
    };
    meegoStatus = {
      ...EMPTY_MEEGO_SYNC_STATUS,
      enabled: true,
      results: [{
        projectKey: "project_1",
        workItemType: "sub_task",
        ok: true,
        skipped: true,
        received: 0,
        persisted: 0,
        message: "Q 标签模式要求工作项类型提供 tags 字段"
      }]
    };
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/meego"]}><AppView /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "我参与的 Meego" })).toBeInTheDocument();
    expect(screen.getByText("Q 标签需求")).toBeInTheDocument();
    expect(screen.getAllByText("Q30828").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Q30828" })).toBeInTheDocument();
    expect(screen.queryByText("已跳过")).not.toBeInTheDocument();
    expect(screen.queryByText("Q 标签模式要求工作项类型提供 tags 字段")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Q 标签需求/ })).toHaveAttribute(
      "href",
      "https://project.feishu.cn/demo/story/detail/101"
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "开始 Agent 干活：Q 标签需求" }));
    expect(screen.getByRole("dialog", { name: "启动 Agent" })).toBeInTheDocument();
  });

  it("renders the manual Loop workbench without enabling automatic execution", async () => {
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/loop"]}><AppView /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Loop" })).toBeInTheDocument();
    expect(screen.getByText(/仅支持人工启动 Agent/)).toBeInTheDocument();
    expect(screen.getByText("还没有 Agent 会话")).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/loop", expect.anything()));
  });

  it("starts an isolated Agent session manually from a Todo", async () => {
    agentRepositories = [{
      id: "repo_frontend",
      name: "context-space",
      path: "/workspace/context-space",
      kind: "git",
      headCommit: "1234567890abcdef",
      branch: "main",
      createdAt: "2026-07-21T00:00:00Z",
      updatedAt: "2026-07-21T00:00:00Z"
    }];
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/todos"]}><AppView /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "开始 Agent 干活：准备发布计划" }));
    expect(screen.getByRole("dialog", { name: "启动 Agent" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /隔离开发/ }));
    await user.click(screen.getByRole("button", { name: "开始干活" }));
    expect(await screen.findByRole("heading", { name: "Loop" })).toBeInTheDocument();
    expect(await screen.findByText("隔离开发")).toBeInTheDocument();
    expect(agentSessions).toHaveLength(1);
    expect(agentSessions[0].mode).toBe("isolated_worktree");
  });

  it("requires explicit OpenSpec initialization before creating an isolated session", async () => {
    agentRepositories = [{
      id: "repo_openspec_frontend",
      name: "context-space",
      path: "/workspace/context-space",
      kind: "git",
      headCommit: "1234567890abcdef",
      branch: "main",
      createdAt: "2026-07-21T00:00:00Z",
      updatedAt: "2026-07-21T00:00:00Z"
    }];
    openSpecReadiness = { initialized: false, skillsReady: false, ready: false, missing: ["openspec"] };
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/todos"]}><AppView /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "开始 Agent 干活：准备发布计划" }));
    await user.click(screen.getByRole("radio", { name: /隔离开发/ }));
    await user.click(screen.getByRole("checkbox", { name: /使用 OpenSpec 工作流/ }));
    expect(await screen.findByText("需要初始化 OpenSpec")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始干活" }));
    expect(screen.getByRole("button", { name: "初始化并创建" })).toBeInTheDocument();
    expect(agentSessions).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "初始化并创建" }));
    expect(await screen.findByRole("heading", { name: "Loop" })).toBeInTheDocument();
    expect(agentSessions[0]).toMatchObject({ workflowKind: "openspec", mode: "isolated_worktree" });
    expect(agentSessions[0].messages?.[0].content).toBe("$openspec-explore\n\n准备发布计划");
  });

  it("limits a plain directory to read-only Agent sessions", async () => {
    agentRepositories = [{
      id: "directory_frontend",
      name: "notes",
      path: "/workspace/notes",
      kind: "directory",
      headCommit: null,
      branch: null,
      createdAt: "2026-07-21T00:00:00Z",
      updatedAt: "2026-07-21T00:00:00Z"
    }];
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/todos"]}><AppView /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "开始 Agent 干活：准备发布计划" }));
    expect(screen.getByLabelText("Agent 工作目录")).toHaveValue("directory_frontend");
    expect(screen.getByRole("radio", { name: /隔离开发/ })).toBeDisabled();
    expect(screen.getByText("仅 Git 仓库支持独立 worktree")).toBeInTheDocument();
  });

  it("shows failed Agent turns instead of appearing unresponsive", async () => {
    const repository: AgentRepository = {
      id: "repo_failed",
      name: "context-space",
      path: "/workspace/context-space",
      kind: "git",
      headCommit: "1234567890abcdef",
      branch: "main",
      createdAt: "2026-07-21T00:00:00Z",
      updatedAt: "2026-07-21T00:00:00Z"
    };
    agentSessions = [{
      id: "session_failed",
      title: "失败任务",
      sourceKind: "todo",
      sourceId: "todo_owed",
      repositoryId: repository.id,
      repository,
      mode: "read_only",
      workflowKind: "direct",
      workspacePath: repository.path,
      branch: null,
      baseCommit: repository.headCommit,
      threadId: "thread_failed",
      status: "active",
      attention: "reply_required",
      workspaceLifecycle: "ready",
      createdAt: "2026-07-21T00:00:00Z",
      updatedAt: "2026-07-21T00:01:00Z",
      endedAt: null,
      messages: [{ id: "message_failed", sessionId: "session_failed", turnId: "turn_failed", role: "user", content: "执行任务", createdAt: "2026-07-21T00:00:00Z" }],
      turns: [{ id: "turn_failed", sessionId: "session_failed", inputMessageId: "message_failed", status: "failed", outcome: null, usage: null, error: "Structured output schema rejected", createdAt: "2026-07-21T00:00:00Z", startedAt: "2026-07-21T00:00:01Z", completedAt: "2026-07-21T00:01:00Z" }],
      events: [],
      confirmations: []
    }];
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/loop?session=session_failed"]}><AppView /></MemoryRouter>);
    expect(await screen.findByText("Agent Turn 执行失败")).toBeInTheDocument();
    expect(screen.getByText("Structured output schema rejected")).toBeInTheDocument();
    expect(screen.getByText(/会话与工作区已保留/)).toBeInTheDocument();
  });

  it("renders Agent messages and tool calls in chronological order", async () => {
    const repository: AgentRepository = {
      id: "repo_timeline",
      name: "context-space",
      path: "/workspace/context-space",
      kind: "git",
      headCommit: "1234567890abcdef",
      branch: "main",
      createdAt: "2026-07-21T00:00:00Z",
      updatedAt: "2026-07-21T00:00:00Z"
    };
    agentSessions = [{
      id: "session_timeline",
      title: "时间线任务",
      sourceKind: "todo",
      sourceId: "todo_owed",
      repositoryId: repository.id,
      repository,
      mode: "read_only",
      workflowKind: "direct",
      workspacePath: repository.path,
      branch: null,
      baseCommit: repository.headCommit,
      threadId: "thread_timeline",
      status: "active",
      attention: "reply_required",
      workspaceLifecycle: "ready",
      createdAt: "2026-07-21T00:00:00Z",
      updatedAt: "2026-07-21T00:03:00Z",
      endedAt: null,
      messages: [
        { id: "message_user", sessionId: "session_timeline", turnId: "turn_timeline", role: "user", content: "检查代码", createdAt: "2026-07-21T00:00:00Z" },
        { id: "message_agent", sessionId: "session_timeline", turnId: "turn_timeline", role: "assistant", content: "## 检查完成\n\n- **测试通过**\n- `lint` 通过", createdAt: "2026-07-21T00:02:00Z" }
      ],
      turns: [],
      events: [
        { id: "event_command", sequence: 1, sessionId: "session_timeline", turnId: "turn_timeline", type: "command_execution.completed", data: { command: "npm test", status: "completed" }, createdAt: "2026-07-21T00:01:00Z" },
        { id: "event_file", sequence: 2, sessionId: "session_timeline", turnId: "turn_timeline", type: "file_change.completed", data: { path: "src/web/App.tsx", status: "completed" }, createdAt: "2026-07-21T00:01:30Z" }
      ],
      confirmations: []
    }];

    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/loop?session=session_timeline"]}><AppView /></MemoryRouter>);

    const timeline = await screen.findByTestId("agent-timeline");
    expect(within(timeline).getAllByTestId("agent-timeline-item").map((item) => item.textContent)).toEqual([
      expect.stringContaining("检查代码"),
      expect.stringContaining("工具调用2 项npm test"),
      expect.stringContaining("检查完成")
    ]);
    expect(within(timeline).getByRole("heading", { name: "检查完成" })).toBeInTheDocument();
    expect(within(timeline).getByText("测试通过").tagName).toBe("STRONG");

    const toolCall = within(timeline).getByText("npm test").closest("details");
    expect(toolCall).not.toHaveAttribute("open");
    expect(within(toolCall as HTMLElement).getByText("文件修改")).toBeInTheDocument();
    expect(within(timeline).getAllByRole("group")).toHaveLength(1);
    await userEvent.click(within(toolCall as HTMLElement).getByText("工具调用"));
    expect(toolCall).toHaveAttribute("open");

    expect(screen.getByText("thread_timeline")).toBeInTheDocument();
    expect(screen.getByText("thread_timeline")).toHaveAttribute("title", "thread_timeline");
    const editorSelect = screen.getByLabelText("打开工作区");
    expect(within(editorSelect).getByRole("option", { name: "Trae CN" })).toBeInTheDocument();
    expect(within(editorSelect).getByRole("option", { name: "VS Code" })).toBeInTheDocument();
    await userEvent.selectOptions(editorSelect, "goland");
    await userEvent.click(screen.getByRole("button", { name: "打开" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls).toContainEqual([
      "/api/agent/sessions/session_timeline/open-workspace",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ editor: "goland" }) })
    ]));
  });

  it("switches OpenSpec changes and renders schema workflow progress", async () => {
    const repository: AgentRepository = {
      id: "repo_openspec_workflow",
      name: "context-space",
      path: "/workspace/context-space",
      kind: "git",
      headCommit: "1234567890abcdef",
      branch: "main",
      createdAt: "2026-07-21T00:00:00Z",
      updatedAt: "2026-07-21T00:00:00Z"
    };
    agentSessions = [{
      id: "session_openspec_workflow",
      title: "OpenSpec 工作流",
      sourceKind: "todo",
      sourceId: "todo_owed",
      repositoryId: repository.id,
      repository,
      mode: "isolated_worktree",
      workflowKind: "openspec",
      workspacePath: "/workspace/worktree",
      branch: "context-space/session_openspec_workflow",
      baseCommit: repository.headCommit,
      threadId: "thread_openspec_workflow",
      status: "active",
      attention: "reply_required",
      workspaceLifecycle: "ready",
      createdAt: "2026-07-21T00:00:00Z",
      updatedAt: "2026-07-21T00:03:00Z",
      endedAt: null,
      messages: [],
      turns: [],
      events: [],
      confirmations: []
    }];
    openSpecChanges = [
      { name: "add-auth", completedTasks: 0, totalTasks: 2, status: "in-progress", lastModified: "2026-07-21T00:02:00Z" },
      { name: "add-cache", completedTasks: 0, totalTasks: 0, status: "no-tasks", lastModified: "2026-07-21T00:01:00Z" }
    ];
    openSpecWorkflows = {
      "add-auth": { changeName: "add-auth", schemaName: "spec-driven", relativePath: "openspec/changes/add-auth", isComplete: false, nodes: [{ id: "proposal", description: "Proposal", outputPath: "proposal.md", requires: [], status: "done", missingDeps: [] }, { id: "tasks", description: "Tasks", outputPath: "tasks.md", requires: ["proposal"], status: "ready", missingDeps: [] }] },
      "add-cache": { changeName: "add-cache", schemaName: "spec-driven", relativePath: "openspec/changes/add-cache", isComplete: false, nodes: [{ id: "proposal", description: "Proposal", outputPath: "proposal.md", requires: [], status: "ready", missingDeps: [] }] }
    };
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/loop?session=session_openspec_workflow"]}><AppView /></MemoryRouter>);
    expect(await screen.findByRole("region", { name: "OpenSpec Workflow" })).toBeInTheDocument();
    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("可继续")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("OpenSpec Change"), "add-cache");
    await waitFor(() => expect(screen.queryByText("已完成")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "新建 Change" }));
    await user.type(screen.getByLabelText("Change 名称"), "add-search");
    await user.type(screen.getByLabelText("Change 说明"), "新增搜索能力");
    await user.click(screen.getByRole("button", { name: "调用 openspec-new-change" }));
    expect(await screen.findByRole("option", { name: "add-search" })).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls).toContainEqual([
      "/api/agent/sessions/session_openspec_workflow/openspec/changes",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "add-search", description: "新增搜索能力" }) })
    ]));
  });

  it("registers and removes an Agent repository in Settings", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/settings"]}><AppView /></MemoryRouter>);
    await user.type(await screen.findByLabelText("Agent 工作目录路径"), "/workspace/context-space");
    await user.click(screen.getByRole("button", { name: "注册目录" }));
    expect(await screen.findByText("Agent 工作目录已注册。")).toBeInTheDocument();
    expect(screen.getByText("/workspace/context-space")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "移除目录 context-space" }));
    expect(await screen.findByText("已移除工作目录注册；磁盘内容未被删除。")).toBeInTheDocument();
    expect(agentRepositories).toHaveLength(0);
  });

  it("shows provider availability and switches future analysis runs", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/settings"]}><AppView /></MemoryRouter>);
    const selector = await screen.findByLabelText("LLM 分析 Provider");
    expect(screen.getByText("SDK 可用")).toBeInTheDocument();
    expect(screen.getByText("CLI 可用")).toBeInTheDocument();
    expect(within(selector).getByRole("option", { name: "traex" })).toBeInTheDocument();
    await user.selectOptions(selector, "codex-exec");
    expect(
      await screen.findByText("后续分析将使用 codex-exec；运行中的分析不受影响。")
    ).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/config/analysis",
      expect.objectContaining({ method: "PUT" })
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Codex SDK 推理强度")).not.toBeInTheDocument()
    );
  });

  it("configures reasoning effort only for Codex SDK", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/settings"]}><AppView /></MemoryRouter>);

    const effort = await screen.findByLabelText("Codex SDK 推理强度");
    expect(effort).toHaveValue("medium");
    await user.selectOptions(effort, "high");
    await user.click(screen.getByRole("button", { name: "保存推理强度" }));

    expect(
      await screen.findByText("后续 Codex SDK 分析将使用 high 推理强度。")
    ).toBeInTheDocument();
    expect(selectedReasoningEffort).toBe("high");
  });

  it("configures parallel LLM Worker count", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/settings"]}><AppView /></MemoryRouter>);

    const workerCount = await screen.findByLabelText("LLM Worker 数量");
    expect(workerCount).toHaveValue(1);
    await user.clear(workerCount);
    await user.type(workerCount, "3");
    await user.click(screen.getByRole("button", { name: "保存 Worker 数量" }));

    expect(
      await screen.findByText("LLM Worker 已调整为 3；新并发度立即生效。")
    ).toBeInTheDocument();
    expect(selectedWorkerCount).toBe(3);
  });

  it("configures periodic read-only synchronization in minutes", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/settings"]}><AppView /></MemoryRouter>);

    expect(await screen.findByText("定期同步当前已关闭；手动只读同步不受影响。")).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("定期只读同步状态"),
      "true"
    );
    const interval = screen.getByLabelText("定期同步周期");
    await user.clear(interval);
    await user.type(interval, "30");
    await user.selectOptions(
      screen.getByLabelText("定期同步周期单位"),
      "minutes"
    );
    await user.click(screen.getByRole("button", { name: "保存定期同步" }));

    expect(
      await screen.findByText("已启用定期只读同步：每 30 分钟一次。")
    ).toBeInTheDocument();
    expect(selectedSyncSchedule).toEqual({
      enabled: true,
      interval: 30,
      unit: "minutes"
    });
  });

  it("searches, adds, lists, and removes Priority people", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/settings"]}><AppView /></MemoryRouter>);

    const search = await screen.findByLabelText("搜索 Priority people");
    expect(screen.getByText("尚未添加 Priority people")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();

    await user.type(search, "Ali");
    await user.click(await screen.findByRole("button", { name: /Alice.*添加/ }));
    expect(await screen.findByText("已添加 · 1")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(configuredLeaders).toEqual([
      { person_id: "person_alice", boost: 20 }
    ]);

    await user.click(screen.getByRole("button", { name: "移除 Alice" }));
    expect(await screen.findByText("已添加 · 0")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(configuredLeaders).toEqual([]);
  });

  it("saves and clears the model override for future analysis", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/settings"]}><AppView /></MemoryRouter>);
    const input = await screen.findByLabelText("LLM 分析模型");
    await user.type(input, "test-model");
    await user.click(screen.getByRole("button", { name: "保存模型" }));
    expect(
      await screen.findByText(
        "后续分析将使用模型 test-model；可用性由当前 Codex 认证决定。"
      )
    ).toBeInTheDocument();
    expect(selectedModel).toBe("test-model");

    const savedInput = await screen.findByLabelText("LLM 分析模型");
    await user.clear(savedInput);
    await user.click(screen.getByRole("button", { name: "保存模型" }));
    expect(
      await screen.findByText("已清空模型覆盖；后续分析使用 Codex 当前默认模型。")
    ).toBeInTheDocument();
    expect(selectedModel).toBeNull();
  });

  it("shows actionable Lark permission and CLI update reminders", async () => {
    larkStatus = {
      running: false,
      started_at: "2026-07-20T01:00:00Z",
      completed_at: "2026-07-20T01:01:00Z",
      last_error: "飞书同步需要人工处理",
      progress: {
        phase: "failed",
        source: "mentions",
        window_index: 0,
        window_count: 1,
        page_index: 0,
        received: 0,
        persisted: 0,
        message: "群聊提及读取失败",
        updated_at: "2026-07-20T01:01:00Z"
      },
      results: [
        {
          source: "mentions",
          ok: false,
          received: 0,
          persisted: 0,
          error: "飞书权限不足（99991679）：missing scope",
          issue: {
            kind: "permission",
            requires_action: true,
            message: "missing scope",
            code: 99991679,
            missing_scopes: ["im:message:readonly"],
            hint: "lark-cli auth login --scope \"im:message:readonly\"",
            console_url: "https://open.feishu.cn/app/permission",
            troubleshooter: "排查建议：https://open.feishu.cn/search?code=99991679",
            update: {
              command: "lark-cli update",
              current: "1.0.50",
              latest: "1.0.72"
            }
          }
        }
      ]
    };
    const user = userEvent.setup();
    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={["/settings"]}
      >
        <AppView />
      </MemoryRouter>
    );

    expect(await screen.findByText(/需要处理飞书权限/)).toBeInTheDocument();
    expect(screen.getByText("im:message:readonly")).toBeInTheDocument();
    expect(screen.getByText("lark-cli update")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /打开飞书权限配置/ })).toHaveAttribute(
      "href",
      "https://open.feishu.cn/app/permission"
    );
    expect(screen.getByRole("link", { name: /查看飞书排查建议/ })).toHaveAttribute(
      "href",
      "https://open.feishu.cn/search?code=99991679"
    );

    await user.click(screen.getByRole("button", { name: "立即只读同步" }));
    expect(
      await screen.findByText("同步已完成，但存在需要处理的飞书权限或认证问题，请查看下方提醒。")
    ).toBeInTheDocument();
  });

  it("blocks the first sync and shows the minimal authorization command until permissions are ready", async () => {
    larkPermissionPreflight = {
      ...larkPermissionPreflight,
      state: "missing_permissions",
      ready: false,
      granted_scopes: ["auth:user.id:read"],
      missing_scopes: [
        "search:message",
        "calendar:calendar.event:read",
        "task:task:read"
      ],
      message: "飞书同步缺少必要权限。",
      authorization_command:
        'lark-cli auth login --scope "search:message calendar:calendar.event:read task:task:read"'
    };
    const user = userEvent.setup();
    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={["/settings"]}
      >
        <AppView />
      </MemoryRouter>
    );

    expect(await screen.findByText("缺少权限")).toBeInTheDocument();
    expect(screen.getByText("首次同步已阻止")).toBeInTheDocument();
    expect(
      screen.getByText(
        "auth:user.id:read / search:message / calendar:calendar.event:read / task:task:read"
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'lark-cli auth login --scope "search:message calendar:calendar.event:read task:task:read"'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "立即只读同步" })
    ).toBeDisabled();

    larkPermissionPreflight = {
      ...larkPermissionPreflight,
      state: "ready",
      ready: true,
      granted_scopes: [...larkPermissionPreflight.required_scopes],
      missing_scopes: [],
      message: "飞书同步所需权限已就绪。",
      authorization_command: null
    };
    await user.click(screen.getByRole("button", { name: "重新检查权限" }));
    expect(await screen.findByText("权限已就绪")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "立即只读同步" })
    ).toBeEnabled();
  });

  it("warns without disabling sync when permissions are missing after a successful sync", async () => {
    larkPermissionPreflight = {
      ...larkPermissionPreflight,
      state: "missing_permissions",
      ready: false,
      granted_scopes: ["auth:user.id:read"],
      missing_scopes: ["search:message"],
      initial_sync_completed: true,
      message: "飞书同步缺少必要权限。",
      authorization_command:
        'lark-cli auth login --scope "search:message"'
    };
    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={["/settings"]}
      >
        <AppView />
      </MemoryRouter>
    );

    expect(await screen.findByText("警告")).toBeInTheDocument();
    expect(
      screen.getByText(/已有成功同步记录，本次仅提示警告/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "立即只读同步" })
    ).toBeEnabled();
  });

  it("shows CLI installation guidance when Lark or Meego executables are missing", async () => {
    larkStatus = {
      ...EMPTY_SYNC_STATUS,
      last_error: "飞书同步需要人工处理",
      results: [{
        source: "self",
        ok: false,
        received: 0,
        persisted: 0,
        error: "缺少 lark-cli：未检测到 lark-cli 可执行文件。",
        issue: {
          kind: "installation",
          requires_action: true,
          message: "未检测到 lark-cli 可执行文件。",
          hint: "请运行 npm install -g @larksuite/cli 安装，确认 lark-cli 已加入 PATH，然后运行 lark-cli auth login 完成认证。"
        }
      }]
    };
    meegoConfig = {
      enabled: true,
      qTagTimelineEnabled: false,
      projectKeys: ["project_1"]
    };
    meegoStatus = {
      ...EMPTY_MEEGO_SYNC_STATUS,
      enabled: true,
      lastError: "未检测到 Meego CLI（命令：meegle）。请运行 npm install -g @lark-project/meegle 安装，确认 meegle 已加入 PATH，然后运行 meegle auth login 完成认证。"
    };

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={["/settings"]}
      >
        <AppView />
      </MemoryRouter>
    );

    expect(await screen.findByText(/需要安装 lark-cli/)).toBeInTheDocument();
    expect(screen.getByText(/npm install -g @larksuite\/cli/)).toBeInTheDocument();
    expect(screen.getByText(/lark-cli auth login/)).toBeInTheDocument();
    expect(screen.getByText(/未检测到 Meego CLI/)).toBeInTheDocument();
    expect(screen.getByText(/npm install -g @lark-project\/meegle/)).toBeInTheDocument();
    expect(screen.getByText(/meegle auth login/)).toBeInTheDocument();
  });
});

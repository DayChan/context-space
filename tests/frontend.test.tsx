// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LeaderConfig,
  Overview,
  PersonMetadata,
  SyncStatus,
  TodoMetadata
} from "../src/core/types";
import { DEFAULT_AUTOMATION, EMPTY_SYNC_STATUS } from "../src/core/types";
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
    prompt_version: "context-analysis@2",
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
      title: "Alice",
      body: "# Alice\n\n**Occurred:** 2026-07-20T02:00:00Z\n\nAlice 会在评审前汇总阻塞项",
      occurred_at: "2026-07-20T02:00:00Z",
      source_kind: "p2p"
    };
  }
  if (index === 1) {
    return {
      id: "lark:message:person_1",
      title: "发布评审群",
      body: "# 发布评审群\n\n**Occurred:** 2026-07-20T01:30:00Z\n\nAlice 负责发布流程",
      occurred_at: "2026-07-20T01:30:00Z",
      source_kind: "mention"
    };
  }
  return {
    id: `lark:message:person_extra_${index}`,
    title: `历史讨论 ${index}`,
    body: `# 历史讨论 ${index}\n\n第 ${index} 条历史消息`,
    occurred_at: `2026-07-${String(20 - index).padStart(2, "0")}T00:00:00Z`,
    source_kind: "p2p"
  };
});

const overview: Overview = {
  topTodos: [owedTodo],
  upcomingCalendar: [],
  recentMentions: [],
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

const timelineItems: TodoMetadata[] = Array.from(
  { length: 21 },
  (_, index) => ({
    ...owedTodo,
    id: `timeline_item_${index + 1}`,
    title: `Timeline item ${index + 1}`,
    updated_at: `2026-07-${String(20 - Math.floor(index / 2)).padStart(2, "0")}T${String(23 - (index % 2)).padStart(2, "0")}:00:00Z`
  })
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
let larkStatus: SyncStatus = EMPTY_SYNC_STATUS;
let owedTodoStatus: TodoMetadata["status"] = "open";
let configuredLeaders: LeaderConfig[] = [];
let inboxCandidates: Array<{
  path: string;
  data: TodoMetadata;
  body: string;
  etag: string;
}> = [];

function configResponse() {
  return {
    leaders: configuredLeaders,
    lark: { status: larkStatus, readOnly: true, identity: "user" },
    loop: { enabled: false, executionEndpoint: null },
    analysis: {
      current_provider: selectedProvider,
      config_source: "workspace",
      provider_locked: false,
      config: {
        provider: selectedProvider,
        model: selectedModel,
        timeout_ms: 120000,
        max_source_chars: 20000,
        max_batch_records: 50,
        max_batch_source_chars: 60000,
        max_output_bytes: 2000000,
        prompt_version: "context-analysis@2",
        retain_runs: 50,
        max_reanalysis_records: 50
      },
      providers: [
        { id: "codex-sdk", available: true, detail: "SDK 可用" },
        { id: "codex-exec", available: true, detail: "CLI 可用" }
      ],
      prompt_version: "context-analysis@2",
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
      recent_runs: []
    }
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  selectedProvider = "codex-sdk";
  selectedModel = null;
  larkStatus = EMPTY_SYNC_STATUS;
  owedTodoStatus = "open";
  configuredLeaders = [];
  inboxCandidates = [
    {
      path: "inbox/todo-candidates/candidate_frontend.md",
      data: {
        ...owedTodo,
        id: "candidate_frontend",
        title: "确认上线检查项",
        type: "candidate",
        status: "candidate"
      },
      body: "# 确认上线检查项\n\n需要人工确认后进入 Todo。",
      etag: "candidate-etag"
    }
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/config/analysis") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          provider?: string;
          model?: string | null;
        };
        if (body.provider) selectedProvider = body.provider;
        if ("model" in body) selectedModel = body.model ?? null;
        return jsonResponse({
          config: { provider: selectedProvider, model: selectedModel }
        });
      }
      if (url === "/api/config/leaders") {
        configuredLeaders = JSON.parse(
          String(init?.body ?? "[]")
        ) as LeaderConfig[];
        return jsonResponse(configuredLeaders);
      }
      if (url.startsWith("/api/inbox/") && url.endsWith("/confirm")) {
        const id = decodeURIComponent(url.split("/")[3]);
        const confirmed = inboxCandidates.find(
          (candidate) => candidate.data.id === id
        );
        inboxCandidates = inboxCandidates.filter(
          (candidate) => candidate.data.id !== id
        );
        return jsonResponse({
          ...confirmed,
          data: confirmed
            ? { ...confirmed.data, type: "todo", status: "open" }
            : null
        });
      }
      if (url === "/api/sync/lark/status") return jsonResponse(larkStatus);
      if (url === "/api/sync/lark") return jsonResponse(larkStatus);
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
      if (url.startsWith("/api/overview")) return jsonResponse(overview);
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
      if (url.startsWith("/api/documents?type=candidate")) {
        return jsonResponse(inboxCandidates);
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
          enabled: false,
          message: "Automatic execution is not enabled in V1.",
          readiness: overview.loopReadiness
        });
      }
      if (url.startsWith("/api/documents/todo_owed")) {
        return jsonResponse({
          path: "todos/owed.md",
          data: { ...owedTodo, status: owedTodoStatus },
          body: "# 准备发布计划\n\n来自群聊上下文。",
          etag: "1"
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
    for (const label of ["Now", "Inbox", "Todos", "People", "Knowledge", "Timeline", "Loop", "Settings"]) {
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

  it("paginates Timeline and gives the time column enough structure", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/timeline"]}><AppView /></MemoryRouter>);
    const firstItem = await screen.findByText("Timeline item 1");
    expect(screen.queryByText("Timeline item 21")).not.toBeInTheDocument();
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

  it("confirms an Inbox candidate and removes it from the review queue", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/inbox"]}><AppView /></MemoryRouter>);
    expect(await screen.findByText("确认上线检查项")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "确认 确认上线检查项" })
    );
    expect(await screen.findByText("Inbox 已清空")).toBeInTheDocument();
    expect(screen.queryByText("确认上线检查项")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/inbox/candidate_frontend/confirm",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ etag: "candidate-etag" })
      })
    );
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
    expect(screen.getByText("外部执行不可用")).toBeInTheDocument();
    expect(screen.getByText("需要人工确认")).toBeInTheDocument();
    expect(screen.getByText("codex-sdk")).toBeInTheDocument();
    expect(screen.getByText("context-analysis@2")).toBeInTheDocument();
  });

  it("shows categorized, evidence-backed person observations", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/documents/person_alice"]}><AppView /></MemoryRouter>);
    expect(await screen.findByText("职场观察")).toBeInTheDocument();
    expect(screen.getByText("协作方式")).toBeInTheDocument();
    expect(screen.getByText("在关键评审前主动汇总阻塞项。")).toBeInTheDocument();
    expect(screen.getAllByText("Alice 会在评审前汇总阻塞项").length).toBeGreaterThan(0);
    expect(screen.getByText(/86%/)).toBeInTheDocument();
    expect(screen.getAllByText("发布评审群").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Alice 负责发布流程").length).toBeGreaterThan(0);
    expect(screen.getByText(/第 1 \/ 2 页/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一页 Provenance" }));
    expect(await screen.findByText("历史讨论 10")).toBeInTheDocument();
    expect(screen.queryByText("发布评审群")).not.toBeInTheDocument();
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

  it("keeps Loop visible and explicitly inert", async () => {
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/loop"]}><AppView /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "自动执行尚未启用" })).toBeInTheDocument();
    expect(screen.getByText("execution_enabled: false")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /执行/ })).not.toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/loop", expect.anything()));
  });

  it("shows provider availability and switches future analysis runs", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/settings"]}><AppView /></MemoryRouter>);
    const selector = await screen.findByLabelText("LLM 分析 Provider");
    expect(screen.getByText("SDK 可用")).toBeInTheDocument();
    expect(screen.getByText("CLI 可用")).toBeInTheDocument();
    await user.selectOptions(selector, "codex-exec");
    expect(
      await screen.findByText("后续分析将使用 codex-exec；运行中的分析不受影响。")
    ).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/config/analysis",
      expect.objectContaining({ method: "PUT" })
    );
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
});

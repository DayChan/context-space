// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
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

function configResponse() {
  return {
    leaders: [],
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
      if (url === "/api/sync/lark") return jsonResponse(larkStatus);
      if (url === "/api/config") return jsonResponse(configResponse());
      if (url.startsWith("/api/overview")) return jsonResponse(overview);
      if (url.startsWith("/api/documents?type=todo")) {
        return jsonResponse([
          { path: "todos/owed.md", data: owedTodo, body: "", etag: "1" },
          { path: "todos/waiting.md", data: waitingTodo, body: "", etag: "2" }
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
          data: owedTodo,
          body: "# 准备发布计划\n\n来自群聊上下文。",
          etag: "1"
        });
      }
      if (url.startsWith("/api/documents/person_alice")) {
        return jsonResponse({
          path: "people/person_alice.md",
          data: personWithInsight,
          body: "# Alice",
          etag: "person-etag",
          relationships: {
            owedByMe: [],
            waitingOnThem: [],
            shared: []
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

  it("filters Todo items waiting on another person", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/todos"]}><AppView /></MemoryRouter>);
    expect(await screen.findByText("准备发布计划")).toBeInTheDocument();
    expect(screen.getByText("等待 Alice 评审")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "等待对方" }));
    expect(screen.queryByText("准备发布计划")).not.toBeInTheDocument();
    expect(screen.getByText("等待 Alice 评审")).toBeInTheDocument();
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
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/documents/person_alice"]}><AppView /></MemoryRouter>);
    expect(await screen.findByText("职场观察")).toBeInTheDocument();
    expect(screen.getByText("协作方式")).toBeInTheDocument();
    expect(screen.getByText("在关键评审前主动汇总阻塞项。")).toBeInTheDocument();
    expect(screen.getByText("Alice 会在评审前汇总阻塞项")).toBeInTheDocument();
    expect(screen.getByText(/86%/)).toBeInTheDocument();
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

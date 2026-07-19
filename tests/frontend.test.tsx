// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Overview, TodoMetadata } from "../src/core/types";
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

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
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
  });

  it("keeps Loop visible and explicitly inert", async () => {
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/loop"]}><AppView /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "自动执行尚未启用" })).toBeInTheDocument();
    expect(screen.getByText("execution_enabled: false")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /执行/ })).not.toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/loop", expect.anything()));
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeSource } from "../src/core/analyzer";
import { ContextIndex } from "../src/core/index";
import {
  DocumentConflictError,
  MarkdownStore,
  UnsafeWorkspacePathError
} from "../src/core/markdown-store";
import {
  commitmentsForPerson,
  personIdForIdentity,
  safeObservations
} from "../src/core/people";
import { calculatePriority, createTodoMetadata } from "../src/core/todo";
import type { NormalizedSourceRecord } from "../src/core/types";
import { initializeWorkspace } from "../src/core/workspace";

describe("Markdown workspace and domain core", () => {
  let root: string;
  let store: MarkdownStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-core-"));
    store = await initializeWorkspace(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("initializes the required layout idempotently", async () => {
    const first = await store.read("config/workspace.md");
    await initializeWorkspace(root);
    const second = await store.read("config/workspace.md");

    expect(second.data.id).toBe("config_workspace");
    expect(second.etag).toBe(first.etag);
    expect(await store.exists("loop/policies.md")).toBe(true);
    expect(await store.exists(".context/sync/lark-status.md")).toBe(true);
  });

  it("rejects path traversal and stale writes", async () => {
    await expect(store.read("../outside.md")).rejects.toBeInstanceOf(UnsafeWorkspacePathError);
    const todo = createTodoMetadata({ id: "todo_safe", title: "Safe Todo" });
    const first = await store.write("todos/items/todo_safe.md", todo, "# Safe");
    await store.write(
      first.path,
      { ...todo, updated_at: new Date(Date.now() + 1000).toISOString() },
      "# Changed",
      { expectedEtag: first.etag }
    );
    await expect(
      store.write(first.path, todo, "# Stale", { expectedEtag: first.etag })
    ).rejects.toBeInstanceOf(DocumentConflictError);
  });

  it("rebuilds search and backlinks from Markdown", async () => {
    const todo = createTodoMetadata({
      id: "todo_search",
      title: "Prepare launch plan",
      source_refs: ["lark:message:om_123"]
    });
    await store.write("todos/items/todo_search.md", todo, "Coordinate the launch checklist.");
    const index = new ContextIndex();
    expect(await index.rebuild(store)).toBeGreaterThan(1);
    expect(index.search("launch")[0]?.id).toBe("todo_search");
    expect(index.backlinks("lark:message:om_123")[0]?.data.id).toBe("todo_search");
  });

  it("calculates explainable Leader priority and respects manual overrides", () => {
    const personId = "person_leader";
    const todo = createTodoMetadata({
      id: "todo_priority",
      title: "Send plan",
      explicit: true,
      stakeholders: [personId],
      direction: "owed_by_me",
      due_at: new Date("2026-07-20T10:00:00.000Z").toISOString(),
      updated_at: "2026-07-19T00:00:00.000Z"
    });
    const priority = calculatePriority(
      todo,
      [{ person_id: personId, boost: 20 }],
      new Date("2026-07-20T09:00:00.000Z")
    );
    expect(priority.effective).toBe(100);
    expect(priority.reasons.map((reason) => reason.key)).toContain("leader");
    expect(
      calculatePriority(
        { ...todo, priority: { ...todo.priority, manual: 12 } },
        [{ person_id: personId, boost: 20 }],
        new Date("2026-07-20T09:00:00.000Z")
      ).effective
    ).toBe(12);
  });

  it("projects mutual commitments and filters sensitive observations", () => {
    const personId = personIdForIdentity("lark", "ou_alice");
    const owed = createTodoMetadata({
      id: "todo_owed",
      title: "Reply",
      stakeholders: [personId],
      direction: "owed_by_me"
    });
    const waiting = createTodoMetadata({
      id: "todo_wait",
      title: "Wait for review",
      stakeholders: [personId],
      direction: "waiting_on_them"
    });
    const documents = [
      { path: "owed.md", data: owed, body: "", etag: "1" },
      { path: "waiting.md", data: waiting, body: "", etag: "2" }
    ];
    const result = commitmentsForPerson(personId, documents);
    expect(result.owedByMe).toHaveLength(1);
    expect(result.waitingOnThem).toHaveLength(1);
    expect(
      safeObservations([
        {
          text: "Prefers written proposals",
          evidence: ["lark:message:1"],
          confidence: 0.8,
          observed_at: "2026-07-20T00:00:00Z",
          origin: "inferred"
        },
        {
          text: "宗教信息",
          evidence: ["lark:message:2"],
          confidence: 0.8,
          observed_at: "2026-07-20T00:00:00Z",
          origin: "inferred"
        }
      ])
    ).toHaveLength(1);
  });

  it("extracts authoritative tasks and reviewable knowledge with provenance", () => {
    const task: NormalizedSourceRecord = {
      sourceId: "lark:task:task_1",
      provider: "lark",
      kind: "task",
      title: "Publish release notes",
      text: "",
      occurredAt: "2026-07-20T00:00:00Z",
      participants: [],
      metadata: { completed: false }
    };
    const decision: NormalizedSourceRecord = {
      ...task,
      sourceId: "lark:message:om_1",
      kind: "mention",
      title: "Project room",
      text: "结论：最终方案使用 Markdown。请你整理发布说明。"
    };
    const taskResult = analyzeSource(task);
    const decisionResult = analyzeSource(decision);
    expect(taskResult.todo?.upstream).toBe("lark_task");
    expect(taskResult.todo?.source_refs).toEqual(["lark:task:task_1"]);
    expect(decisionResult.todo?.status).toBe("open");
    expect(decisionResult.knowledge?.curation_state).toBe("draft");
    expect(decisionResult.knowledge?.source_refs).toEqual(["lark:message:om_1"]);
  });
});

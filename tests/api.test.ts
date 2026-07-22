import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnalysisProvider,
  ProviderAnalysisResponse
} from "../src/analysis/contracts";
import type { CommandRunner } from "../src/adapters/lark/runner";
import {
  REQUIRED_LARK_SYNC_SCOPES,
  type LarkPermissionChecker,
  type LarkPermissionProbe
} from "../src/adapters/lark/permissions";
import { createTodoMetadata } from "../src/core/todo";
import type {
  NormalizedSourceRecord,
  PersonMetadata,
  SourceMetadata
} from "../src/core/types";
import { personIdForIdentity } from "../src/core/people";
import { SyncRepository } from "../src/machine";
import {
  createConfiguredLogger,
  type Logger,
  type LoggingConfig
} from "../src/logging";
import { createApp } from "../src/server/app";

class EmptyRunner implements CommandRunner {
  readonly calls: string[][] = [];

  async run(args: string[]): Promise<unknown> {
    this.calls.push(args);
    if (args[0] === "contact") return { open_id: "ou_self", name: "Me" };
    if (args[0] === "im") return { messages: [] };
    if (args[0] === "calendar") return { events: [] };
    if (args[0] === "task") return { tasks: [] };
    return {};
  }
}

function readyPermissionProbe(): LarkPermissionProbe {
  return {
    state: "ready",
    ready: true as const,
    required_scopes: [...REQUIRED_LARK_SYNC_SCOPES],
    granted_scopes: [...REQUIRED_LARK_SYNC_SCOPES],
    missing_scopes: [],
    checked_at: "2026-07-22T00:00:00.000Z",
    message: "飞书同步所需权限已就绪。",
    authorization_command: null
  };
}

class ApiPermissionChecker implements LarkPermissionChecker {
  calls = 0;
  result: Awaited<ReturnType<LarkPermissionChecker["check"]>> =
    readyPermissionProbe();

  async check() {
    this.calls += 1;
    return this.result;
  }
}

const readyLarkPermissions: LarkPermissionChecker = {
  check: async () => readyPermissionProbe()
};

class ApiAnalysisProvider implements AnalysisProvider {
  calls = 0;

  constructor(readonly id: string) {}

  async getAvailability() {
    return { available: true, detail: `${this.id} 测试可用` };
  }

  async analyze(): Promise<ProviderAnalysisResponse> {
    this.calls += 1;
    return {
      finalResponse: JSON.stringify({
        schema_version: "work-context/analysis@2",
        items: [],
        person_insights: []
      }),
      model: null,
      usage: null,
      eventTypes: ["agent_message"]
    };
  }
}

describe("local API", () => {
  let root: string;
  let context: Awaited<ReturnType<typeof createApp>>;
  let sdkProvider: ApiAnalysisProvider;
  let execProvider: ApiAnalysisProvider;
  let logger: Logger;
  let permissionChecker: ApiPermissionChecker;
  let commandRunner: EmptyRunner;
  let logEntries: Array<Record<string, unknown>>;
  let csrfToken: string;

  function machineSource(
    id: string,
    kind: NormalizedSourceRecord["kind"],
    occurredAt: string,
    text: string,
    title = id,
    participants: NormalizedSourceRecord["participants"] = []
  ): NormalizedSourceRecord {
    return {
      sourceId: id,
      provider: "lark",
      kind,
      title,
      text,
      occurredAt,
      participants,
      metadata: {}
    };
  }

  function authorized<T extends { set(name: string, value: string): T }>(
    builder: T,
    token = csrfToken
  ): T {
    return builder.set("x-context-space-csrf", token);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-api-"));
    sdkProvider = new ApiAnalysisProvider("codex-sdk");
    execProvider = new ApiAnalysisProvider("codex-exec");
    logEntries = [];
    const loggingConfig: LoggingConfig = {
      level: "trace",
      consoleEnabled: true,
      fileEnabled: false,
      directory: path.join(root, ".context", "logs"),
      maxFileBytes: 10 * 1024 * 1024,
      retentionDays: 14,
      service: "context-space"
    };
    logger = createConfiguredLogger({
      config: loggingConfig,
      stdout: (line) =>
        logEntries.push(JSON.parse(line) as Record<string, unknown>),
      stderr: (line) =>
        logEntries.push(JSON.parse(line) as Record<string, unknown>)
    });
    permissionChecker = new ApiPermissionChecker();
    commandRunner = new EmptyRunner();
    context = await createApp({
      workspaceRoot: root,
      commandRunner,
      larkPermissionChecker: permissionChecker,
      analysisProviders: [sdkProvider, execProvider],
      environment: {},
      logger
    });
    csrfToken = (
      await request(context.app).get("/api/security/csrf").expect(200)
    ).body.token as string;
  });

  afterEach(async () => {
    context.runtime.sourceRetention.stop();
    await context.runtime.analysisWorker.stop();
    await context.runtime.markdownIndexSync.stop();
    context.runtime.database.close();
    await logger.close();
    await rm(root, { recursive: true, force: true });
  });

  it("serves health, overview, search, and only manual Loop execution", async () => {
    const health = await request(context.app).get("/api/health").expect(200);
    expect(health.body.loopExecutionEnabled).toBe(true);
    expect(health.body.automaticLoopExecutionEnabled).toBe(false);
    await request(context.app).get("/api/overview").expect(200);
    await request(context.app).get("/api/search?q=workspace").expect(200);
    const summary = await authorized(
      request(context.app).post("/api/summaries/daily")
    ).expect(201);
    expect(summary.body).toMatchObject({
      path: expect.stringMatching(/^knowledge\/drafts\/daily_summary_/),
      data: {
        type: "knowledge",
        managed: "manual",
        knowledge_kind: "draft"
      }
    });
    await authorized(request(context.app).post("/api/loop/execute"))
      .send({ todo: "x" })
      .expect(404);
  });

  it("persists Meego switches and serves the configured list mode", async () => {
    const initialConfig = await request(context.app).get("/api/config").expect(200);
    expect(initialConfig.body.meego).toMatchObject({
      config: {
        enabled: false,
        qTagTimelineEnabled: false,
        projectKeys: []
      },
      readOnly: true
    });
    await authorized(request(context.app).post("/api/sync/meego"))
      .expect(200)
      .expect(({ body }) => {
        expect(body.enabled).toBe(false);
      });

    const saved = await authorized(
      request(context.app).put("/api/config/meego")
    )
      .send({
        enabled: true,
        qTagTimelineEnabled: true,
        projectKeys: ["project_1", "project_1"]
      })
      .expect(200);
    expect(saved.body.config).toEqual({
      enabled: true,
      qTagTimelineEnabled: true,
      projectKeys: ["project_1"]
    });

    context.runtime.machineContext.upsertSource({
      sourceId: "meegle:project_1:story:101",
      provider: "meegle",
      kind: "meego",
      title: "Q 标签需求",
      text: "Q 标签需求",
      occurredAt: "2026-07-20T01:00:00Z",
      participants: [],
      metadata: {
        project_key: "project_1",
        project_name: "Demo",
        work_item_type: "story",
        work_item_type_name: "需求",
        work_item_id: "101",
        tags: ["Q30828"],
        updated_at: "2026-07-20T01:00:00Z"
      }
    });
    const list = await request(context.app).get("/api/meego").expect(200);
    expect(list.body).toMatchObject({
      mode: "q_tag_time",
      items: [{ id: "meegle:project_1:story:101" }],
      groups: [{ qTag: { raw: "Q30828" } }]
    });
  });

  it("shows only calendar sources in Timeline", async () => {
    context.runtime.machineContext.upsertSource(
      machineSource(
        "lark:message:timeline_p2p",
        "p2p",
        "2026-07-20T03:00:00.000Z",
        "# Direct message",
        "Direct message"
      )
    );
    context.runtime.machineContext.upsertSource(
      machineSource(
        "lark:calendar:timeline_event",
        "calendar",
        "2026-07-20T04:00:00.000Z",
        "# Calendar event",
        "Calendar event"
      )
    );
    context.runtime.machineContext.upsertSource(
      machineSource(
        "lark:message:timeline_mention",
        "mention",
        "2026-07-20T02:00:00.000Z",
        "# Group mention",
        "Group mention"
      )
    );
    await context.runtime.store.write(
      "todos/items/timeline_todo.md",
      createTodoMetadata({
        id: "timeline_todo",
        title: "Timeline Todo",
        updated_at: "2026-07-20T01:00:00.000Z"
      }),
      "# Timeline Todo"
    );
    await context.runtime.index.rebuild(context.runtime.store);

    const firstPage = await request(context.app)
      .get("/api/timeline?page=1&page_size=1")
      .expect(200);
    expect(firstPage.body.pagination).toEqual({
      page: 1,
      page_size: 1,
      total: 1,
      total_pages: 1
    });
    expect(firstPage.body.items).toHaveLength(1);
    expect(firstPage.body.items[0]).toMatchObject({
      id: "lark:calendar:timeline_event",
      source_kind: "calendar"
    });
    expect(JSON.stringify(firstPage.body)).not.toContain("timeline_p2p");
    expect(JSON.stringify(firstPage.body)).not.toContain("timeline_mention");
    expect(JSON.stringify(firstPage.body)).not.toContain("timeline_todo");
  });

  it("uses optimistic concurrency for editable documents", async () => {
    const todo = createTodoMetadata({ id: "todo_api", title: "API Todo" });
    await context.runtime.store.write("todos/items/todo_api.md", todo, "# Original");
    await context.runtime.index.rebuild(context.runtime.store);
    const loaded = await request(context.app).get("/api/documents/todo_api").expect(200);
    const update = {
      etag: loaded.body.etag,
      title: "Updated API Todo",
      body: "# Updated"
    };
    const saved = await authorized(
      request(context.app).put("/api/documents/todo_api")
    ).send(update).expect(200);
    expect(saved.body.data.title).toBe("Updated API Todo");
    await authorized(request(context.app).put("/api/documents/todo_api"))
      .send(update)
      .expect(409);
  });

  it("updates Todo status through the dedicated endpoint", async () => {
    const todo = createTodoMetadata({ id: "todo_status", title: "Status Todo" });
    await context.runtime.store.write("todos/items/todo_status.md", todo, "# Status Todo");
    await context.runtime.index.rebuild(context.runtime.store);

    const completed = await authorized(
      request(context.app).patch("/api/todos/todo_status/status")
    )
      .send({ status: "done" })
      .expect(200);
    expect(completed.body.data.status).toBe("done");

    const reopened = await authorized(
      request(context.app).patch("/api/todos/todo_status/status")
    )
      .send({ status: "open" })
      .expect(200);
    expect(reopened.body.data.status).toBe("open");
    await authorized(
      request(context.app).patch("/api/todos/todo_status/status")
    )
      .send({ status: "invalid" })
      .expect(400);
  });

  it("publishes Todo directly and requires confirmation for durable knowledge", async () => {
    const timestamp = "2026-07-20T00:00:00.000Z";
    context.runtime.machineContext.upsertSource(
      {
        ...machineSource(
          "lark:message:decision",
          "mention",
          timestamp,
          "需要确认发布计划，并记录发布决策",
          "发布群",
          [{ provider_id: "ou_sender", name: "发送者", role: "sender" }]
        ),
        metadata: { chat_name: "发布群" }
      }
    );
    context.runtime.analysisJobs.enqueue({
      id: "job_api_candidates",
      idempotencyKey: "api-candidates",
      sourceIds: ["lark:message:decision"],
      config: {},
      availableAt: timestamp
    });
    context.runtime.analysisJobs.claim(
      "api-test-worker",
      new Date(timestamp)
    );
    context.runtime.analysisResults.beginRun({
      id: "run_api_candidates",
      jobId: "job_api_candidates",
      provider: "codex-sdk",
      model: null,
      promptVersion: "context-analysis@4",
      schemaVersion: "work-context/analysis@2",
      configHash: "config",
      startedAt: timestamp
    });
    context.runtime.analysisResults.completeRun({
      runId: "run_api_candidates",
      jobId: "job_api_candidates",
      workerId: "api-test-worker",
      sourceIds: ["lark:message:decision"],
      eventTypes: ["agent_message"],
      usage: null,
      completedAt: timestamp,
      candidates: [
        {
          id: "candidate_todo_api",
          stableKey: "todo-key",
          kind: "todo",
          title: "确认发布计划",
          data: {
            direction: "owed_by_me",
            due_at: null,
            explicit: true,
            stakeholders: []
          },
          sourceRefs: ["lark:message:decision"],
          confidence: 0.9,
          reason: "明确行动项",
          evidence: [
            {
              sourceId: "lark:message:decision",
              quote: "需要确认发布计划"
            }
          ]
        },
        {
          id: "candidate_knowledge_api",
          stableKey: "knowledge-key",
          kind: "knowledge",
          title: "发布决策",
          data: {
            knowledge_kind: "decision",
            summary: "记录发布决策",
            tags: ["release"]
          },
          sourceRefs: ["lark:message:decision"],
          confidence: 0.8,
          reason: "明确决策",
          evidence: [
            {
              sourceId: "lark:message:decision",
              quote: "记录发布决策"
            }
          ]
        },
        {
          id: "candidate_person_api",
          stableKey: "person-key",
          kind: "person_insight",
          title: "评审前会汇总阻塞",
          data: {
            person_id: "person_candidate_target",
            category: "collaboration_style",
            text: "评审前会汇总阻塞"
          },
          sourceRefs: ["lark:message:decision"],
          confidence: 0.85,
          reason: "协作观察",
          evidence: [
            {
              sourceId: "lark:message:decision",
              quote: "评审前汇总阻塞"
            }
          ]
        }
      ]
    });
    await context.runtime.candidateReview.publishWithoutReview();
    const person: PersonMetadata = {
      schema: "work-context/person@1",
      id: "person_candidate_target",
      type: "person",
      title: "候选人物",
      managed: "manual",
      created_at: timestamp,
      updated_at: timestamp,
      source_refs: [],
      identities: [],
      role: null,
      role_origin: null,
      is_leader: false,
      leader_boost: 0,
      observations: [],
      last_interaction_at: null
    };
    await context.runtime.store.write(
      "people/person_candidate_target.md",
      person,
      "# 候选人物"
    );
    await context.runtime.markdownIndexSync.refreshPath(
      "people/person_candidate_target.md"
    );
    const personDetail = await request(context.app)
      .get("/api/documents/person_candidate_target")
      .expect(200);
    expect(personDetail.body.pendingInsights).toBeUndefined();
    expect(personDetail.body.acceptedInsights).toEqual([
      expect.objectContaining({
        id: "person_insight_candidate_person_api",
        observations: [
          expect.objectContaining({ text: "评审前会汇总阻塞" })
        ]
      })
    ]);
    expect(
      context.runtime.analysisResults
        .listCandidates(null)
        .map(({ id }) => id)
    ).toEqual(
      expect.arrayContaining([
        "candidate_todo_api",
        "candidate_knowledge_api",
        "candidate_person_api"
      ])
    );
    expect(
      context.runtime.analysisResults.getCandidate("candidate_todo_api")?.status
    ).toBe("accepted");
    expect(
      context.runtime.analysisResults.getCandidate("candidate_person_api")?.status
    ).toBe("accepted");
    const inbox = await request(context.app).get("/api/candidates").expect(200);
    expect(inbox.body.map(({ id }: { id: string }) => id)).toEqual(
      ["candidate_knowledge_api"]
    );
    expect(inbox.body.map(({ id }: { id: string }) => id)).not.toContain(
      "candidate_todo_api"
    );
    const todoDetail = await request(context.app)
      .get("/api/documents/todo_candidate_todo_api")
      .expect(200);
    expect(todoDetail.body.provenanceSources).toEqual([
      expect.objectContaining({
        id: "lark:message:decision",
        provider: "lark",
        body: expect.stringContaining("需要确认发布计划"),
        sender: {
          person_id: personIdForIdentity("lark", "ou_sender"),
          display_name: "发送者"
        },
        conversation: { type: "group", name: "发布群" }
      })
    ]);
    const inboxDetail = await request(context.app)
      .get("/api/documents/candidate_knowledge_api")
      .expect(200);
    expect(inboxDetail.body.provenanceSources).toEqual([
      expect.objectContaining({
        id: "lark:message:decision",
        body: expect.stringContaining("记录发布决策")
      })
    ]);
    expect(
      await context.runtime.store.exists(
        "todos/items/todo_candidate_todo_api.md"
      )
    ).toBe(true);

    const knowledgeResponse = await authorized(
      request(context.app).post(
        "/api/candidates/candidate_knowledge_api/accept"
      )
    )
      .expect(200);
    expect(knowledgeResponse.body).toMatchObject({
      state: "accepted",
      documentId: "knowledge_candidate_knowledge_api"
    });
    expect(
      await context.runtime.store.exists(
        "knowledge/decisions/knowledge_candidate_knowledge_api.md"
      )
    ).toBe(true);
    const knowledgeDetail = await request(context.app)
      .get("/api/documents/knowledge_candidate_knowledge_api")
      .expect(200);
    expect(knowledgeDetail.body.provenanceSources).toEqual([
      expect.objectContaining({
        id: "lark:message:decision",
        body: expect.stringContaining("记录发布决策")
      })
    ]);
    expect(
      context.runtime.index.byId("todo_candidate_todo_api")?.data.type
    ).toBe("todo");

  });

  it("resolves concrete provenance messages for People", async () => {
    const timestamp = "2026-07-20T00:00:00.000Z";
    const source: SourceMetadata = {
      schema: "work-context/source@1",
      id: "lark:message:person_api",
      type: "source",
      title: "发布讨论",
      managed: "generated",
      created_at: timestamp,
      updated_at: timestamp,
      source_refs: [],
      provider: "lark",
      source_kind: "p2p",
      source_id: "lark:message:person_api",
      occurred_at: timestamp,
      participants: [],
      provider_metadata: {}
    };
    const newerSource: SourceMetadata = {
      ...source,
      id: "lark:message:person_api_newer",
      title: "Direct message",
      source_id: "lark:message:person_api_newer",
      occurred_at: "2026-07-20T01:00:00.000Z"
    };
    const person: PersonMetadata = {
      schema: "work-context/person@1",
      id: "person_api",
      type: "person",
      title: "Alice",
      managed: "hybrid",
      created_at: timestamp,
      updated_at: timestamp,
      source_refs: [],
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
      observations: [],
      last_interaction_at: timestamp
    };
    context.runtime.machineContext.upsertSource(
      machineSource(
        source.id,
        "p2p",
        source.occurred_at,
        "# 发布讨论\n\nAlice 会在评审前汇总阻塞项",
        source.title,
        [{ provider_id: "ou_alice", name: "Alice", role: "sender" }]
      )
    );
    context.runtime.machineContext.upsertSource(
      machineSource(
        newerSource.id,
        "p2p",
        newerSource.occurred_at,
        "# 后续讨论\n\nAlice 确认了新的排期",
        newerSource.title,
        [
          {
            provider_id: "ou_alice",
            name: "ou_alice",
            role: "partner"
          }
        ]
      )
    );
    await context.runtime.store.write("people/person_api.md", person, "# Alice");
    await context.runtime.index.rebuild(context.runtime.store);

    const list = await request(context.app)
      .get("/api/documents?type=person")
      .expect(200);
    expect(
      list.body.find(
        (entry: { data: { id: string } }) => entry.data.id === person.id
      ).provenanceSources
    ).toBeUndefined();

    const firstPage = await request(context.app)
      .get("/api/documents/person_api?provenance_page=1&provenance_page_size=1")
      .expect(200);
    expect(firstPage.body.provenancePagination).toEqual({
      page: 1,
      page_size: 1,
      total: 2,
      total_pages: 2
    });
    expect(firstPage.body.provenanceSources).toEqual([
      expect.objectContaining({
        id: newerSource.id,
        title: "Direct message",
        body: expect.stringContaining("新的排期"),
        sender: null,
        conversation: { type: "direct", name: "Alice" }
      })
    ]);

    const secondPage = await request(context.app)
      .get("/api/documents/person_api?provenance_page=2&provenance_page_size=1")
      .expect(200);
    expect(secondPage.body.provenanceSources).toEqual([
      expect.objectContaining({
        id: source.id,
        title: "发布讨论",
        body: expect.stringContaining("汇总阻塞项"),
        conversation: { type: "direct", name: "Direct message" }
      })
    ]);
  });

  it("lists people and knowledge without loading the source collection", async () => {
    const timestamp = "2026-07-20T00:00:00.000Z";
    const externalId = "ou_person_list";
    context.runtime.machineContext.upsertSource({
      ...machineSource(
        "lark:message:person_list",
        "p2p",
        timestamp,
        "Hello"
      ),
      participants: [
        {
          provider_id: externalId,
          name: "List Person",
          role: "partner"
        }
      ]
    });
    await context.runtime.store.write(
      "people/person_list.md",
      {
        schema: "work-context/person@1",
        id: personIdForIdentity("lark", externalId),
        type: "person",
        title: "Direct message partner",
        managed: "hybrid",
        created_at: timestamp,
        updated_at: timestamp,
        source_refs: [],
        identities: [
          {
            provider: "lark",
            external_id: externalId,
            display_name: "Direct message partner"
          }
        ],
        role: null,
        role_origin: null,
        is_leader: false,
        leader_boost: 20,
        observations: [],
        last_interaction_at: timestamp
      },
      ""
    );
    await context.runtime.index.rebuild(context.runtime.store);
    const listSources = vi.spyOn(
      context.runtime.machineContext,
      "listSources"
    );

    const people = await request(context.app)
      .get("/api/documents?type=person")
      .expect(200);
    await request(context.app)
      .get("/api/documents?type=knowledge")
      .expect(200);

    expect(people.body).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ title: "List Person" })
      })
    ]);
    expect(listSources).not.toHaveBeenCalled();
  });

  it("updates explicit Leader configuration", async () => {
    await authorized(request(context.app).put("/api/config/leaders"))
      .send([{ person_id: "person_alice", boost: 24 }])
      .expect(200);
    const config = await request(context.app).get("/api/config").expect(200);
    expect(config.body.leaders).toEqual([{ person_id: "person_alice", boost: 24 }]);
    expect(config.body.loop).toMatchObject({
      enabled: true,
      automaticExecutionEnabled: false,
      executionEndpoint: "/api/agent/sessions"
    });
    expect(config.body.analysis.current_provider).toBe("codex-sdk");
    expect(config.body.analysis.providers).toHaveLength(2);
  });

  it("runs a read-only synchronization through the injected runner", async () => {
    const preflight = await request(context.app)
      .get("/api/sync/lark/preflight")
      .expect(200);
    expect(preflight.body).toMatchObject({
      state: "ready",
      ready: true,
      initial_sync_completed: false,
      missing_scopes: []
    });
    const before = await request(context.app)
      .get("/api/sync/lark/status")
      .expect(200);
    expect(before.body.running).toBe(false);
    const status = await authorized(
      request(context.app).post("/api/sync/lark")
    ).expect(200);
    expect(status.body.running).toBe(false);
    expect(status.body.results).toHaveLength(5);
    expect(status.body.results.every((result: { ok: boolean }) => result.ok)).toBe(true);
    expect(status.body.progress).toMatchObject({
      phase: "completed",
      message: "同步已完成，分析任务已加入队列"
    });
    const after = await request(context.app)
      .get("/api/sync/lark/status")
      .expect(200);
    expect(after.body.progress.phase).toBe("completed");
  });

  it("blocks the first API synchronization before any Lark source call when permissions are missing", async () => {
    permissionChecker.result = {
      ...readyPermissionProbe(),
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

    const preflight = await request(context.app)
      .get("/api/sync/lark/preflight")
      .expect(200);
    expect(preflight.body).toMatchObject({
      state: "missing_permissions",
      initial_sync_completed: false
    });

    const response = await authorized(
      request(context.app).post("/api/sync/lark")
    ).expect(409);
    expect(response.body.preflight).toMatchObject({
      ready: false,
      initial_sync_completed: false
    });
    expect(commandRunner.calls).toHaveLength(0);
    expect(new SyncRepository(context.runtime.database).latestRun()).toBeNull();
    expect(context.runtime.sync.getStatus()).toEqual(
      expect.objectContaining({ running: false, started_at: null })
    );
  });

  it("persists periodic read-only synchronization configuration", async () => {
    const initial = await request(context.app).get("/api/config").expect(200);
    expect(initial.body.lark.schedule.config).toEqual({
      enabled: false,
      interval: 1,
      unit: "hours"
    });

    await authorized(
      request(context.app).put("/api/config/lark-sync-schedule")
    )
      .send({ enabled: true, interval: 15, unit: "minutes" })
      .expect(200);
    const updated = await request(context.app).get("/api/config").expect(200);
    expect(updated.body.lark.schedule.config).toEqual({
      enabled: true,
      interval: 15,
      unit: "minutes"
    });
    await authorized(
      request(context.app).put("/api/config/lark-sync-schedule")
    )
      .send({ enabled: true, interval: 169, unit: "hours" })
      .expect(400);
  });

  it("switches providers without making an analysis call", async () => {
    await authorized(request(context.app).put("/api/config/analysis"))
      .send({
        provider: "codex-exec",
        model: "test-model",
        reasoning_effort: "high"
      })
      .expect(200);
    const config = await request(context.app).get("/api/config").expect(200);
    expect(config.body.analysis.current_provider).toBe("codex-exec");
    expect(config.body.analysis.config.model).toBe("test-model");
    expect(config.body.analysis.config.reasoning_effort).toBe("high");
    expect(sdkProvider.calls).toBe(0);
    expect(execProvider.calls).toBe(0);
    await authorized(request(context.app).put("/api/config/analysis"))
      .send({ model: "second-model" })
      .expect(200);
    const modelOnlyUpdate = await request(context.app)
      .get("/api/config")
      .expect(200);
    expect(modelOnlyUpdate.body.analysis.config.reasoning_effort).toBe("high");
    await authorized(request(context.app).put("/api/config/analysis"))
      .send({ reasoning_effort: "extreme" })
      .expect(400);
    await authorized(request(context.app).put("/api/config/analysis"))
      .send({ provider: "unknown-provider" })
      .expect(400);
  });

  it("updates the LLM Worker pool concurrency without changing analysis config", async () => {
    const before = await request(context.app).get("/api/config").expect(200);
    expect(before.body.analysis.worker_count).toBe(1);
    expect(before.body.analysis.config).not.toHaveProperty("worker_count");

    await authorized(
      request(context.app).put("/api/config/analysis/workers")
    )
      .send({ worker_count: 3 })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          worker_count: 3,
          source: "workspace",
          locked: false
        });
      });

    expect(context.runtime.analysisWorker.workerCount).toBe(3);
    const after = await request(context.app).get("/api/config").expect(200);
    expect(after.body.analysis.worker_count).toBe(3);
    await authorized(
      request(context.app).put("/api/config/analysis/workers")
    )
      .send({ worker_count: 9 })
      .expect(400);
  });

  it("locks provider editing when an environment override is active", async () => {
    const locked = await createApp({
      workspaceRoot: root,
      commandRunner: new EmptyRunner(),
      larkPermissionChecker: readyLarkPermissions,
      analysisProviders: [
        new ApiAnalysisProvider("codex-sdk"),
        new ApiAnalysisProvider("codex-exec")
      ],
      environment: {
        CONTEXT_SPACE_ANALYSIS_PROVIDER: "codex-exec",
        CONTEXT_SPACE_ANALYSIS_WORKERS: "4"
      }
    });
    const config = await request(locked.app).get("/api/config").expect(200);
    const lockedToken = (
      await request(locked.app).get("/api/security/csrf").expect(200)
    ).body.token as string;
    expect(config.body.analysis.current_provider).toBe("codex-exec");
    expect(config.body.analysis.provider_locked).toBe(true);
    expect(config.body.analysis.worker_count).toBe(4);
    expect(config.body.analysis.worker_count_locked).toBe(true);
    expect(locked.runtime.analysisWorker.workerCount).toBe(4);
    await authorized(
      request(locked.app).put("/api/config/analysis"),
      lockedToken
    )
      .send({ provider: "codex-sdk" })
      .expect(409);
    await authorized(
      request(locked.app).put("/api/config/analysis/workers"),
      lockedToken
    )
      .send({ worker_count: 2 })
      .expect(409);
    locked.runtime.sourceRetention.stop();
    await locked.runtime.analysisWorker.stop();
    await locked.runtime.markdownIndexSync.stop();
    locked.runtime.database.close();
  });

  it("reanalyzes one saved source through the selected provider", async () => {
    const timestamp = "2026-07-20T00:00:00.000Z";
    const source: SourceMetadata = {
      schema: "work-context/source@1",
      id: "lark:message:api_reanalysis",
      type: "source",
      title: "API reanalysis",
      managed: "generated",
      created_at: timestamp,
      updated_at: timestamp,
      source_refs: [],
      provider: "lark",
      source_kind: "mention",
      source_id: "lark:message:api_reanalysis",
      occurred_at: timestamp,
      participants: [],
      provider_metadata: {}
    };
    context.runtime.machineContext.upsertSource(
      machineSource(
        source.id,
        "mention",
        source.occurred_at,
        "# API reanalysis\n\n隐含工作内容",
        source.title
      )
    );
    const result = await authorized(
      request(context.app).post("/api/analysis/reanalyze")
    )
      .send({ source_id: source.id })
      .expect(202);
    expect(result.body.requested).toBe(1);
    expect(result.body.job_id).toMatch(/^job_/);
    expect(sdkProvider.calls).toBe(0);
    expect(await context.runtime.analysisWorker.runOnce()).toBe(true);
    expect(sdkProvider.calls).toBe(1);
  });

  it("correlates HTTP logs without recording query values or request bodies", async () => {
    const secretQuery = "private-query-value";
    const successful = await request(context.app)
      .get(`/api/search?q=${secretQuery}`)
      .set("x-request-id", "request-safe-1")
      .expect(200);
    expect(successful.headers["x-request-id"]).toBe("request-safe-1");

    const failed = await authorized(
      request(context.app).put("/api/config/leaders")
    )
      .set("x-request-id", "request-error-1")
      .send([{ person_id: "alice", boost: 999 }])
      .expect(400);
    expect(failed.headers["x-request-id"]).toBe("request-error-1");

    const [left, right, regenerated] = await Promise.all([
      request(context.app)
        .get("/api/health")
        .set("x-request-id", "request-left")
        .expect(200),
      request(context.app)
        .get("/api/health")
        .set("x-request-id", "request-right")
        .expect(200),
      request(context.app)
        .get("/api/health")
        .set("x-request-id", "unsafe request id")
        .expect(200)
    ]);
    expect(left.headers["x-request-id"]).toBe("request-left");
    expect(right.headers["x-request-id"]).toBe("request-right");
    expect(regenerated.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    await logger.flush();

    expect(JSON.stringify(logEntries)).not.toContain(secretQuery);
    expect(JSON.stringify(logEntries)).not.toContain('"boost":999');
    expect(logEntries).toContainEqual(
      expect.objectContaining({
        event: "http.request.completed",
        request_id: "request-safe-1",
        method: "GET",
        path: "/api/search",
        status_code: 200
      })
    );
    expect(logEntries).toContainEqual(
      expect.objectContaining({
        event: "http.request.failed",
        request_id: "request-error-1",
        status_code: 400
      })
    );
    expect(
      logEntries
        .filter(({ event }) => event === "http.request.completed")
        .map(({ request_id }) => request_id)
    ).toEqual(
      expect.arrayContaining([
        "request-left",
        "request-right",
        "request-error-1"
      ])
    );
  });

  it("rejects mutations without a CSRF token or from an untrusted Origin", async () => {
    await request(context.app)
      .post("/api/sync/lark")
      .expect(403, { error: "CSRF Token 无效或缺失" });
    await authorized(request(context.app).post("/api/sync/lark"))
      .set("Origin", "https://attacker.example")
      .expect(403, { error: "请求 Origin 不受信任" });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnalysisProvider,
  ProviderAnalysisResponse
} from "../src/analysis/contracts";
import type { CommandRunner } from "../src/adapters/lark/runner";
import { createTodoMetadata } from "../src/core/todo";
import type { PersonMetadata, SourceMetadata } from "../src/core/types";
import {
  createConfiguredLogger,
  type Logger,
  type LoggingConfig
} from "../src/logging";
import { createApp } from "../src/server/app";

class EmptyRunner implements CommandRunner {
  async run(args: string[]): Promise<unknown> {
    if (args[0] === "contact") return { open_id: "ou_self", name: "Me" };
    if (args[0] === "im") return { messages: [] };
    if (args[0] === "calendar") return { events: [] };
    if (args[0] === "task") return { tasks: [] };
    return {};
  }
}

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
  let logEntries: Array<Record<string, unknown>>;

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
    context = await createApp({
      workspaceRoot: root,
      commandRunner: new EmptyRunner(),
      analysisProviders: [sdkProvider, execProvider],
      environment: {},
      logger
    });
  });

  afterEach(async () => {
    await logger.close();
    await rm(root, { recursive: true, force: true });
  });

  it("serves health, overview, search, and no execution endpoint", async () => {
    const health = await request(context.app).get("/api/health").expect(200);
    expect(health.body.loopExecutionEnabled).toBe(false);
    await request(context.app).get("/api/overview").expect(200);
    await request(context.app).get("/api/search?q=workspace").expect(200);
    await request(context.app).post("/api/loop/execute").send({ todo: "x" }).expect(404);
  });

  it("uses optimistic concurrency for editable documents", async () => {
    const todo = createTodoMetadata({ id: "todo_api", title: "API Todo" });
    await context.runtime.store.write("todos/items/todo_api.md", todo, "# Original");
    await context.runtime.index.rebuild(context.runtime.store);
    const loaded = await request(context.app).get("/api/documents/todo_api").expect(200);
    const update = {
      etag: loaded.body.etag,
      data: { ...loaded.body.data, title: "Updated API Todo" },
      body: "# Updated"
    };
    const saved = await request(context.app).put("/api/documents/todo_api").send(update).expect(200);
    expect(saved.body.data.title).toBe("Updated API Todo");
    await request(context.app).put("/api/documents/todo_api").send(update).expect(409);
  });

  it("updates Todo status through the dedicated endpoint", async () => {
    const todo = createTodoMetadata({ id: "todo_status", title: "Status Todo" });
    await context.runtime.store.write("todos/items/todo_status.md", todo, "# Status Todo");
    await context.runtime.index.rebuild(context.runtime.store);

    const completed = await request(context.app)
      .patch("/api/todos/todo_status/status")
      .send({ status: "done" })
      .expect(200);
    expect(completed.body.data.status).toBe("done");

    const reopened = await request(context.app)
      .patch("/api/todos/todo_status/status")
      .send({ status: "open" })
      .expect(200);
    expect(reopened.body.data.status).toBe("open");
    await request(context.app)
      .patch("/api/todos/todo_status/status")
      .send({ status: "invalid" })
      .expect(400);
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
    const person: PersonMetadata = {
      schema: "work-context/person@1",
      id: "person_api",
      type: "person",
      title: "Alice",
      managed: "hybrid",
      created_at: timestamp,
      updated_at: timestamp,
      source_refs: [source.id],
      identities: [],
      role: null,
      role_origin: null,
      is_leader: false,
      leader_boost: 20,
      observations: [],
      last_interaction_at: timestamp
    };
    await context.runtime.store.write(
      "sources/lark/dms/alice/person_api.md",
      source,
      "# 发布讨论\n\nAlice 会在评审前汇总阻塞项"
    );
    await context.runtime.store.write("people/person_api.md", person, "# Alice");
    await context.runtime.index.rebuild(context.runtime.store);

    const response = await request(context.app)
      .get("/api/documents/person_api")
      .expect(200);
    expect(response.body.provenanceSources).toEqual([
      expect.objectContaining({
        id: source.id,
        title: "发布讨论",
        body: expect.stringContaining("汇总阻塞项")
      })
    ]);
  });

  it("updates explicit Leader configuration", async () => {
    await request(context.app)
      .put("/api/config/leaders")
      .send([{ person_id: "person_alice", boost: 24 }])
      .expect(200);
    const config = await request(context.app).get("/api/config").expect(200);
    expect(config.body.leaders).toEqual([{ person_id: "person_alice", boost: 24 }]);
    expect(config.body.loop.executionEndpoint).toBeNull();
    expect(config.body.analysis.current_provider).toBe("codex-sdk");
    expect(config.body.analysis.providers).toHaveLength(2);
  });

  it("runs a read-only synchronization through the injected runner", async () => {
    const before = await request(context.app)
      .get("/api/sync/lark/status")
      .expect(200);
    expect(before.body.running).toBe(false);
    const status = await request(context.app).post("/api/sync/lark").expect(200);
    expect(status.body.running).toBe(false);
    expect(status.body.results).toHaveLength(5);
    expect(status.body.results.every((result: { ok: boolean }) => result.ok)).toBe(true);
    expect(status.body.progress).toMatchObject({
      phase: "completed",
      message: "同步已完成"
    });
    const after = await request(context.app)
      .get("/api/sync/lark/status")
      .expect(200);
    expect(after.body.progress.phase).toBe("completed");
  });

  it("switches providers without making an analysis call", async () => {
    await request(context.app)
      .put("/api/config/analysis")
      .send({ provider: "codex-exec", model: "test-model" })
      .expect(200);
    const config = await request(context.app).get("/api/config").expect(200);
    expect(config.body.analysis.current_provider).toBe("codex-exec");
    expect(config.body.analysis.config.model).toBe("test-model");
    expect(sdkProvider.calls).toBe(0);
    expect(execProvider.calls).toBe(0);
    await request(context.app)
      .put("/api/config/analysis")
      .send({ provider: "unknown-provider" })
      .expect(400);
  });

  it("locks provider editing when an environment override is active", async () => {
    const locked = await createApp({
      workspaceRoot: root,
      commandRunner: new EmptyRunner(),
      analysisProviders: [
        new ApiAnalysisProvider("codex-sdk"),
        new ApiAnalysisProvider("codex-exec")
      ],
      environment: { CONTEXT_SPACE_ANALYSIS_PROVIDER: "codex-exec" }
    });
    const config = await request(locked.app).get("/api/config").expect(200);
    expect(config.body.analysis.current_provider).toBe("codex-exec");
    expect(config.body.analysis.provider_locked).toBe(true);
    await request(locked.app)
      .put("/api/config/analysis")
      .send({ provider: "codex-sdk" })
      .expect(409);
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
    await context.runtime.store.write(
      "sources/lark/mentions/2026/07/api_reanalysis.md",
      source,
      "# API reanalysis\n\n**Occurred:** 2026-07-20T00:00:00.000Z\n\n隐含工作内容"
    );
    await context.runtime.index.rebuild(context.runtime.store);
    const result = await request(context.app)
      .post("/api/analysis/reanalyze")
      .send({ source_id: source.id })
      .expect(200);
    expect(result.body.requested).toBe(1);
    expect(result.body.succeeded).toBe(1);
    expect(sdkProvider.calls).toBe(1);
  });

  it("correlates HTTP logs without recording query values or request bodies", async () => {
    const secretQuery = "private-query-value";
    const successful = await request(context.app)
      .get(`/api/search?q=${secretQuery}`)
      .set("x-request-id", "request-safe-1")
      .expect(200);
    expect(successful.headers["x-request-id"]).toBe("request-safe-1");

    const failed = await request(context.app)
      .put("/api/config/leaders")
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
});

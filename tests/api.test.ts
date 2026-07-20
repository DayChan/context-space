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
import type { SourceMetadata } from "../src/core/types";
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
        schema_version: "work-context/analysis@1",
        items: []
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

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-api-"));
    sdkProvider = new ApiAnalysisProvider("codex-sdk");
    execProvider = new ApiAnalysisProvider("codex-exec");
    context = await createApp({
      workspaceRoot: root,
      commandRunner: new EmptyRunner(),
      analysisProviders: [sdkProvider, execProvider],
      environment: {}
    });
  });

  afterEach(async () => {
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
    const status = await request(context.app).post("/api/sync/lark").expect(200);
    expect(status.body.running).toBe(false);
    expect(status.body.results).toHaveLength(5);
    expect(status.body.results.every((result: { ok: boolean }) => result.ok)).toBe(true);
  });

  it("switches providers without making an analysis call", async () => {
    await request(context.app)
      .put("/api/config/analysis")
      .send({ provider: "codex-exec" })
      .expect(200);
    const config = await request(context.app).get("/api/config").expect(200);
    expect(config.body.analysis.current_provider).toBe("codex-exec");
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
});

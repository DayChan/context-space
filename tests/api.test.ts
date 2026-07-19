import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/adapters/lark/runner";
import { createTodoMetadata } from "../src/core/todo";
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

describe("local API", () => {
  let root: string;
  let context: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-api-"));
    context = await createApp({ workspaceRoot: root, commandRunner: new EmptyRunner() });
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
  });

  it("runs a read-only synchronization through the injected runner", async () => {
    const status = await request(context.app).post("/api/sync/lark").expect(200);
    expect(status.body.running).toBe(false);
    expect(status.body.results).toHaveLength(5);
    expect(status.body.results.every((result: { ok: boolean }) => result.ok)).toBe(true);
  });
});

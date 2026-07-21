import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownIndexSync } from "../src/core/markdown-index-sync";
import {
  MarkdownSchemaRegistry,
  UnknownMarkdownSchemaError
} from "../src/core/markdown-schema";
import { createTodoMetadata } from "../src/core/todo";
import { initializeHumanWorkspace } from "../src/core/workspace";
import {
  MarkdownIndexRepository,
  openMachineDatabase,
  type MachineDatabase
} from "../src/machine";

describe("Markdown schema and SQLite index", () => {
  let root: string;
  let database: MachineDatabase;
  let repository: MarkdownIndexRepository;
  let synchronization: MarkdownIndexSync;
  let store: Awaited<ReturnType<typeof initializeHumanWorkspace>>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-index-"));
    store = await initializeHumanWorkspace(root);
    database = await openMachineDatabase(root);
    repository = new MarkdownIndexRepository(database);
    synchronization = new MarkdownIndexSync(
      store,
      repository,
      new MarkdownSchemaRegistry(),
      { watcher: { usePolling: true, interval: 25 } }
    );
  });

  afterEach(async () => {
    await synchronization.stop();
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("initializes only human Markdown roots", async () => {
    await expect(
      readFile(path.join(root, "config", "analysis.md"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(root, "sources", "lark", "tasks", "x.md"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.exists("todos/items/missing.md")).toBe(false);
  });

  it("dispatches supported schemas and diagnoses unknown versions without rewriting", async () => {
    const registry = new MarkdownSchemaRegistry();
    expect(
      registry.parse(
        createTodoMetadata({
          id: "todo_schema",
          title: "Schema",
          managed: "manual"
        })
      ).type
    ).toBe("todo");
    expect(() =>
      registry.parse({
        ...createTodoMetadata({
          id: "todo_future",
          title: "Future",
          managed: "manual"
        }),
        schema: "work-context/todo@99"
      })
    ).toThrow(UnknownMarkdownSchemaError);
    await store.write(
      "todos/items/future.md",
      {
        ...createTodoMetadata({
          id: "todo_future_file",
          title: "Future file",
          managed: "manual"
        }),
        schema: "work-context/todo@99"
      },
      "# Future bytes"
    );
    const absolute = path.join(root, "todos/items/future.md");
    const before = await readFile(absolute, "utf8");
    await synchronization.reconcile();
    expect(await readFile(absolute, "utf8")).toBe(before);
    expect(repository.diagnostics()).toMatchObject([
      {
        path: "todos/items/future.md",
        code: "UnknownMarkdownSchemaError"
      }
    ]);
  });

  it("rebuilds atomically and isolates an invalid document", async () => {
    await store.write(
      "todos/items/valid.md",
      createTodoMetadata({
        id: "valid",
        title: "Valid",
        managed: "manual",
        source_refs: ["lark:message:one"]
      }),
      "# Valid"
    );
    await store.write(
      "people/person.md",
      {
        schema: "work-context/person@1",
        id: "person",
        type: "person",
        title: "Person",
        managed: "manual",
        created_at: "2026-07-20T00:00:00.000Z",
        updated_at: "2026-07-20T00:00:00.000Z",
        source_refs: [],
        identities: [],
        role: null,
        role_origin: null,
        is_leader: false,
        leader_boost: 0,
        observations: [],
        last_interaction_at: null
      },
      "# Person"
    );
    expect(await synchronization.reconcile()).toBe(2);

    const person = await store.read("people/person.md");
    await store.write(
      person.path,
      {
        schema: "work-context/person@1",
        id: "person",
        type: "person",
        title: "Broken",
        managed: "manual",
        created_at: person.data.created_at,
        updated_at: person.data.updated_at,
        source_refs: []
      },
      "# Broken",
      { expectedEtag: person.etag }
    );
    expect(await synchronization.reconcile()).toBe(2);
    expect(repository.byId("valid")?.data.title).toBe("Valid");
    expect(repository.byId("person")?.data.title).toBe("Person");
    expect(repository.diagnostics()).toMatchObject([
      { path: "people/person.md" }
    ]);
  });

  it("updates one externally edited file and uses reconciliation as fallback", async () => {
    const todo = await store.write(
      "todos/items/edit.md",
      createTodoMetadata({
        id: "edit",
        title: "Before",
        managed: "manual"
      }),
      "# Before"
    );
    await synchronization.reconcile();
    await store.write(
      todo.path,
      { ...todo.data, title: "After" },
      "# After",
      { expectedEtag: todo.etag }
    );
    await synchronization.refreshPath(todo.path);
    expect(repository.byId("edit")?.data.title).toBe("After");

    const current = await store.read(todo.path);
    await store.write(
      current.path,
      { ...current.data, title: "Recovered by calibration" },
      "# Recovered",
      { expectedEtag: current.etag }
    );
    expect(repository.byId("edit")?.data.title).toBe("After");
    await synchronization.reconcile();
    expect(repository.byId("edit")?.data.title).toBe(
      "Recovered by calibration"
    );
  });

  it("closes the startup gap and observes external file saves through the watcher", async () => {
    await store.write(
      "todos/items/before-start.md",
      createTodoMetadata({
        id: "before-start",
        title: "Before start",
        managed: "manual"
      }),
      "# Before start"
    );
    await synchronization.start();
    expect(repository.byId("before-start")?.data.title).toBe("Before start");
    await store.write(
      "todos/items/watched.md",
      createTodoMetadata({
        id: "watched",
        title: "Watched",
        managed: "manual"
      }),
      "# Watched"
    );
    const deadline = Date.now() + 2_000;
    while (!repository.byId("watched") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(repository.byId("watched")?.data.title).toBe("Watched");
  });
});

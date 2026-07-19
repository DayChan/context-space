import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LarkAdapter } from "../src/adapters/lark/adapter";
import {
  assertReadOnlyLarkCommand,
  type CommandRunner,
  prepareReadOnlyLarkArgs,
  UnsafeLarkCommandError
} from "../src/adapters/lark/runner";
import { LarkSyncService } from "../src/adapters/lark/sync";
import { ContextIndex } from "../src/core/index";
import { initializeWorkspace } from "../src/core/workspace";

class FakeRunner implements CommandRunner {
  calls: string[][] = [];

  constructor(private readonly failCalendar = false) {}

  async run(args: string[]): Promise<unknown> {
    this.calls.push(args);
    const command = `${args[0]}:${args[1]}`;
    if (command === "contact:+get-user") {
      return { open_id: "ou_self", name: "Me" };
    }
    if (command === "im:+messages-search") {
      const p2p = args.includes("p2p");
      return {
        messages: [
          {
            message_id: p2p ? "om_p2p" : "om_mention",
            content: JSON.stringify({ text: p2p ? "请你跟进设计" : "请你准备发布计划" }),
            create_time: "1784476800000",
            sender: { id: "ou_alice", name: "Alice" },
            chat_partner: p2p ? { open_id: "ou_alice", name: "Alice" } : undefined,
            chat_name: p2p ? "Alice" : "Launch room",
            chat_type: p2p ? "p2p" : "group"
          }
        ]
      };
    }
    if (command === "calendar:+agenda") {
      if (this.failCalendar) throw new Error("calendar permission missing");
      return {
        events: [
          {
            event_id: "event_1",
            summary: "Launch review",
            start_time: "2026-07-20T09:00:00+08:00",
            end_time: "2026-07-20T10:00:00+08:00"
          }
        ]
      };
    }
    if (command === "task:+get-my-tasks") {
      return {
        tasks: [
          {
            guid: "task_1",
            summary: "Publish release notes",
            created_at: "1784476800000",
            status: "open"
          }
        ]
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  }
}

describe("read-only Lark adapter", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-lark-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("adds user identity and rejects mutation commands", () => {
    const prepared = prepareReadOnlyLarkArgs(["im", "+messages-search", "--is-at-me"]);
    expect(prepared).toContain("user");
    expect(prepared).toContain("json");
    expect(() => assertReadOnlyLarkCommand(["im", "+messages-send"])).toThrow(
      UnsafeLarkCommandError
    );
    expect(() => assertReadOnlyLarkCommand(["task", "+complete"])).toThrow(
      UnsafeLarkCommandError
    );
  });

  it("normalizes all supported sources", async () => {
    const runner = new FakeRunner();
    const adapter = new LarkAdapter(runner);
    const start = new Date("2026-07-19T00:00:00Z");
    const end = new Date("2026-07-21T00:00:00Z");
    const results = await Promise.all(
      (["self", "mentions", "p2p", "calendar", "tasks"] as const).map((source) =>
        adapter.fetchSource(source, start, end)
      )
    );
    expect(results.every((result) => result.result.ok)).toBe(true);
    expect(results.flatMap((result) => result.records).map((record) => record.kind)).toEqual(
      expect.arrayContaining(["person", "mention", "p2p", "calendar", "task"])
    );
  });

  it("persists idempotently and isolates a partial failure", async () => {
    const store = await initializeWorkspace(root);
    const index = new ContextIndex();
    await index.rebuild(store);
    const first = new LarkSyncService(store, index, new LarkAdapter(new FakeRunner()));
    const clock = new Date("2026-07-20T12:00:00Z");
    const firstStatus = await first.sync({
      now: clock,
      backfillDays: 1,
      windowDays: 1,
      overlapMinutes: 10
    });
    expect(firstStatus.results.every((result) => result.ok)).toBe(true);
    const sourceCount = index.search("", "source").length;
    const secondStatus = await first.sync({
      now: new Date("2026-07-20T12:05:00Z"),
      backfillDays: 1,
      windowDays: 1,
      overlapMinutes: 10
    });
    expect(index.search("", "source")).toHaveLength(sourceCount);
    expect(secondStatus.results.find((result) => result.source === "mentions")?.persisted).toBe(0);

    const partial = new LarkSyncService(
      store,
      index,
      new LarkAdapter(new FakeRunner(true))
    );
    const partialStatus = await partial.sync({
      now: new Date("2026-07-20T12:10:00Z"),
      backfillDays: 1,
      windowDays: 1
    });
    expect(partialStatus.results.find((result) => result.source === "calendar")?.ok).toBe(false);
    expect(partialStatus.results.find((result) => result.source === "tasks")?.ok).toBe(true);
    const checkpoint = await store.read(".context/sync/lark.md");
    expect(
      (checkpoint.data.source_checkpoints as Record<string, unknown>).tasks
    ).toBeDefined();
  });
});

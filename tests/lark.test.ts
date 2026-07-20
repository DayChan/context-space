import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisConfigService } from "../src/analysis/config";
import { AnalysisCoordinator } from "../src/analysis/coordinator";
import type {
  AnalysisProvider,
  ProviderAnalysisRequest,
  ProviderAnalysisResponse
} from "../src/analysis/contracts";
import { AnalysisProviderRegistry } from "../src/analysis/providers/registry";
import { LarkAdapter } from "../src/adapters/lark/adapter";
import { normalizeTasks } from "../src/adapters/lark/normalize";
import {
  assertReadOnlyLarkCommand,
  LarkCliCommandError,
  parseLarkCliIssue,
  type CommandRunner,
  prepareReadOnlyLarkArgs,
  UnsafeLarkCommandError
} from "../src/adapters/lark/runner";
import { LarkSyncService } from "../src/adapters/lark/sync";
import { ContextIndex } from "../src/core/index";
import { initializeWorkspace } from "../src/core/workspace";

class FakeAnalysisProvider implements AnalysisProvider {
  readonly id = "codex-sdk";

  constructor(private readonly shouldFail = false) {}

  async getAvailability() {
    return { available: true, detail: "测试 Provider" };
  }

  async analyze(request: ProviderAnalysisRequest): Promise<ProviderAnalysisResponse> {
    if (this.shouldFail) throw new Error("simulated model outage");
    const sourceId = request.prompt.match(/"source_ref":"([^"]+)"/)?.[1] ?? "";
    const evidence = request.prompt.includes("跟进设计")
      ? "请你跟进设计"
      : "请你准备发布计划";
    return {
      finalResponse: JSON.stringify({
        schema_version: "work-context/analysis@1",
        items: [
          {
            kind: "todo",
            title: evidence,
            source_ref: sourceId,
            confidence: 0.9,
            evidence: [evidence],
            reason: "消息明确要求当前用户完成工作",
            status: "open",
            direction: "owed_by_me",
            due_at: null,
            explicit: true,
            stakeholders: []
          }
        ]
      }),
      model: "fake",
      usage: null,
      eventTypes: ["agent_message"]
    };
  }
}

function createAnalysis(
  store: Awaited<ReturnType<typeof initializeWorkspace>>,
  index: ContextIndex,
  provider: AnalysisProvider = new FakeAnalysisProvider()
): AnalysisCoordinator {
  return new AnalysisCoordinator(
    store,
    index,
    new AnalysisProviderRegistry([provider]),
    new AnalysisConfigService(store, {})
  );
}

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

  it("uses second-precision windows and requests only incomplete tasks", async () => {
    const runner = new FakeRunner();
    const adapter = new LarkAdapter(runner);
    const start = new Date("2026-06-20T07:02:23.616Z");
    const end = new Date("2026-06-27T07:02:23.616Z");

    await adapter.fetchSource("mentions", start, end);
    await adapter.fetchSource("calendar", start, end);
    await adapter.fetchSource("tasks", start, end);

    const mentions = runner.calls.find(
      ([service, command]) => service === "im" && command === "+messages-search"
    );
    const calendar = runner.calls.find(
      ([service, command]) => service === "calendar" && command === "+agenda"
    );
    const tasks = runner.calls.find(
      ([service, command]) => service === "task" && command === "+get-my-tasks"
    );
    expect(mentions).toEqual(
      expect.arrayContaining([
        "--start",
        "2026-06-20T07:02:23Z",
        "--end",
        "2026-06-27T07:02:23Z"
      ])
    );
    expect(calendar).toEqual(
      expect.arrayContaining([
        "--start",
        "2026-06-20T07:02:23Z",
        "--end",
        "2026-06-27T07:02:23Z"
      ])
    );
    expect(tasks).toEqual(expect.arrayContaining(["--complete=false", "--page-all"]));
  });

  it("defensively discards completed tasks returned by the upstream CLI", () => {
    const records = normalizeTasks({
      tasks: [
        {
          guid: "task_open",
          summary: "Open task",
          created_at: "1784476800000",
          status: "open"
        },
        {
          guid: "task_done",
          summary: "Done task",
          created_at: "1784476800000",
          status: "completed"
        },
        {
          guid: "task_completed_at",
          summary: "Completed with timestamp",
          created_at: "1784476800000",
          completed_at: "1784476900000",
          status: "open"
        }
      ]
    });
    expect(records.map(({ sourceId }) => sourceId)).toEqual(["lark:task:task_open"]);
  });

  it("parses actionable permission diagnostics and CLI update notices", () => {
    const permission = parseLarkCliIssue({
      ok: false,
      identity: "user",
      error: {
        type: "authorization",
        subtype: "missing_scope",
        code: 99991679,
        message: "missing scope",
        missing_scopes: ["im:message:readonly"],
        hint: "lark-cli auth login --scope \"im:message:readonly\"",
        console_url: "https://open.feishu.cn/app/permission"
      }
    });
    expect(permission).toMatchObject({
      kind: "permission",
      requires_action: true,
      code: 99991679,
      missing_scopes: ["im:message:readonly"]
    });

    const invalidParameters = parseLarkCliIssue(JSON.stringify({
      ok: false,
      identity: "user",
      error: {
        type: "api",
        subtype: "invalid_parameters",
        code: 99992402,
        message: "field validation failed",
        log_id: "log_123",
        troubleshooter: "排查建议：https://open.feishu.cn/search?code=99992402"
      },
      _notice: {
        update: {
          command: "lark-cli update",
          current: "1.0.50",
          latest: "1.0.72",
          message: "update available"
        }
      }
    }));
    expect(invalidParameters).toMatchObject({
      kind: "invalid_parameters",
      requires_action: false,
      code: 99992402,
      log_id: "log_123",
      update: {
        command: "lark-cli update",
        current: "1.0.50",
        latest: "1.0.72"
      }
    });
  });

  it("maps structured lark-cli errors into source results", async () => {
    const issue = parseLarkCliIssue({
      ok: false,
      error: {
        type: "authorization",
        subtype: "missing_scope",
        message: "missing calendar scope",
        missing_scopes: ["calendar:calendar.event:read"]
      }
    });
    expect(issue).not.toBeNull();
    const runner: CommandRunner = {
      async run() {
        throw new LarkCliCommandError(issue!);
      }
    };
    const result = await new LarkAdapter(runner).fetchSource(
      "calendar",
      new Date("2026-07-19T00:00:00Z"),
      new Date("2026-07-20T00:00:00Z")
    );
    expect(result.result).toMatchObject({
      ok: false,
      issue: {
        kind: "permission",
        requires_action: true,
        missing_scopes: ["calendar:calendar.event:read"]
      }
    });
    expect(result.result.error).toContain("飞书权限不足");
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
    const analysis = createAnalysis(store, index);
    const first = new LarkSyncService(
      store,
      index,
      new LarkAdapter(new FakeRunner()),
      analysis
    );
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
      new LarkAdapter(new FakeRunner(true)),
      analysis
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

  it("advances source checkpoints when LLM analysis fails", async () => {
    const store = await initializeWorkspace(root);
    const index = new ContextIndex();
    await index.rebuild(store);
    const sync = new LarkSyncService(
      store,
      index,
      new LarkAdapter(new FakeRunner()),
      createAnalysis(store, index, new FakeAnalysisProvider(true))
    );
    const status = await sync.sync({
      now: new Date("2026-07-20T12:00:00Z"),
      backfillDays: 1,
      windowDays: 1
    });

    const mentions = status.results.find((result) => result.source === "mentions");
    expect(mentions?.ok).toBe(true);
    expect(mentions?.persisted).toBeGreaterThan(0);
    expect(mentions?.analysis_failed).toBeGreaterThan(0);
    const checkpoint = await store.read(".context/sync/lark.md");
    expect(
      (checkpoint.data.source_checkpoints as Record<string, unknown>).mentions
    ).toBeDefined();
    expect(index.byId("lark:message:om_mention")).toBeDefined();
  });

  it("persists actionable permission issues in synchronization status", async () => {
    const issue = parseLarkCliIssue({
      ok: false,
      error: {
        type: "authorization",
        subtype: "missing_scope",
        message: "calendar permission missing",
        missing_scopes: ["calendar:calendar.event:read"],
        hint: "authorize calendar read access"
      }
    });
    const baseRunner = new FakeRunner();
    const runner: CommandRunner = {
      async run(args) {
        if (args[0] === "calendar") throw new LarkCliCommandError(issue!);
        return baseRunner.run(args);
      }
    };
    const store = await initializeWorkspace(root);
    const index = new ContextIndex();
    await index.rebuild(store);
    const sync = new LarkSyncService(
      store,
      index,
      new LarkAdapter(runner),
      createAnalysis(store, index)
    );

    const status = await sync.sync({
      now: new Date("2026-07-20T12:00:00Z"),
      backfillDays: 1,
      windowDays: 1
    });
    const calendar = status.results.find((result) => result.source === "calendar");
    expect(calendar?.issue).toMatchObject({
      kind: "permission",
      requires_action: true,
      missing_scopes: ["calendar:calendar.event:read"]
    });
    expect(status.last_error).toContain("需要人工处理");

    const persisted = await store.read(".context/sync/lark-status.md");
    const results = persisted.data.results as unknown as Array<{ issue?: { kind?: string } }>;
    expect(results.find((result) => result.issue)?.issue?.kind).toBe("permission");
  });
});

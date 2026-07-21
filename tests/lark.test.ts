import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnalysisProvider,
  ProviderAnalysisRequest,
  ProviderAnalysisResponse
} from "../src/analysis/contracts";
import { LarkAdapter } from "../src/adapters/lark/adapter";
import {
  normalizeMessages,
  normalizeTasks
} from "../src/adapters/lark/normalize";
import {
  assertReadOnlyLarkCommand,
  LarkCliCommandError,
  LarkCliCommandRunner,
  parseLarkCliIssue,
  type CommandRunner,
  prepareReadOnlyLarkArgs,
  UnsafeLarkCommandError
} from "../src/adapters/lark/runner";
import {
  LarkSyncService,
  synchronizationStart,
  syncOptionsFromEnvironment
} from "../src/adapters/lark/sync";
import { ContextIndex } from "../src/core/index";
import { initializeWorkspace } from "../src/core/workspace";
import {
  createConfiguredLogger,
  type Logger,
  type LoggingConfig
} from "../src/logging";
import { DEFAULT_ANALYSIS_CONFIG } from "../src/analysis/config";
import {
  AnalysisJobRepository,
  MachineContextRepository,
  SyncRepository,
  openMachineDatabase,
  type MachineDatabase
} from "../src/machine";

const testDatabases: MachineDatabase[] = [];

async function createTestSync(
  root: string,
  adapter: LarkAdapter,
  logger?: Logger
): Promise<LarkSyncService> {
  const database = await openMachineDatabase(root);
  testDatabases.push(database);
  return new LarkSyncService(
    database,
    new MachineContextRepository(database),
    new SyncRepository(database),
    new AnalysisJobRepository(database),
    adapter,
    async () => ({
      analysis: DEFAULT_ANALYSIS_CONFIG,
      timezone: "Asia/Singapore",
      currentUserId: "self"
    }),
    logger
  );
}

function memoryLogger(root: string): {
  logger: Logger;
  entries: Array<Record<string, unknown>>;
} {
  const entries: Array<Record<string, unknown>> = [];
  const config: LoggingConfig = {
    level: "trace",
    consoleEnabled: true,
    fileEnabled: false,
    directory: path.join(root, ".context", "logs"),
    maxFileBytes: 10 * 1024 * 1024,
    retentionDays: 14,
    service: "context-space"
  };
  return {
    entries,
    logger: createConfiguredLogger({
      config,
      stdout: (line) =>
        entries.push(JSON.parse(line) as Record<string, unknown>),
      stderr: (line) =>
        entries.push(JSON.parse(line) as Record<string, unknown>)
    })
  };
}

class FakeAnalysisProvider implements AnalysisProvider {
  readonly id = "codex-sdk";
  calls: ProviderAnalysisRequest[] = [];

  constructor(private readonly shouldFail = false) {}

  async getAvailability() {
    return { available: true, detail: "测试 Provider" };
  }

  async analyze(request: ProviderAnalysisRequest): Promise<ProviderAnalysisResponse> {
    this.calls.push(request);
    if (this.shouldFail) throw new Error("simulated model outage");
    const payload = request.prompt
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as {
            sources?: Array<{ source_ref: string; source_body: string }>;
          };
        } catch {
          return null;
        }
      })
      .find((value) => value?.sources)?.sources ?? [];
    return {
      finalResponse: JSON.stringify({
        schema_version: "work-context/analysis@2",
        items: payload.flatMap(({ source_ref, source_body }) => {
          const evidence = source_body.includes("跟进设计")
            ? "请你跟进设计"
            : source_body.includes("准备发布计划")
              ? "请你准备发布计划"
              : null;
          return evidence ? [{
            kind: "todo",
            title: evidence,
            source_refs: [source_ref],
            confidence: 0.9,
            evidence: [{ source_ref, quote: evidence }],
            reason: "消息明确要求当前用户完成工作",
            status: "open",
            direction: "owed_by_me",
            due_at: null,
            explicit: true,
            stakeholders: []
          }] : [];
        }),
        person_insights: []
      }),
      model: "fake",
      usage: null,
      eventTypes: ["agent_message"]
    };
  }
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

class PaginatedP2PRunner extends FakeRunner {
  constructor(
    private readonly pageCount: number,
    private readonly failAtPage?: number
  ) {
    super();
  }

  override async run(args: string[]): Promise<unknown> {
    if (
      args[0] !== "im" ||
      args[1] !== "+messages-search" ||
      !args.includes("p2p")
    ) {
      return super.run(args);
    }
    this.calls.push(args);
    const tokenIndex = args.indexOf("--page-token");
    const page =
      tokenIndex >= 0 ? Number(args[tokenIndex + 1].replace("page_", "")) : 0;
    if (page === this.failAtPage) {
      throw new Error(`simulated page ${page} failure`);
    }
    const hasMore = page + 1 < this.pageCount;
    return {
      messages: [
        {
          message_id: `om_p2p_${page}`,
          content: JSON.stringify({ text: `P2P page ${page}` }),
          create_time: String(1784476800000 + page),
          sender: { id: "ou_alice", name: "Alice" },
          chat_partner: { open_id: "ou_alice", name: "Alice" },
          chat_name: "Alice",
          chat_type: "p2p"
        }
      ],
      has_more: hasMore,
      ...(hasMore ? { page_token: `page_${page + 1}` } : {})
    };
  }
}

class DelayedMentionRunner implements CommandRunner {
  calls: string[][] = [];
  private mentionFetches = 0;

  async run(args: string[]): Promise<unknown> {
    this.calls.push(args);
    const command = `${args[0]}:${args[1]}`;
    if (command === "contact:+get-user") {
      return { open_id: "ou_self", name: "Me" };
    }
    if (command === "im:+messages-search" && args.includes("--is-at-me")) {
      this.mentionFetches += 1;
      if (this.mentionFetches === 1) return { messages: [] };
      return {
        messages: [
          {
            message_id: "om_delayed_mention",
            content: JSON.stringify({
              text: "@陈铎汝 铎汝，代理mgr你看看得迁移下了"
            }),
            create_time: String(
              new Date("2026-07-21T03:42:00Z").getTime()
            ),
            sender: { id: "ou_sender", name: "李正磊" },
            chat_name: "青岛汇聚机房下线前置确认",
            chat_type: "group",
            mentions: [
              { id: "ou_self", key: "@_user_1", name: "陈铎汝" }
            ]
          }
        ]
      };
    }
    if (command === "im:+messages-search") return { messages: [] };
    if (command === "calendar:+agenda") return { events: [] };
    if (command === "task:+get-my-tasks") return { tasks: [] };
    throw new Error(`Unexpected command: ${command}`);
  }
}

describe("read-only Lark adapter", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-lark-"));
  });

  afterEach(async () => {
    for (const database of testDatabases.splice(0)) database.close();
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

  it("keeps the full cursor interval and limits recent reconciliation to one hour", () => {
    const now = new Date("2026-07-21T12:00:00Z");
    expect(
      synchronizationStart({
        previousCursor: "2026-07-18T12:00:00Z",
        now,
        backfillDays: 1,
        reconciliationHours: 1
      }).toISOString()
    ).toBe("2026-07-18T12:00:00.000Z");
    expect(
      synchronizationStart({
        previousCursor: "2026-07-21T11:00:00Z",
        now,
        backfillDays: 1,
        reconciliationHours: 1
      }).toISOString()
    ).toBe("2026-07-21T11:00:00.000Z");
    expect(
      synchronizationStart({
        previousCursor: null,
        now,
        backfillDays: 1,
        reconciliationHours: 1
      }).toISOString()
    ).toBe("2026-07-20T12:00:00.000Z");
  });

  it("loads initial backfill and reconciliation defaults from the environment", () => {
    expect(syncOptionsFromEnvironment({})).toEqual({
      backfillDays: 1,
      reconciliationHours: 1
    });
    expect(
      syncOptionsFromEnvironment({
        CONTEXT_SPACE_BACKFILL_DAYS: "45",
        CONTEXT_SPACE_RECONCILIATION_HOURS: "48"
      })
    ).toEqual({ backfillDays: 45, reconciliationHours: 48 });
    expect(() =>
      syncOptionsFromEnvironment({
        CONTEXT_SPACE_RECONCILIATION_HOURS: "0"
      })
    ).toThrow("CONTEXT_SPACE_RECONCILIATION_HOURS must be a positive integer");
  });

  it("uses second-precision single-page message commands and requests only incomplete tasks", async () => {
    const runner = new FakeRunner();
    const adapter = new LarkAdapter(runner);
    const start = new Date("2026-06-20T07:02:23.616Z");
    const end = new Date("2026-06-27T07:02:23.616Z");

    await adapter.fetchSource("mentions", start, end);
    await adapter.fetchSource("mentions", start, end, "next_page");
    await adapter.fetchSource("calendar", start, end);
    await adapter.fetchSource("tasks", start, end);

    const messageCalls = runner.calls.filter(
      ([service, command]) => service === "im" && command === "+messages-search"
    );
    const mentions = messageCalls[0];
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
    expect(mentions).toEqual(
      expect.arrayContaining([
        "--page-size",
        "50",
        "--page-limit",
        "1",
        "--exclude-sender-type",
        "bot",
        "--no-reactions"
      ])
    );
    expect(mentions).not.toContain("--page-all");
    expect(messageCalls[1]).toEqual(
      expect.arrayContaining(["--page-token", "next_page"])
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

  it("continues P2P collection beyond forty pages and keeps page tokens out of logs", async () => {
    const store = await initializeWorkspace(root);
    const index = new ContextIndex();
    await index.rebuild(store);
    const logs = memoryLogger(root);
    const runner = new PaginatedP2PRunner(41);
    const sync = await createTestSync(
      root,
      new LarkAdapter(runner),
      logs.logger
    );

    const status = await sync.sync({
      now: new Date("2026-07-20T12:00:00Z"),
      backfillDays: 1,
      windowDays: 1,
      maxMessagePagesPerWindow: 50
    });

    const p2p = status.results.find((result) => result.source === "p2p");
    expect(p2p).toMatchObject({ ok: true, received: 41, persisted: 41 });
    const p2pCalls = runner.calls.filter((args) => args.includes("p2p"));
    expect(p2pCalls).toHaveLength(41);
    expect(p2pCalls.every((args) => !args.includes("--page-all"))).toBe(true);
    expect(p2pCalls.every((args) => args.includes("--no-reactions"))).toBe(true);
    expect(
      new MachineContextRepository(testDatabases.at(-1)!).listSources({
        kinds: ["p2p"]
      })
    ).toHaveLength(41);
    await logs.logger.flush();
    expect(logs.entries).toContainEqual(
      expect.objectContaining({
        event: "lark.sync.page.completed",
        source: "p2p",
        page_index: 40,
        has_more: false
      })
    );
    expect(JSON.stringify(logs.entries)).not.toContain("page_40");
  });

  it("keeps successful pages and safely replays an interrupted P2P window", async () => {
    const store = await initializeWorkspace(root);
    const index = new ContextIndex();
    await index.rebuild(store);
    const failedSync = await createTestSync(
      root,
      new LarkAdapter(new PaginatedP2PRunner(3, 1))
    );
    const options = {
      now: new Date("2026-07-20T12:00:00Z"),
      backfillDays: 1,
      windowDays: 1,
      maxMessagePagesPerWindow: 10
    };

    const failed = await failedSync.sync(options);
    expect(failed.results.find(({ source }) => source === "p2p")).toMatchObject({
      ok: false,
      received: 1,
      persisted: 1
    });
    expect(
      new MachineContextRepository(testDatabases.at(-1)!).getSource(
        "lark:message:om_p2p_0"
      )
    ).not.toBeNull();
    expect(
      new SyncRepository(testDatabases.at(-1)!).getCursor("p2p")
    ).toBeNull();

    const replayedSync = await createTestSync(
      root,
      new LarkAdapter(new PaginatedP2PRunner(3))
    );
    const replayed = await replayedSync.sync(options);
    expect(replayed.results.find(({ source }) => source === "p2p")).toMatchObject({
      ok: true,
      received: 3,
      persisted: 2
    });
    expect(
      new MachineContextRepository(testDatabases.at(-1)!).listSources({
        kinds: ["p2p"]
      })
    ).toHaveLength(3);
    expect(
      new SyncRepository(testDatabases.at(-1)!).getCursor("p2p")
    ).not.toBeNull();
  });

  it("rejects missing, repeated, and over-limit P2P pagination without advancing checkpoints", async () => {
    const cases: Array<{
      name: string;
      maxPages: number;
      response(page: number): Record<string, unknown>;
      expectedCalls: number;
      error: string;
    }> = [
      {
        name: "missing-token",
        maxPages: 10,
        response: () => ({ has_more: true }),
        expectedCalls: 1,
        error: "未返回有效 page_token"
      },
      {
        name: "repeated-token",
        maxPages: 10,
        response: () => ({ has_more: true, page_token: "same_token" }),
        expectedCalls: 2,
        error: "重复的 page_token"
      },
      {
        name: "page-limit",
        maxPages: 1,
        response: () => ({ has_more: true, page_token: "next_token" }),
        expectedCalls: 1,
        error: "安全上限"
      }
    ];

    for (const testCase of cases) {
      const caseRoot = path.join(root, testCase.name);
      const store = await initializeWorkspace(caseRoot);
      const index = new ContextIndex();
      await index.rebuild(store);
      const base = new FakeRunner();
      let p2pCalls = 0;
      const runner: CommandRunner = {
        async run(args) {
          if (
            args[0] !== "im" ||
            args[1] !== "+messages-search" ||
            !args.includes("p2p")
          ) {
            return base.run(args);
          }
          const page = p2pCalls++;
          return {
            messages: [
              {
                message_id: `om_${testCase.name}_${page}`,
                content: JSON.stringify({ text: testCase.name }),
                create_time: String(1784476800000 + page),
                sender: { id: "ou_alice", name: "Alice" },
                chat_partner: { open_id: "ou_alice", name: "Alice" },
                chat_name: "Alice",
                chat_type: "p2p"
              }
            ],
            ...testCase.response(page)
          };
        }
      };
      const sync = await createTestSync(root, new LarkAdapter(runner));

      const status = await sync.sync({
        now: new Date("2026-07-20T12:00:00Z"),
        backfillDays: 1,
        windowDays: 1,
        maxMessagePagesPerWindow: testCase.maxPages
      });
      const p2p = status.results.find(({ source }) => source === "p2p");
      expect(p2p?.ok, testCase.name).toBe(false);
      expect(p2p?.error, testCase.name).toContain(testCase.error);
      expect(p2p?.persisted, testCase.name).toBe(testCase.expectedCalls);
      expect(p2pCalls, testCase.name).toBe(testCase.expectedCalls);
      expect(
        new SyncRepository(testDatabases.at(-1)!).getCursor("p2p"),
        testCase.name
      ).toBeNull();
    }
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

  it("uses the stable partner id when a P2P result omits the display name", () => {
    const [record] = normalizeMessages(
      {
        messages: [
          {
            message_id: "missing_partner_name",
            content: "{\"text\":\"你好\"}",
            sender: { id: "ou_self", name: "Me" },
            partner: { open_id: "ou_partner" }
          }
        ]
      },
      "p2p"
    );
    expect(record.participants).toEqual([
      { provider_id: "ou_self", name: "Me", role: "sender" },
      {
        provider_id: "ou_partner",
        name: "ou_partner",
        role: "partner"
      }
    ]);
  });

  it("discards bot senders and entire bot P2P conversations", async () => {
    expect(
      normalizeMessages(
        {
          messages: [
            {
              message_id: "bot_mention",
              content: "{\"text\":\"机器人提醒\"}",
              sender: { id: "bot_1", name: "Build Bot", type: "bot" }
            }
          ]
        },
        "mention"
      )
    ).toEqual([]);
    expect(
      normalizeMessages(
        {
          messages: [
            {
              message_id: "to_bot",
              content: "{\"text\":\"用户发给机器人\"}",
              sender: { id: "ou_self", name: "Me", type: "user" },
              chat_partner: {
                open_id: "bot_1",
                name: "Build Bot",
                open_bot_id: "cli_bot_1"
              }
            }
          ]
        },
        "p2p"
      )
    ).toEqual([]);

    const store = await initializeWorkspace(root);
    const index = new ContextIndex();
    await index.rebuild(store);
    const provider = new FakeAnalysisProvider();
    const base = new FakeRunner();
    const runner: CommandRunner = {
      async run(args) {
        if (args[0] !== "im") return base.run(args);
        if (args.includes("p2p")) {
          return {
            messages: [{
              message_id: "bot_p2p",
              content: "{\"text\":\"用户发给机器人\"}",
              create_time: "1784476800000",
              sender: { id: "ou_self", name: "Me", type: "user" },
              chat_partner: { open_id: "bot_1", name: "Build Bot", type: "bot" },
              chat_type: "p2p"
            }]
          };
        }
        return {
          messages: [{
            message_id: "bot_group",
            content: "{\"text\":\"机器人群消息\"}",
            create_time: "1784476800000",
            sender: { id: "bot_1", name: "Build Bot", sender_type: "bot" },
            chat_type: "group"
          }]
        };
      }
    };
    const sync = await createTestSync(root, new LarkAdapter(runner));
    const status = await sync.sync({
      now: new Date("2026-07-20T12:00:00Z"),
      backfillDays: 1,
      windowDays: 1
    });
    expect(status.results.find(({ source }) => source === "mentions")?.received).toBe(0);
    expect(status.results.find(({ source }) => source === "p2p")?.received).toBe(0);
    expect(index.byId("lark:message:bot_group")).toBeUndefined();
    expect(index.byId("lark:message:bot_p2p")).toBeUndefined();
    expect(
      index
        .all()
        .some(({ data }) => data.type === "person" && data.title === "Build Bot")
    ).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps native tasks machine-owned and does not create Todo Markdown", async () => {
    const store = await initializeWorkspace(root);
    const index = new ContextIndex();
    await index.rebuild(store);
    const sync = await createTestSync(
      root,
      new LarkAdapter(new FakeRunner())
    );
    const options = {
      now: new Date("2026-07-20T12:00:00Z"),
      backfillDays: 1,
      windowDays: 1
    };
    await sync.sync(options);
    const machine = new MachineContextRepository(testDatabases.at(-1)!);
    expect(machine.countUpstreamTasks()).toBe(1);
    expect(
      index.all().some(({ data }) => data.type === "todo")
    ).toBe(false);
    await sync.sync(options);
    expect(machine.countUpstreamTasks()).toBe(1);
  });

  it("exposes in-flight synchronization progress", async () => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const base = new FakeRunner();
    const runner: CommandRunner = {
      async run(args) {
        if (args[0] === "contact") {
          entered();
          await blocked;
        }
        return base.run(args);
      }
    };
    const store = await initializeWorkspace(root);
    const index = new ContextIndex();
    await index.rebuild(store);
    const sync = await createTestSync(root, new LarkAdapter(runner));
    const running = sync.sync({
      now: new Date("2026-07-20T12:00:00Z"),
      backfillDays: 1,
      windowDays: 1
    });
    await started;
    expect(sync.getStatus()).toMatchObject({
      running: true,
      progress: {
        phase: "collecting",
        source: "self",
        window_index: 0,
        page_index: 0
      }
    });
    await expect(sync.sync()).rejects.toThrow(
      "A Lark synchronization is already running"
    );
    release();
    const completed = await running;
    expect(completed.progress).toMatchObject({
      phase: "completed",
      message: "同步已完成，分析任务已加入队列"
    });
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

  it("maps a missing lark-cli executable into actionable installation guidance", async () => {
    const runner = new LarkCliCommandRunner(
      path.join(root, "missing-lark-cli")
    );
    const sync = await createTestSync(root, new LarkAdapter(runner));
    const status = await sync.sync({ now: new Date("2026-07-21T00:00:00Z") });

    expect(status.results).toHaveLength(1);
    expect(status.results[0]).toMatchObject({
      source: "self",
      ok: false,
      issue: {
        kind: "installation",
        requires_action: true,
        message: "未检测到 lark-cli 可执行文件。",
        hint: expect.stringContaining("npm install -g @larksuite/cli")
      }
    });
    expect(status.results[0].error).toContain("缺少 lark-cli");
    expect(status.results[0].issue?.hint).toContain("lark-cli auth login");
    expect(status.last_error).toContain("飞书同步需要人工处理");
  });

  it("logs lark-cli command metadata and structured issues without raw output", async () => {
    const successBinary = path.join(root, "lark-cli-success");
    await writeFile(
      successBinary,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ok:true,data:{open_id:'ou_private_value',name:'Private'}}));"
      ].join("\n"),
      { mode: 0o700 }
    );
    await chmod(successBinary, 0o700);
    const successLogs = memoryLogger(root);
    const successRunner = new LarkCliCommandRunner(
      successBinary,
      successLogs.logger
    );
    await successRunner.run(["contact", "+get-user"]);
    await successLogs.logger.flush();
    expect(successLogs.entries).toContainEqual(
      expect.objectContaining({
        event: "lark.cli.completed",
        command: "contact +get-user",
        argument_names: ["--as"],
        output_bytes: expect.any(Number)
      })
    );
    expect(JSON.stringify(successLogs.entries)).not.toContain(
      "ou_private_value"
    );

    const failureBinary = path.join(root, "lark-cli-failure");
    await writeFile(
      failureBinary,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ok:false,error:{type:'authorization',subtype:'missing_scope',code:99991679,message:'missing scope',missing_scopes:['im:message:readonly'],log_id:'log_safe'},raw:'private-response-body'}));"
      ].join("\n"),
      { mode: 0o700 }
    );
    await chmod(failureBinary, 0o700);
    const failureLogs = memoryLogger(root);
    const failureRunner = new LarkCliCommandRunner(
      failureBinary,
      failureLogs.logger
    );
    await expect(
      failureRunner.run(["im", "+messages-search", "--is-at-me"])
    ).rejects.toBeInstanceOf(LarkCliCommandError);
    await failureLogs.logger.flush();
    expect(failureLogs.entries).toContainEqual(
      expect.objectContaining({
        event: "lark.cli.failed",
        command: "im +messages-search",
        issue_kind: "permission",
        issue_code: 99991679,
        log_id: "log_safe",
        requires_action: true
      })
    );
    expect(JSON.stringify(failureLogs.entries)).not.toContain(
      "private-response-body"
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
    const first = await createTestSync(
      root,
      new LarkAdapter(new FakeRunner())
    );
    const clock = new Date("2026-07-20T12:00:00Z");
    const firstStatus = await first.sync({
      now: clock,
      backfillDays: 1,
      windowDays: 1,
      reconciliationHours: 1
    });
    expect(firstStatus.results.every((result) => result.ok)).toBe(true);
    const machine = new MachineContextRepository(testDatabases.at(-1)!);
    const queue = new AnalysisJobRepository(testDatabases.at(-1)!);
    expect(queue.counts().queued).toBe(2);
    const sourceCount = machine.listSources().length;
    const secondStatus = await first.sync({
      now: new Date("2026-07-20T12:05:00Z"),
      backfillDays: 1,
      windowDays: 1,
      reconciliationHours: 1
    });
    expect(machine.listSources()).toHaveLength(sourceCount);
    expect(secondStatus.results.find((result) => result.source === "mentions")?.persisted).toBe(0);
    expect(queue.counts().queued).toBe(2);

    const partial = await createTestSync(
      root,
      new LarkAdapter(new FakeRunner(true))
    );
    const partialStatus = await partial.sync({
      now: new Date("2026-07-20T12:10:00Z"),
      backfillDays: 1,
      windowDays: 1
    });
    expect(partialStatus.results.find((result) => result.source === "calendar")?.ok).toBe(false);
    expect(partialStatus.results.find((result) => result.source === "tasks")?.ok).toBe(true);
    expect(
      new SyncRepository(testDatabases.at(-1)!).getCursor("tasks")
    ).not.toBeNull();
  });

  it("recovers a mention that becomes visible after its creation-time cursor advanced", async () => {
    const store = await initializeWorkspace(root);
    const index = new ContextIndex();
    await index.rebuild(store);
    const runner = new DelayedMentionRunner();
    const sync = await createTestSync(root, new LarkAdapter(runner));
    const options = {
      backfillDays: 1,
      reconciliationHours: 1,
      windowDays: 7
    };

    await sync.sync({
      ...options,
      now: new Date("2026-07-21T03:55:46Z")
    });
    const database = testDatabases.at(-1)!;
    const context = new MachineContextRepository(database);
    const jobs = new AnalysisJobRepository(database);
    expect(
      context.getSource("lark:message:om_delayed_mention")
    ).toBeNull();
    expect(jobs.counts().queued).toBe(0);

    const recovered = await sync.sync({
      ...options,
      now: new Date("2026-07-21T04:30:00Z")
    });
    expect(
      context.getSource("lark:message:om_delayed_mention")?.body
    ).toContain("代理mgr你看看得迁移下了");
    expect(
      recovered.results.find(({ source }) => source === "mentions")
    ).toMatchObject({ ok: true, received: 1, persisted: 1 });
    expect(jobs.counts().queued).toBe(1);

    const mentionCalls = runner.calls.filter((args) =>
      args.includes("--is-at-me")
    );
    expect(mentionCalls[1]).toEqual(
      expect.arrayContaining([
        "--start",
        "2026-07-21T03:30:00Z",
        "--end",
        "2026-07-21T04:30:00Z"
      ])
    );

    const replayed = await sync.sync({
      ...options,
      now: new Date("2026-07-21T04:35:00Z")
    });
    expect(
      replayed.results.find(({ source }) => source === "mentions")
    ).toMatchObject({ ok: true, received: 1, persisted: 0 });
    expect(jobs.counts().queued).toBe(1);
  });

  it("advances source cursors before asynchronous analysis executes", async () => {
    const store = await initializeWorkspace(root);
    const index = new ContextIndex();
    await index.rebuild(store);
    const logs = memoryLogger(root);
    const sync = await createTestSync(
      root,
      new LarkAdapter(new FakeRunner()),
      logs.logger
    );
    const status = await sync.sync({
      now: new Date("2026-07-20T12:00:00Z"),
      backfillDays: 1,
      windowDays: 1
    });

    const mentions = status.results.find((result) => result.source === "mentions");
    expect(mentions?.ok).toBe(true);
    expect(mentions?.persisted).toBeGreaterThan(0);
    expect(
      new SyncRepository(testDatabases.at(-1)!).getCursor("mentions")
    ).not.toBeNull();
    expect(
      new MachineContextRepository(testDatabases.at(-1)!).getSource(
        "lark:message:om_mention"
      )
    ).not.toBeNull();
    expect(
      new AnalysisJobRepository(testDatabases.at(-1)!).counts().queued
    ).toBe(2);
    await logs.logger.flush();
    const syncIds = logs.entries
      .filter(({ event }) =>
        [
          "lark.sync.started",
          "lark.sync.source.completed",
          "lark.sync.completed"
        ].includes(String(event))
      )
      .map(({ sync_id }) => sync_id);
    expect(new Set(syncIds).size).toBe(1);
    expect(
      logs.entries.some(({ event }) => event === "analysis.batch.failed")
    ).toBe(false);
    expect(JSON.stringify(logs.entries)).not.toContain("请你跟进设计");
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
    const logs = memoryLogger(root);
    const sync = await createTestSync(
      root,
      new LarkAdapter(runner),
      logs.logger
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

    expect(
      new SyncRepository(testDatabases.at(-1)!)
        .latestRun()
        ?.results.find((result) => result.issue)?.issue?.kind
    ).toBe("permission");
    await logs.logger.flush();
    expect(logs.entries).toContainEqual(
      expect.objectContaining({
        event: "lark.sync.window.failed",
        source: "calendar",
        issue_kind: "permission",
        requires_action: true
      })
    );
  });
});

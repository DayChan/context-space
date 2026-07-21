import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeegoAdapter } from "../src/adapters/meego/adapter";
import { MeegoConfigService } from "../src/adapters/meego/config";
import {
  MeegleCliError,
  UnsafeMeegleCommandError,
  assertReadOnlyMeegleCommand,
  prepareReadOnlyMeegleArgs,
  type MeegleCommandRunner
} from "../src/adapters/meego/runner";
import { MeegoSyncService } from "../src/adapters/meego/sync";
import { buildMeegoList, parseQTag, parseQTags } from "../src/core/meego";
import {
  MachineContextRepository,
  SettingsRepository,
  openMachineDatabase,
  type MachineDatabase
} from "../src/machine";

const databases: MachineDatabase[] = [];
const roots: string[] = [];

async function testDatabase(): Promise<MachineDatabase> {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-space-meego-"));
  roots.push(root);
  const database = await openMachineDatabase(root);
  databases.push(database);
  return database;
}

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeMeegleRunner implements MeegleCommandRunner {
  calls: string[][] = [];
  queryAttempts = 0;

  constructor(
    private readonly options: { authenticated?: boolean; retryOnce?: boolean } = {}
  ) {}

  async run(args: string[]): Promise<unknown> {
    this.calls.push(args);
    const command = `${args[0]}:${args[1]}`;
    if (command === "auth:status") {
      return { authenticated: this.options.authenticated ?? true };
    }
    if (command === "project:search") {
      return {
        projects: [{
          project_key: "project_1",
          simple_name: "demo",
          name: "Demo Project"
        }]
      };
    }
    if (command === "workitem:meta-types") {
      return {
        list: [{ type_key: "story", api_name: "story", name: "需求", is_disable: 2 }]
      };
    }
    if (command === "workitem:meta-fields") {
      return {
        list: [
          { field_key: "work_item_id" },
          { field_key: "name" },
          { field_key: "tags" },
          { field_key: "finish_status" },
          { field_key: "updated_at" }
        ],
        pagination: { has_more: false }
      };
    }
    if (command === "workitem:query") {
      this.queryAttempts += 1;
      if (this.options.retryOnce && this.queryAttempts === 1) {
        throw new MeegleCliError("rate limit", "RATE_LIMIT", true);
      }
      const sessionIndex = args.indexOf("--session-id");
      if (sessionIndex >= 0) {
        return {
          session_id: "session_1",
          data: {
            "1": [{
              moql_field_list: [
                { key: "work_item_id", value: { long_value: 102 } },
                { key: "name", value: { string_value: "第二个参与项" } },
                {
                  key: "tags",
                  value: { key_label_value_list: [{ label: "Q41030" }] }
                },
                {
                  key: "updated_at",
                  value: { string_value: "2026-07-20T02:00:00Z" }
                },
                { key: "finish_status", value: { bool_value: true } }
              ]
            }]
          },
          list: [{
            count: 51,
            group_infos: [{ group_id: "1" }]
          }]
        };
      }
      return {
        session_id: "session_1",
        data: {
          "1": [{
            moql_field_list: [
              { key: "work_item_id", value: { long_value: 101 } },
              { key: "name", value: { string_value: "第一个参与项" } },
              {
                key: "tags",
                value: {
                  key_label_value_list: [
                    { label: "Q30828" },
                    { label: "普通标签" }
                  ]
                }
              },
              {
                key: "updated_at",
                value: { string_value: "2026-07-20T01:00:00Z" }
              },
              { key: "finish_status", value: { bool_value: false } }
            ]
          }]
        },
        list: [{
          count: 51,
          group_infos: [{ group_id: "1" }]
        }]
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  }
}

describe("Meego Q 标签与列表", () => {
  it("严格解析季度、月和日", () => {
    expect(parseQTag("Q30828")).toMatchObject({
      quarter: 3,
      month: 8,
      day: 28,
      sortKey: 30828
    });
    expect(parseQTag("Q30228")).toBeNull();
    expect(parseQTag("Q41340")).toBeNull();
    expect(parseQTag("q30828")).toBeNull();
    expect(parseQTags(["Q41030", "Q30828"]).map(({ raw }) => raw)).toEqual([
      "Q30828",
      "Q41030"
    ]);
  });

  it("按配置选择 Q 标签时间线或更新时间列表", async () => {
    const database = await testDatabase();
    const context = new MachineContextRepository(database);
    context.upsertSource({
      sourceId: "meegle:p:story:1",
      provider: "meegle",
      kind: "meego",
      title: "有 Q 标签",
      text: "有 Q 标签",
      occurredAt: "2026-07-20T01:00:00Z",
      participants: [],
      metadata: {
        project_key: "p",
        work_item_type: "story",
        work_item_id: "1",
        tags: ["Q30828"],
        updated_at: "2026-07-20T01:00:00Z"
      }
    });
    context.upsertSource({
      sourceId: "meegle:p:story:2",
      provider: "meegle",
      kind: "meego",
      title: "没有 Q 标签",
      text: "没有 Q 标签",
      occurredAt: "2026-07-21T01:00:00Z",
      participants: [],
      metadata: {
        project_key: "p",
        work_item_type: "story",
        work_item_id: "2",
        tags: [],
        updated_at: "2026-07-21T01:00:00Z"
      }
    });
    context.upsertSource({
      sourceId: "meegle:p:story:3",
      provider: "meegle",
      kind: "meego",
      title: "更早的 Q 标签",
      text: "更早的 Q 标签",
      occurredAt: "2026-07-19T01:00:00Z",
      participants: [],
      metadata: {
        project_key: "p",
        work_item_type: "story",
        work_item_id: "3",
        tags: ["Q30717"],
        completed: false,
        updated_at: "2026-07-19T01:00:00Z"
      }
    });
    context.upsertSource({
      sourceId: "meegle:p:story:4",
      provider: "meegle",
      kind: "meego",
      title: "已完成",
      text: "已完成",
      occurredAt: "2026-07-22T01:00:00Z",
      participants: [],
      metadata: {
        project_key: "p",
        work_item_type: "story",
        work_item_id: "4",
        tags: ["Q30717"],
        completed: true,
        updated_at: "2026-07-22T01:00:00Z"
      }
    });
    const sources = context.listSources({ kinds: ["meego"] });
    const qList = buildMeegoList(sources, {
      enabled: true,
      qTagTimelineEnabled: true,
      projectKeys: ["p"]
    });
    expect(qList.items.map(({ id }) => id)).toEqual([
      "meegle:p:story:3",
      "meegle:p:story:1"
    ]);
    expect(qList.groups.map(({ qTag, items }) => ({
      tag: qTag.raw,
      ids: items.map(({ id }) => id)
    }))).toEqual([
      { tag: "Q30717", ids: ["meegle:p:story:3"] },
      { tag: "Q30828", ids: ["meegle:p:story:1"] }
    ]);
    expect(buildMeegoList(sources, {
      enabled: true,
      qTagTimelineEnabled: false,
      projectKeys: ["p"]
    }).items.map(({ id }) => id)).toEqual([
      "meegle:p:story:2",
      "meegle:p:story:1",
      "meegle:p:story:3"
    ]);
  });
});

describe("Meegle 只读执行与同步", () => {
  it("只允许已声明的只读命令", () => {
    expect(prepareReadOnlyMeegleArgs(["workitem", "query"])).toEqual([
      "workitem",
      "query",
      "--format",
      "json"
    ]);
    expect(() => assertReadOnlyMeegleCommand(["workitem", "update"])).toThrow(
      UnsafeMeegleCommandError
    );
  });

  it("构造参与人 MQL、完整翻页并重试一次限流", async () => {
    const runner = new FakeMeegleRunner({ retryOnce: true });
    const adapter = new MeegoAdapter(runner);
    const project = await adapter.resolveProject("project_1");
    const records = await adapter.queryParticipating(project, {
      key: "story",
      apiName: "story",
      name: "需求",
      disabled: false
    });
    expect(records.map(({ sourceId }) => sourceId)).toEqual([
      "meegle:project_1:story:101",
      "meegle:project_1:story:102"
    ]);
    const firstQuery = runner.calls.find(
      (args) => args[0] === "workitem" && args[1] === "query" && args.includes("--mql")
    );
    expect(firstQuery?.join(" ")).toContain(
      "array_contains(all_participate_persons(), current_login_user())"
    );
    expect(firstQuery?.join(" ")).toContain("FROM `demo`.`需求`");
    expect(firstQuery?.join(" ")).not.toContain("LIMIT 50");
    expect(runner.calls.some((args) => args.includes("--session-id"))).toBe(true);
    expect(runner.queryAttempts).toBe(3);
  });

  it("关闭抓取时不调用 CLI，开启后只保存参与项", async () => {
    const database = await testDatabase();
    const settings = new SettingsRepository(database);
    const config = new MeegoConfigService(settings);
    const runner = new FakeMeegleRunner();
    const context = new MachineContextRepository(database);
    const sync = new MeegoSyncService(
      context,
      config,
      new MeegoAdapter(runner)
    );
    expect((await sync.sync()).enabled).toBe(false);
    expect(runner.calls).toHaveLength(0);

    config.update({
      enabled: true,
      qTagTimelineEnabled: true,
      projectKeys: ["project_1", "project_1"]
    });
    const status = await sync.sync();
    expect(status.lastError).toBeNull();
    expect(status.results).toEqual([
      expect.objectContaining({
        projectKey: "project_1",
        workItemType: "story",
        ok: true,
        received: 2,
        persisted: 2
      })
    ]);
    expect(context.listSources({ kinds: ["meego"] })).toHaveLength(2);
    expect(buildMeegoList(context.listSources({ kinds: ["meego"] }), config.get())
      .items.map(({ id }) => id)).toEqual(["meegle:project_1:story:101"]);
  });

  it("按模式跳过停用、特殊和无标签类型，不把兼容性差异报成失败", async () => {
    const calls: string[][] = [];
    const runner: MeegleCommandRunner = {
      async run(args) {
        calls.push(args);
        const command = `${args[0]}:${args[1]}`;
        if (command === "auth:status") return { authenticated: true };
        if (command === "project:search") {
          return {
            projects: [{
              project_key: "project_1",
              simple_name: "demo",
              name: "Demo Project"
            }]
          };
        }
        if (command === "workitem:meta-types") {
          return {
            list: [
              { type_key: "sprint", api_name: "sprint", name: "迭代", is_disable: 1 },
              { type_key: "chart", api_name: "chart", name: "图表", is_disable: 2 },
              { type_key: "sub_task", api_name: "sub_task", name: "任务", is_disable: 2 },
              {
                type_key: "custom_type_id",
                api_name: "approve",
                name: "变更管理",
                is_disable: 2
              }
            ]
          };
        }
        if (command === "workitem:meta-fields") {
          const type = args[args.indexOf("--work-item-type") + 1];
          const fieldKeys = type === "chart"
            ? ["work_item_type_key", "auto_number"]
            : ["work_item_id", "name", "updated_at"];
          return {
            list: fieldKeys.map((field_key) => ({ field_key })),
            pagination: { has_more: false }
          };
        }
        if (command === "workitem:query") {
          return { session_id: "session", data: {}, list: [] };
        }
        throw new Error(`Unexpected command: ${command}`);
      }
    };
    const database = await testDatabase();
    const config = new MeegoConfigService(new SettingsRepository(database));
    const sync = new MeegoSyncService(
      new MachineContextRepository(database),
      config,
      new MeegoAdapter(runner)
    );

    config.update({
      enabled: true,
      qTagTimelineEnabled: true,
      projectKeys: ["project_1"]
    });
    const qStatus = await sync.sync();
    expect(qStatus.lastError).toBeNull();
    expect(qStatus.results).toHaveLength(4);
    expect(qStatus.results.every((result) => result.ok && result.skipped)).toBe(true);
    expect(calls.filter((args) => args[1] === "query")).toHaveLength(0);

    calls.length = 0;
    config.update({
      enabled: true,
      qTagTimelineEnabled: false,
      projectKeys: ["project_1"]
    });
    const updatedStatus = await sync.sync();
    expect(updatedStatus.lastError).toBeNull();
    expect(updatedStatus.results.filter((result) => result.skipped)).toHaveLength(2);
    const queries = calls
      .filter((args) => args[1] === "query")
      .map((args) => args[args.indexOf("--mql") + 1]);
    expect(queries).toHaveLength(2);
    expect(queries).toEqual(expect.arrayContaining([
      expect.stringContaining("FROM `demo`.`任务`"),
      expect.stringContaining("FROM `demo`.`变更管理`")
    ]));
    expect(queries.every((mql) => !mql.includes("`tags`"))).toBe(true);
  });
});

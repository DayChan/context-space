import type { NormalizedSourceRecord } from "../../core/types";
import { MeegleCliError, type MeegleCommandRunner } from "./runner";

type JsonRecord = Record<string, unknown>;

export interface MeegoProject {
  projectKey: string;
  simpleName: string;
  name: string;
}

export interface MeegoWorkItemType {
  key: string;
  apiName: string;
  name: string;
  disabled: boolean;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && Boolean(value.trim())
  )?.trim();
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function unwrapFieldValue(value: unknown): unknown {
  const wrapped = record(value);
  for (const key of [
    "string_value",
    "long_value",
    "double_value",
    "bool_value",
    "key_label_value_list",
    "key_label_value",
    "string_value_list",
    "long_value_list"
  ]) {
    if (key in wrapped) return wrapped[key];
  }
  return value;
}

function timestamp(value: unknown): string | null {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    const numeric = Number(value);
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fieldMap(item: JsonRecord): JsonRecord {
  const output: JsonRecord = { ...item };
  for (const field of [
    ...array(item.fields),
    ...array(item.work_item_fields),
    ...array(item.field_values),
    ...array(item.moql_field_list)
  ]) {
    const entry = record(field);
    const key = text(entry.field_key, entry.key, entry.name, entry.field_name);
    if (!key) continue;
    output[key] = unwrapFieldValue(
      entry.field_value ?? entry.value ?? entry.fieldValue
    );
  }
  return output;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  const nested = record(value);
  return text(nested.label, nested.name, nested.value, nested.id);
}

function tags(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return tags(JSON.parse(value));
    } catch {
      return value ? [value] : [];
    }
  }
  return array(value).flatMap((entry) => {
    const value = scalar(entry);
    return value ? [value] : [];
  });
}

function walk(value: unknown, visit: (entry: JsonRecord) => void): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => walk(entry, visit));
    return;
  }
  const entry = record(value);
  if (!Object.keys(entry).length) return;
  visit(entry);
  Object.values(entry).forEach((child) => walk(child, visit));
}

function workItems(payload: unknown): JsonRecord[] {
  const found = new Map<string, JsonRecord>();
  walk(payload, (candidate) => {
    const fields = fieldMap(candidate);
    const id = scalar(
      fields.work_item_id ?? fields.workItemId ?? fields.work_item_id_value
    );
    const name = scalar(fields.name ?? fields.title ?? fields.work_item_name);
    if (id && name) found.set(id, fields);
  });
  return [...found.values()];
}

interface PaginationGroup {
  groupId: string;
  hasMore: boolean;
  total: number | null;
}

function paginationGroups(payload: unknown): PaginationGroup[] {
  const groups = new Map<string, PaginationGroup>();
  const root = record(payload);
  const data = record(root.data);
  for (const value of list(payload, "list")) {
    const entry = record(value);
    const totalValue = entry.count ?? entry.total ?? entry.total_count;
    const total = typeof totalValue === "number" ? totalValue : null;
    for (const info of array(entry.group_infos)) {
      const group = record(info);
      const groupId = text(group.group_id, group.groupId);
      if (!groupId) continue;
      const currentCount = array(data[groupId]).length;
      groups.set(groupId, {
        groupId,
        hasMore:
          group.has_more === true ||
          group.hasMore === true ||
          (total !== null && total > currentCount),
        total
      });
    }
  }
  walk(payload, (candidate) => {
    const groupId = text(candidate.group_id, candidate.groupId);
    if (!groupId) return;
    const totalValue = candidate.total ?? candidate.count ?? candidate.total_count;
    const total = typeof totalValue === "number" ? totalValue : null;
    if (groups.has(groupId)) return;
    groups.set(groupId, {
      groupId,
      hasMore: candidate.has_more === true || candidate.hasMore === true,
      total
    });
  });
  return [...groups.values()];
}

function sessionId(payload: unknown): string | undefined {
  let found: string | undefined;
  walk(payload, (candidate) => {
    found ??= text(candidate.session_id, candidate.sessionId);
  });
  return found;
}

function list(payload: unknown, key: string): unknown[] {
  const root = record(payload);
  const data = record(root.data);
  return array(root[key]).length ? array(root[key]) : array(data[key]);
}

function quoteIdentifier(value: string): string {
  if (!value || /[`\r\n\\]/.test(value)) {
    throw new Error(`Meego 标识符包含不受支持的字符: ${value}`);
  }
  return `\`${value}\``;
}

export class MeegoAdapter {
  private host = "project.feishu.cn";

  constructor(private readonly runner: MeegleCommandRunner) {}

  private async run(args: string[]): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.runner.run(args);
      } catch (error) {
        if (!(error instanceof MeegleCliError) || !error.retryable || attempt >= 2) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }

  async assertAuthenticated(): Promise<void> {
    const payload = record(await this.run(["auth", "status"]));
    if (payload.authenticated !== true) {
      throw new Error(
        `Meegle 认证不可用${text(payload.reason) ? `：${text(payload.reason)}` : ""}`
      );
    }
    const host = text(payload.host);
    if (host && /^[A-Za-z0-9.-]+$/.test(host)) this.host = host;
  }

  async resolveProject(projectKey: string): Promise<MeegoProject> {
    const payload = await this.run([
      "project",
      "search",
      "--project-key",
      projectKey,
      "--page-num",
      "1"
    ]);
    const project = record(list(payload, "projects")[0]);
    const resolvedKey = text(project.project_key, project.projectKey);
    if (!resolvedKey) throw new Error(`Meego 项目不存在或不可访问: ${projectKey}`);
    return {
      projectKey: resolvedKey,
      simpleName: text(project.simple_name, project.simpleName) ?? resolvedKey,
      name: text(project.name) ?? resolvedKey
    };
  }

  async listTypes(projectKey: string): Promise<MeegoWorkItemType[]> {
    const payload = await this.run([
      "workitem",
      "meta-types",
      "--project-key",
      projectKey
    ]);
    return list(payload, "list").flatMap((value) => {
      const entry = record(value);
      const key = text(entry.type_key, entry.api_name);
      const apiName = text(entry.api_name, entry.type_key);
      return key && apiName
        ? [{
            key,
            apiName,
            name: text(entry.name) ?? apiName,
            disabled: entry.is_disable === 1
          }]
        : [];
    });
  }

  async listFieldKeys(projectKey: string, typeKey: string): Promise<Set<string>> {
    const keys = new Set<string>();
    for (let page = 1; page <= 100; page += 1) {
      const payload = await this.run([
        "workitem",
        "meta-fields",
        "--project-key",
        projectKey,
        "--work-item-type",
        typeKey,
        "--page-num",
        String(page)
      ]);
      const fields = list(payload, "list");
      fields.forEach((value) => {
        const key = text(record(value).field_key);
        if (key) keys.add(key);
      });
      const pagination = record(record(payload).pagination);
      if (pagination.has_more !== true) break;
    }
    return keys;
  }

  async queryParticipating(
    project: MeegoProject,
    type: MeegoWorkItemType,
    options: { includeTags: boolean; completionField?: string | null } = {
      includeTags: true
    }
  ): Promise<NormalizedSourceRecord[]> {
    const projectIdentifier = quoteIdentifier(project.simpleName);
    const typeIdentifier = quoteIdentifier(type.name);
    const selectedFields = ["`work_item_id`", "`name`"];
    if (options.includeTags) selectedFields.push("`tags`");
    if (options.completionField) {
      selectedFields.push(quoteIdentifier(options.completionField));
    }
    selectedFields.push("`updated_at`");
    const mql =
      `SELECT ${selectedFields.join(", ")} ` +
      `FROM ${projectIdentifier}.${typeIdentifier} ` +
      "WHERE array_contains(all_participate_persons(), current_login_user()) " +
      "ORDER BY `updated_at` DESC";
    const first = await this.run([
      "workitem",
      "query",
      "--project-key",
      project.projectKey,
      "--mql",
      mql
    ]);
    const pages: unknown[] = [first];
    const session = sessionId(first);
    if (session) {
      for (const group of paginationGroups(first)) {
        let page = 2;
        let hasMore = group.hasMore || (group.total !== null && group.total > 50);
        while (hasMore && page <= 200) {
          const payload = await this.run([
            "workitem",
            "query",
            "--project-key",
            project.projectKey,
            "--session-id",
            session,
            "--mql",
            "",
            "--group-pagination-list",
            JSON.stringify([{ group_id: group.groupId, page_num: page }])
          ]);
          pages.push(payload);
          const next = paginationGroups(payload).find(
            ({ groupId }) => groupId === group.groupId
          );
          const count = workItems(payload).length;
          hasMore = next
            ? next.hasMore && (next.total === null || page * 50 < next.total)
            : count === 50;
          page += 1;
        }
        if (hasMore) throw new Error("Meego MQL 分页超过 200 页安全上限");
      }
    }

    const items = new Map<string, JsonRecord>();
    pages.flatMap(workItems).forEach((item) => {
      const id = scalar(item.work_item_id ?? item.workItemId);
      if (id) items.set(id, item);
    });
    return [...items.entries()].flatMap(([workItemId, item]) => {
      const title = scalar(item.name ?? item.title);
      const updatedAt = timestamp(item.updated_at ?? item.updatedAt);
      if (!title || !updatedAt) return [];
      const itemTags = tags(item.tags);
      const completionValue = options.completionField
        ? item[options.completionField]
        : undefined;
      const completed = options.completionField === "finish_time"
        ? completionValue !== null && completionValue !== undefined && completionValue !== ""
        : completionValue === true || completionValue === 1 || completionValue === "true";
      const sourceId = `meegle:${project.projectKey}:${type.key}:${workItemId}`;
      return [{
        sourceId,
        provider: "meegle" as const,
        kind: "meego" as const,
        title,
        text: title,
        occurredAt: updatedAt,
        participants: [],
        metadata: {
          project_key: project.projectKey,
          project_name: project.name,
          project_simple_name: project.simpleName,
          work_item_type: type.key,
          work_item_type_api_name: type.apiName,
          work_item_type_name: type.name,
          work_item_id: workItemId,
          tags: itemTags,
          completed,
          completion_field: options.completionField ?? null,
          updated_at: updatedAt,
          url: `https://${this.host}/${project.simpleName}/${type.apiName}/detail/${workItemId}`
        }
      }];
    });
  }
}

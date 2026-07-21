import type {
  MeegoConfig,
  MeegoGroup,
  MeegoItem,
  MeegoList,
  ParsedQTag
} from "./types";
import type { StoredSource } from "../machine/context-repository";

const Q_TAG_PATTERN = /^Q([1-4])(\d{2})(\d{2})$/;

function stringValue(
  metadata: Record<string, unknown>,
  key: string,
  fallback = ""
): string {
  const value = metadata[key];
  return typeof value === "string" && value ? value : fallback;
}

function stringArray(
  metadata: Record<string, unknown>,
  key: string
): string[] {
  const value = metadata[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function booleanValue(metadata: Record<string, unknown>, key: string): boolean {
  const value = metadata[key];
  return value === true || value === 1 || value === "true" || value === "1";
}

export function parseQTag(value: string): ParsedQTag | null {
  const match = Q_TAG_PATTERN.exec(value);
  if (!match) return null;
  const quarter = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const expectedQuarter = Math.floor((month - 1) / 3) + 1;
  const date = new Date(Date.UTC(2000, month - 1, day));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    expectedQuarter !== quarter
  ) {
    return null;
  }
  return {
    raw: value,
    quarter,
    month,
    day,
    sortKey: quarter * 10_000 + month * 100 + day
  };
}

export function parseQTags(tags: string[]): ParsedQTag[] {
  return tags
    .flatMap((tag) => {
      const parsed = parseQTag(tag);
      return parsed ? [parsed] : [];
    })
    .sort((left, right) => left.sortKey - right.sortKey || left.raw.localeCompare(right.raw));
}

export function meegoItemFromSource(source: StoredSource): MeegoItem | null {
  if (source.provider !== "meegle" || source.kind !== "meego") return null;
  const tags = stringArray(source.metadata, "tags");
  const qTags = parseQTags(tags);
  return {
    id: source.id,
    title: source.title,
    projectKey: stringValue(source.metadata, "project_key"),
    projectName: stringValue(
      source.metadata,
      "project_name",
      stringValue(source.metadata, "project_key")
    ),
    workItemType: stringValue(source.metadata, "work_item_type"),
    workItemTypeName: stringValue(
      source.metadata,
      "work_item_type_name",
      stringValue(source.metadata, "work_item_type")
    ),
    workItemId: stringValue(source.metadata, "work_item_id"),
    updatedAt: stringValue(source.metadata, "updated_at", source.occurredAt),
    tags,
    qTags,
    primaryQTag: qTags.at(-1) ?? null,
    completed: booleanValue(source.metadata, "completed"),
    url: stringValue(source.metadata, "url") || null
  };
}

export function buildMeegoList(
  sources: StoredSource[],
  config: MeegoConfig
): MeegoList {
  const allItems = sources.flatMap((source) => {
    const item = meegoItemFromSource(source);
    return item && !item.completed ? [item] : [];
  });
  if (!config.qTagTimelineEnabled) {
    const items = allItems.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
    );
    return { mode: "updated_at", items, groups: [] };
  }

  const items = allItems
    .filter((item) => item.primaryQTag)
    .sort(
      (left, right) =>
        left.primaryQTag!.sortKey - right.primaryQTag!.sortKey ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id)
    );
  const byTag = new Map<string, MeegoGroup>();
  for (const item of items) {
    const qTag = item.primaryQTag!;
    const group = byTag.get(qTag.raw);
    if (group) group.items.push(item);
    else byTag.set(qTag.raw, { qTag, items: [item] });
  }
  const groups = [...byTag.values()].sort(
    (left, right) =>
      left.qTag.sortKey - right.qTag.sortKey ||
      left.qTag.raw.localeCompare(right.qTag.raw)
  );
  return { mode: "q_tag_time", items, groups };
}

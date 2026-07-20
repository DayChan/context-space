import { createHash } from "node:crypto";
import type {
  NormalizedSourceRecord,
  TodoMetadata
} from "./types";
import { personIdForIdentity } from "./people";
import { createTodoMetadata } from "./todo";

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function stakeholders(record: NormalizedSourceRecord): string[] {
  return record.participants
    .filter((participant) => participant.role === "sender" || participant.role === "partner")
    .map((participant) => personIdForIdentity(record.provider, participant.provider_id));
}

export interface AnalysisResult {
  todo?: TodoMetadata;
}

export function mapNativeTask(record: NormalizedSourceRecord): AnalysisResult {
  if (record.kind !== "task") return {};
  return {
    todo: createTodoMetadata({
      id: stableId("todo", record.sourceId),
      title: record.title,
      status: record.metadata.completed ? "done" : "open",
      direction: "owed_by_me",
      stakeholders: stakeholders(record),
      due_at: typeof record.metadata.due_at === "string" ? record.metadata.due_at : null,
      explicit: true,
      upstream: "lark_task",
      managed: "hybrid",
      source_refs: [record.sourceId],
      confidence: 1
    })
  };
}

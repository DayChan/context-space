import { createHash } from "node:crypto";
import type {
  KnowledgeMetadata,
  NormalizedSourceRecord,
  TodoMetadata
} from "./types";
import { personIdForIdentity } from "./people";
import { createTodoMetadata } from "./todo";
import { nowIso } from "./types";

const ACTION_PATTERN =
  /(?:请|麻烦|需要你|记得|跟进|处理|完成|todo|action item|please|could you|need you to|follow up)/i;
const STRONG_ACTION_PATTERN = /(?:请你|麻烦你|需要你|action item|please\s+(?:do|send|prepare)|could you)/i;
const DECISION_PATTERN = /(?:决定|结论|最终方案|方案确定|decision|decided|we will)/i;

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function conciseTitle(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 72) : fallback;
}

function stakeholders(record: NormalizedSourceRecord): string[] {
  return record.participants
    .filter((participant) => participant.role === "sender" || participant.role === "partner")
    .map((participant) => personIdForIdentity(record.provider, participant.provider_id));
}

export interface AnalysisResult {
  todo?: TodoMetadata;
  knowledge?: KnowledgeMetadata;
}

export function analyzeSource(record: NormalizedSourceRecord, threshold = 0.85): AnalysisResult {
  const result: AnalysisResult = {};
  if (record.kind === "task") {
    result.todo = createTodoMetadata({
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
    });
  } else if (["mention", "p2p"].includes(record.kind) && ACTION_PATTERN.test(record.text)) {
    const confidence = STRONG_ACTION_PATTERN.test(record.text) ? 0.9 : 0.68;
    result.todo = createTodoMetadata({
      id: stableId("todo", record.sourceId),
      title: conciseTitle(record.text, record.title),
      type: confidence >= threshold ? "todo" : "candidate",
      status: confidence >= threshold ? "open" : "candidate",
      direction: "owed_by_me",
      stakeholders: stakeholders(record),
      explicit: confidence >= threshold,
      upstream: "extracted_context",
      managed: "hybrid",
      source_refs: [record.sourceId],
      confidence
    });
  }

  if (["mention", "p2p"].includes(record.kind) && DECISION_PATTERN.test(record.text)) {
    const timestamp = nowIso();
    result.knowledge = {
      schema: "work-context/knowledge@1",
      id: stableId("knowledge", record.sourceId),
      type: "candidate",
      title: conciseTitle(record.text, "Decision candidate"),
      managed: "generated",
      created_at: timestamp,
      updated_at: timestamp,
      source_refs: [record.sourceId],
      confidence: 0.72,
      status: "draft",
      knowledge_kind: "decision",
      curation_state: "draft",
      superseded_by: null,
      tags: ["decision"]
    };
  }
  return result;
}

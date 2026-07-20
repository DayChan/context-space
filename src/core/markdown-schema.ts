import { z } from "zod";
import type {
  BaseMetadata,
  KnowledgeMetadata,
  PersonMetadata,
  TodoMetadata
} from "./types";

export class UnknownMarkdownSchemaError extends Error {
  constructor(readonly schemaId: string) {
    super(`当前应用不支持 Markdown Schema：${schemaId}`);
    this.name = "UnknownMarkdownSchemaError";
  }
}

const common = {
  schema: z.string(),
  id: z.string().min(1),
  title: z.string().min(1),
  managed: z.enum(["manual", "hybrid"]),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  source_refs: z.array(z.string()),
  confidence: z.number().min(0).max(1).optional(),
  status: z.string().optional(),
  candidate_id: z.string().min(1).optional(),
  accepted_at: z.string().min(1).optional()
};

const todoSchema = z
  .object({
    ...common,
    schema: z.literal("work-context/todo@1"),
    type: z.literal("todo"),
    status: z.enum(["open", "in_progress", "waiting", "done", "dismissed"]),
    direction: z.enum(["owed_by_me", "waiting_on_them", "shared"]),
    owner: z.string(),
    stakeholders: z.array(z.string()),
    due_at: z.string().nullable(),
    explicit: z.boolean(),
    upstream: z.enum(["lark_task", "extracted_context", "manual"]),
    priority: z.object({
      base: z.number(),
      manual: z.number().nullable(),
      effective: z.number(),
      reasons: z.array(
        z.object({
          key: z.enum([
            "due-overdue",
            "due-soon",
            "explicit",
            "stale",
            "leader",
            "leader-follow-up"
          ]),
          label: z.string(),
          value: z.number()
        })
      )
    }),
    automation: z.object({
      mode: z.enum(["disabled", "suggest", "approved"]),
      handler: z.string().nullable(),
      requires_confirmation: z.boolean(),
      allowed_capabilities: z.array(z.string()),
      blocked_reason: z.string().optional()
    })
  })
  .passthrough();

const observationSchema = z
  .object({
    text: z.string(),
    evidence: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    observed_at: z.string(),
    origin: z.enum(["manual", "inferred"]),
    category: z
      .enum([
        "responsibility",
        "communication_style",
        "collaboration_style",
        "work_preference"
      ])
      .optional(),
    source_refs: z.array(z.string()).optional(),
    insight_key: z.string().optional(),
    stale: z.boolean().optional(),
    superseded_at: z.string().optional()
  })
  .passthrough();

const personSchema = z
  .object({
    ...common,
    schema: z.literal("work-context/person@1"),
    type: z.literal("person"),
    related_person_id: z.string().optional(),
    identities: z.array(
      z.object({
        provider: z.string(),
        external_id: z.string(),
        display_name: z.string().optional()
      })
    ),
    role: z.string().nullable(),
    role_origin: z.enum(["directory", "manual", "inferred"]).nullable(),
    is_leader: z.boolean(),
    leader_boost: z.number(),
    observations: z.array(observationSchema),
    last_interaction_at: z.string().nullable()
  })
  .passthrough();

const knowledgeSchema = z
  .object({
    ...common,
    schema: z.literal("work-context/knowledge@1"),
    type: z.literal("knowledge"),
    knowledge_kind: z.enum([
      "project",
      "decision",
      "playbook",
      "concept",
      "glossary",
      "draft"
    ]),
    curation_state: z.enum(["draft", "curated", "stale", "superseded"]),
    superseded_by: z.string().nullable(),
    tags: z.array(z.string())
  })
  .passthrough();

export class MarkdownSchemaRegistry {
  parse(value: Record<string, unknown>): TodoMetadata | PersonMetadata | KnowledgeMetadata {
    const schemaId = typeof value.schema === "string" ? value.schema : "";
    if (schemaId === "work-context/todo@1") {
      return todoSchema.parse(value) as TodoMetadata;
    }
    if (schemaId === "work-context/person@1") {
      return personSchema.parse(value) as PersonMetadata;
    }
    if (schemaId === "work-context/knowledge@1") {
      return knowledgeSchema.parse(value) as KnowledgeMetadata;
    }
    throw new UnknownMarkdownSchemaError(schemaId || "(missing)");
  }

  supports(schemaId: string): boolean {
    return [
      "work-context/todo@1",
      "work-context/person@1",
      "work-context/knowledge@1"
    ].includes(schemaId);
  }
}

export function isHumanMarkdownMetadata(
  value: BaseMetadata
): value is TodoMetadata | PersonMetadata | KnowledgeMetadata {
  return (
    value.type === "todo" ||
    value.type === "person" ||
    value.type === "knowledge"
  );
}

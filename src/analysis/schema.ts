import { z } from "zod";

export const ANALYSIS_SCHEMA_VERSION = "work-context/analysis@1" as const;

const sharedItemFields = {
  title: z.string().trim().min(1).max(160),
  source_ref: z.string().trim().min(1).max(300),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  reason: z.string().trim().min(1).max(500)
};

export const analysisTodoItemSchema = z
  .object({
    kind: z.literal("todo"),
    ...sharedItemFields,
    status: z.enum(["candidate", "open"]),
    direction: z.enum(["owed_by_me", "waiting_on_them", "shared"]),
    due_at: z.string().datetime({ offset: true }).nullable(),
    explicit: z.boolean(),
    stakeholders: z.array(z.string().trim().min(1).max(200)).max(20)
  })
  .strict();

export const analysisKnowledgeItemSchema = z
  .object({
    kind: z.literal("knowledge"),
    ...sharedItemFields,
    knowledge_kind: z.enum([
      "project",
      "decision",
      "playbook",
      "concept",
      "glossary",
      "draft"
    ]),
    summary: z.string().trim().min(1).max(1200),
    tags: z.array(z.string().trim().min(1).max(60)).max(12)
  })
  .strict();

export const analysisItemSchema = z.discriminatedUnion("kind", [
  analysisTodoItemSchema,
  analysisKnowledgeItemSchema
]);

export const analysisOutputSchema = z
  .object({
    schema_version: z.literal(ANALYSIS_SCHEMA_VERSION),
    items: z.array(analysisItemSchema).max(24)
  })
  .strict();

export type AnalysisTodoItem = z.infer<typeof analysisTodoItemSchema>;
export type AnalysisKnowledgeItem = z.infer<typeof analysisKnowledgeItemSchema>;
export type AnalysisItem = z.infer<typeof analysisItemSchema>;
export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;

function toCodexCompatibleJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCodexCompatibleJsonSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
      if (key === "$schema") return [];
      return [
        [
          key === "oneOf" ? "anyOf" : key,
          toCodexCompatibleJsonSchema(nested)
        ]
      ];
    })
  );
}

export const analysisJsonSchema = toCodexCompatibleJsonSchema(
  z.toJSONSchema(analysisOutputSchema)
);

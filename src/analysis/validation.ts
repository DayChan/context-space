import { createHash } from "node:crypto";
import type { NormalizedSourceRecord } from "../core/types";
import type { BuiltAnalysisPrompt } from "./prompt";
import {
  analysisOutputSchema,
  type AnalysisItem,
  type AnalysisOutput
} from "./schema";

export class AnalysisValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`分析结果校验失败：${issues.join("；")}`);
    this.name = "AnalysisValidationError";
  }
}

export function parseAndValidateAnalysis(
  raw: string,
  record: NormalizedSourceRecord,
  prompt: BuiltAnalysisPrompt
): AnalysisOutput {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new AnalysisValidationError(["Provider 最终响应不是有效 JSON"]);
  }
  const parsed = analysisOutputSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AnalysisValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    );
  }

  const issues: string[] = [];
  parsed.data.items.forEach((item, index) => {
    if (item.source_ref !== record.sourceId) {
      issues.push(`items.${index}.source_ref 与当前来源不一致`);
    }
    for (const evidence of item.evidence) {
      if (!record.text.includes(evidence)) {
        issues.push(`items.${index}.evidence 无法在来源正文中定位`);
      }
    }
    if (item.kind === "todo") {
      for (const stakeholder of item.stakeholders) {
        if (!prompt.participantIds.includes(stakeholder)) {
          issues.push(`items.${index}.stakeholders 包含未知参与者`);
        }
      }
    }
  });
  if (issues.length) throw new AnalysisValidationError(issues);
  return parsed.data;
}

function normalizedEvidence(item: AnalysisItem): string {
  return [...new Set(item.evidence.map((value) => value.trim().replace(/\s+/g, " ")))]
    .sort()
    .join("\n");
}

export function analysisItemKey(item: AnalysisItem): string {
  const fingerprint = [item.source_ref, item.kind, normalizedEvidence(item)].join("\u0000");
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
}

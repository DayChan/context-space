import { createHash } from "node:crypto";
import { safeObservations } from "../core/people";
import type { NormalizedSourceRecord, PersonObservation } from "../core/types";
import type { BuiltAnalysisPrompt } from "./prompt";
import {
  analysisOutputSchema,
  type AnalysisEvidence,
  type AnalysisItem,
  type AnalysisOutput,
  type AnalysisPersonInsight
} from "./schema";

export class AnalysisValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`分析结果校验失败：${issues.join("；")}`);
    this.name = "AnalysisValidationError";
  }
}

function validateEvidence(
  evidence: AnalysisEvidence[],
  prompt: BuiltAnalysisPrompt,
  path: string,
  issues: string[]
): void {
  evidence.forEach((entry, index) => {
    const sourceText = prompt.sourceTexts[entry.source_ref];
    if (sourceText === undefined) {
      issues.push(`${path}.${index}.source_ref 不属于当前批次`);
    } else if (!sourceText.includes(entry.quote)) {
      issues.push(`${path}.${index}.quote 无法在对应来源正文中定位`);
    }
  });
}

export function parseAndValidateAnalysis(
  raw: string,
  input: NormalizedSourceRecord | NormalizedSourceRecord[],
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
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`
      )
    );
  }

  const records = Array.isArray(input) ? input : [input];
  const sourceIds = new Set(records.map(({ sourceId }) => sourceId));
  const issues: string[] = [];
  parsed.data.items.forEach((item, index) => {
    const uniqueSourceRefs = new Set(item.source_refs);
    if (uniqueSourceRefs.size !== item.source_refs.length) {
      issues.push(`items.${index}.source_refs 包含重复来源`);
    }
    for (const sourceRef of item.source_refs) {
      if (!sourceIds.has(sourceRef)) {
        issues.push(`items.${index}.source_refs 包含批次外来源`);
      }
    }
    validateEvidence(item.evidence, prompt, `items.${index}.evidence`, issues);
    const evidenceRefs = new Set(item.evidence.map(({ source_ref }) => source_ref));
    for (const sourceRef of item.source_refs) {
      if (!evidenceRefs.has(sourceRef)) {
        issues.push(`items.${index}.source_refs 存在没有证据的来源`);
      }
    }
    for (const sourceRef of evidenceRefs) {
      if (!uniqueSourceRefs.has(sourceRef)) {
        issues.push(`items.${index}.evidence 引用了未声明的来源`);
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

  parsed.data.person_insights.forEach((insight, index) => {
    if (
      !prompt.participantIds.includes(insight.person_id) ||
      insight.person_id === prompt.currentUserId
    ) {
      issues.push(`person_insights.${index}.person_id 不是可分析参与者`);
    }
    validateEvidence(
      insight.evidence,
      prompt,
      `person_insights.${index}.evidence`,
      issues
    );
    const evidenceSourceRefs = [
      ...new Set(insight.evidence.map(({ source_ref }) => source_ref))
    ];
    const declaredSourceRefs = new Set(insight.source_refs);
    if (declaredSourceRefs.size !== insight.source_refs.length) {
      issues.push(`person_insights.${index}.source_refs 包含重复来源`);
    }
    for (const sourceRef of insight.source_refs) {
      if (!sourceIds.has(sourceRef)) {
        issues.push(`person_insights.${index}.source_refs 包含批次外来源`);
      }
      if (!evidenceSourceRefs.includes(sourceRef)) {
        issues.push(`person_insights.${index}.source_refs 存在没有证据的来源`);
      }
    }
    for (const sourceRef of evidenceSourceRefs) {
      if (!declaredSourceRefs.has(sourceRef)) {
        issues.push(`person_insights.${index}.evidence 引用了未声明的来源`);
      }
    }
    if (
      insight.category !== "responsibility" &&
      evidenceSourceRefs.length < 2
    ) {
      issues.push(`person_insights.${index} 的职场方式观察至少需要两个来源`);
    }
    if (
      !evidenceSourceRefs.some((sourceRef) =>
        prompt.participantIdsBySource[sourceRef]?.includes(insight.person_id)
      )
    ) {
      issues.push(`person_insights.${index}.person_id 未出现在证据来源参与者中`);
    }
    const candidate: PersonObservation = {
      text: insight.text,
      evidence: insight.evidence.map(({ quote }) => quote),
      confidence: insight.confidence,
      observed_at: new Date(0).toISOString(),
      origin: "inferred",
      category: insight.category,
      source_refs: evidenceSourceRefs
    };
    if (!safeObservations([candidate]).length) {
      issues.push(`person_insights.${index} 包含禁止的人物敏感推断`);
    }
  });

  if (issues.length) throw new AnalysisValidationError(issues);
  return parsed.data;
}

function normalizedEvidence(evidence: AnalysisEvidence[]): string {
  return [
    ...new Set(
      evidence.map(
        ({ source_ref, quote }) =>
          `${source_ref}\u0000${quote.trim().replace(/\s+/g, " ")}`
      )
    )
  ]
    .sort()
    .join("\n");
}

export function analysisItemKey(item: AnalysisItem): string {
  const fingerprint = [
    [...new Set(item.source_refs)].sort().join("\n"),
    item.kind,
    normalizedEvidence(item.evidence)
  ].join("\u0000");
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
}

export function personInsightKey(insight: AnalysisPersonInsight): string {
  const fingerprint = [
    insight.person_id,
    insight.category,
    [...new Set(insight.source_refs)].sort().join("\n"),
    normalizedEvidence(insight.evidence)
  ].join("\u0000");
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
}

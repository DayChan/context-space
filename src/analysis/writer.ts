import { createHash } from "node:crypto";
import { ContextIndex } from "../core/index";
import { MarkdownStore } from "../core/markdown-store";
import { mapNativeTask } from "../core/analyzer";
import { discoverPeople, safeObservations } from "../core/people";
import {
  nowIso,
  type AnalysisProvenance,
  type BaseMetadata,
  type KnowledgeMetadata,
  type NormalizedSourceRecord,
  type PersonMetadata,
  type PersonObservation,
  type TodoMetadata,
  type WorkspaceDocument
} from "../core/types";
import { createTodoMetadata } from "../core/todo";
import type { AnalysisRunMetadata } from "./contracts";
import type {
  AnalysisItem,
  AnalysisOutput,
  AnalysisPersonInsight
} from "./schema";
import { analysisItemKey, personInsightKey } from "./validation";

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 140);
}

function derivedId(kind: AnalysisItem["kind"], itemKey: string): string {
  return `${kind}_${createHash("sha256").update(itemKey).digest("hex").slice(0, 16)}`;
}

function provenance(
  run: AnalysisRunMetadata,
  item: AnalysisItem,
  itemKey: string
): AnalysisProvenance {
  return {
    run_id: run.id,
    item_key: itemKey,
    provider: run.provider,
    prompt_version: run.prompt_version,
    schema_version: run.output_schema_version,
    analyzed_at: run.completed_at ?? nowIso(),
    evidence: item.evidence.map(({ quote }) => quote),
    reason: item.reason,
    stale: false
  };
}

function itemBody(item: AnalysisItem): string {
  const details =
    item.kind === "knowledge"
      ? item.summary
      : "该候选由 LLM 从已保存的工作上下文中提取，执行前仍由用户审核。";
  return [
    `# ${item.title}`,
    "",
    details,
    "",
    "## 证据",
    "",
    ...item.evidence.map(
      ({ source_ref, quote }) => `- \`${source_ref}\`：${quote}`
    ),
    "",
    "## 分析依据",
    "",
    item.reason
  ].join("\n");
}

function isDerived(document: WorkspaceDocument): boolean {
  return Boolean(document.data.analysis);
}

export class DerivedDocumentWriter {
  constructor(
    private readonly store: MarkdownStore,
    private readonly index: ContextIndex
  ) {}

  async writeNativeTask(record: NormalizedSourceRecord): Promise<number> {
    const todo = mapNativeTask(record).todo;
    if (!todo) return 0;
    const indexed = this.index.byId<TodoMetadata>(todo.id);
    const path = indexed?.path ?? `todos/items/${safeSegment(todo.id)}.md`;
    if (await this.store.exists(path)) {
      const existing = await this.store.read<TodoMetadata>(path);
      await this.store.write(
        path,
        {
          ...todo,
          ...existing.data,
          status: existing.data.status,
          due_at: todo.due_at,
          stakeholders: todo.stakeholders,
          source_refs: [...new Set([...existing.data.source_refs, ...todo.source_refs])],
          updated_at: nowIso()
        },
        existing.body || `# ${existing.data.title}`,
        { expectedEtag: existing.etag }
      );
      return 1;
    }
    await this.store.write(path, todo, `# ${todo.title}\n\n来自飞书原生任务。`, {
      createOnly: true
    });
    return 1;
  }

  async write(
    input: NormalizedSourceRecord | NormalizedSourceRecord[],
    output: AnalysisOutput,
    run: AnalysisRunMetadata
  ): Promise<number> {
    const records = Array.isArray(input) ? input : [input];
    const currentKeysBySource = new Map<string, Set<string>>(
      records.map(({ sourceId }) => [sourceId, new Set()])
    );
    for (const item of output.items) {
      const itemKey = analysisItemKey(item);
      for (const sourceRef of item.source_refs) {
        currentKeysBySource.get(sourceRef)?.add(itemKey);
      }
      if (item.kind === "todo") {
        await this.writeTodo(item, itemKey, run);
      } else {
        await this.writeKnowledge(item, itemKey, run);
      }
    }
    for (const record of records) {
      await this.markStale(
        record.sourceId,
        currentKeysBySource.get(record.sourceId) ?? new Set()
      );
    }
    await this.reconcilePersonInsights(records, output.person_insights, run);
    return output.items.length + output.person_insights.length;
  }

  private async writeTodo(
    item: Extract<AnalysisItem, { kind: "todo" }>,
    itemKey: string,
    run: AnalysisRunMetadata
  ): Promise<void> {
    const id = derivedId(item.kind, itemKey);
    const generated = createTodoMetadata({
      id,
      title: item.title,
      type: item.status === "candidate" ? "candidate" : "todo",
      status: item.status,
      direction: item.direction,
      stakeholders: item.stakeholders,
      due_at: item.due_at,
      explicit: item.explicit,
      upstream: "extracted_context",
      managed: "hybrid",
      source_refs: [...new Set(item.source_refs)],
      confidence: item.confidence
    });
    generated.analysis = provenance(run, item, itemKey);
    const indexed = this.index.byId<TodoMetadata>(id);
    const preferred =
      item.status === "candidate"
        ? `inbox/todo-candidates/${safeSegment(id)}.md`
        : `todos/items/${safeSegment(id)}.md`;
    const alternate =
      item.status === "candidate"
        ? `todos/items/${safeSegment(id)}.md`
        : `inbox/todo-candidates/${safeSegment(id)}.md`;
    const path = indexed?.path ??
      ((await this.store.exists(preferred))
        ? preferred
        : (await this.store.exists(alternate))
          ? alternate
          : preferred);

    if (await this.store.exists(path)) {
      const existing = await this.store.read<TodoMetadata>(path);
      const userOwned =
        existing.data.managed === "hybrid"
          ? {
              type: existing.data.type,
              title: existing.data.title,
              status: existing.data.status,
              direction: existing.data.direction,
              owner: existing.data.owner,
              stakeholders: existing.data.stakeholders,
              due_at: existing.data.due_at,
              explicit: existing.data.explicit,
              priority: existing.data.priority,
              automation: existing.data.automation
            }
          : {};
      await this.store.write(
        path,
        {
          ...generated,
          ...userOwned,
          created_at: existing.data.created_at,
          source_refs: [
            ...new Set([...existing.data.source_refs, ...item.source_refs])
          ],
          updated_at: nowIso()
        },
        existing.body || itemBody(item),
        { expectedEtag: existing.etag }
      );
      return;
    }
    await this.store.write(preferred, generated, itemBody(item), { createOnly: true });
  }

  private async writeKnowledge(
    item: Extract<AnalysisItem, { kind: "knowledge" }>,
    itemKey: string,
    run: AnalysisRunMetadata
  ): Promise<void> {
    const timestamp = nowIso();
    const id = derivedId(item.kind, itemKey);
    const generated: KnowledgeMetadata = {
      schema: "work-context/knowledge@1",
      id,
      type: "candidate",
      title: item.title,
      managed: "generated",
      created_at: timestamp,
      updated_at: timestamp,
      source_refs: [...new Set(item.source_refs)],
      confidence: item.confidence,
      status: "draft",
      knowledge_kind: item.knowledge_kind,
      curation_state: "draft",
      superseded_by: null,
      tags: [...new Set(item.tags)],
      analysis: provenance(run, item, itemKey)
    };
    const path =
      this.index.byId<KnowledgeMetadata>(id)?.path ??
      `inbox/knowledge-candidates/${safeSegment(id)}.md`;
    if (await this.store.exists(path)) {
      const existing = await this.store.read<KnowledgeMetadata>(path);
      const next =
        existing.data.managed === "generated"
          ? { ...generated, created_at: existing.data.created_at }
          : {
              ...existing.data,
              analysis: generated.analysis,
              confidence: generated.confidence,
              source_refs: [
                ...new Set([...existing.data.source_refs, ...item.source_refs])
              ],
              updated_at: timestamp
            };
      await this.store.write(path, next, existing.data.managed === "generated" ? itemBody(item) : existing.body, {
        expectedEtag: existing.etag
      });
      return;
    }
    await this.store.write(path, generated, itemBody(item), { createOnly: true });
  }

  private async markStale(sourceId: string, currentKeys: Set<string>): Promise<void> {
    const timestamp = nowIso();
    for (const document of this.index.backlinks(sourceId).filter(isDerived)) {
      const analysis = document.data.analysis;
      if (!analysis || currentKeys.has(analysis.item_key) || analysis.stale) continue;
      const data: BaseMetadata = {
        ...document.data,
        updated_at: timestamp,
        analysis: {
          ...analysis,
          stale: true,
          superseded_at: timestamp
        }
      };
      if (data.type === "candidate" && "curation_state" in data && data.managed === "generated") {
        data.curation_state = "stale";
      }
      await this.store.write(document.path, data, document.body, {
        expectedEtag: document.etag
      });
    }
  }

  private async reconcilePersonInsights(
    records: NormalizedSourceRecord[],
    insights: AnalysisPersonInsight[],
    run: AnalysisRunMetadata
  ): Promise<void> {
    const timestamp = run.completed_at ?? nowIso();
    const analyzedSourceIds = new Set(records.map(({ sourceId }) => sourceId));
    const currentInsightKeys = new Set(insights.map(personInsightKey));
    const insightsByPerson = new Map<string, AnalysisPersonInsight[]>();
    for (const insight of insights) {
      const values = insightsByPerson.get(insight.person_id) ?? [];
      values.push(insight);
      insightsByPerson.set(insight.person_id, values);
    }
    const existingPeople = this.index
      .all<PersonMetadata>()
      .filter(({ data }) => data.type === "person");
    const personIds = new Set([
      ...insightsByPerson.keys(),
      ...existingPeople
        .filter(({ data }) =>
          data.observations.some(
            (observation) =>
              observation.origin === "inferred" &&
              observation.source_refs?.length &&
              observation.source_refs.every((sourceRef) =>
                analyzedSourceIds.has(sourceRef)
              )
          )
        )
        .map(({ data }) => data.id)
    ]);
    const discovered = new Map(
      discoverPeople(records).map((person) => [person.id, person])
    );

    for (const personId of personIds) {
      const relativePath =
        this.index.byId<PersonMetadata>(personId)?.path ??
        `people/${safeSegment(personId)}.md`;
      const exists = await this.store.exists(relativePath);
      const existing = exists
        ? await this.store.read<PersonMetadata>(relativePath)
        : null;
      const baseline = existing?.data ?? discovered.get(personId);
      if (!baseline) continue;

      let observations = [...(baseline.observations ?? [])];
      for (const insight of insightsByPerson.get(personId) ?? []) {
        const key = personInsightKey(insight);
        const sourceRefs = [...new Set(insight.source_refs)];
        const observation: PersonObservation = {
          text: insight.text,
          evidence: insight.evidence.map(({ quote }) => quote),
          confidence: insight.confidence,
          observed_at: timestamp,
          origin: "inferred",
          category: insight.category,
          source_refs: sourceRefs,
          insight_key: key,
          stale: false
        };
        if (!safeObservations([observation]).length) continue;
        const index = observations.findIndex(
          (candidate) => candidate.insight_key === key
        );
        if (index >= 0) observations[index] = observation;
        else observations.push(observation);
      }
      observations = observations.map((observation) => {
        const sourceRefs = observation.source_refs ?? [];
        const isReconciledGeneratedObservation =
          observation.origin === "inferred" &&
          Boolean(observation.insight_key) &&
          sourceRefs.length > 0 &&
          sourceRefs.every((sourceRef) => analyzedSourceIds.has(sourceRef));
        if (
          !isReconciledGeneratedObservation ||
          currentInsightKeys.has(observation.insight_key!)
        ) {
          return observation;
        }
        return {
          ...observation,
          stale: true,
          superseded_at: timestamp
        };
      });
      const insightSourceRefs = insightsByPerson
        .get(personId)
        ?.flatMap(({ source_refs }) => source_refs) ?? [];
      const data: PersonMetadata = {
        ...baseline,
        updated_at: timestamp,
        source_refs: [
          ...new Set([...baseline.source_refs, ...insightSourceRefs])
        ],
        observations
      };
      if (existing) {
        await this.store.write(relativePath, data, existing.body, {
          expectedEtag: existing.etag
        });
      } else {
        await this.store.write(relativePath, data, "# 人物档案\n", {
          createOnly: true
        });
      }
    }
  }
}

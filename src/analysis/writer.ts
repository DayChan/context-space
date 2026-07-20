import { createHash } from "node:crypto";
import { ContextIndex } from "../core/index";
import { MarkdownStore } from "../core/markdown-store";
import { mapNativeTask } from "../core/analyzer";
import {
  nowIso,
  type AnalysisProvenance,
  type BaseMetadata,
  type KnowledgeMetadata,
  type NormalizedSourceRecord,
  type TodoMetadata,
  type WorkspaceDocument
} from "../core/types";
import { createTodoMetadata } from "../core/todo";
import type { AnalysisRunMetadata } from "./contracts";
import type { AnalysisItem, AnalysisOutput } from "./schema";
import { analysisItemKey } from "./validation";

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
    evidence: item.evidence,
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
    ...item.evidence.map((value) => `- ${value}`),
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
          status: todo.status,
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
    record: NormalizedSourceRecord,
    output: AnalysisOutput,
    run: AnalysisRunMetadata
  ): Promise<number> {
    const currentKeys = new Set<string>();
    for (const item of output.items) {
      const itemKey = analysisItemKey(item);
      currentKeys.add(itemKey);
      if (item.kind === "todo") {
        await this.writeTodo(item, itemKey, run);
      } else {
        await this.writeKnowledge(item, itemKey, run);
      }
    }
    await this.markStale(record.sourceId, currentKeys);
    return output.items.length;
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
      source_refs: [item.source_ref],
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
          source_refs: [...new Set([...existing.data.source_refs, item.source_ref])],
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
      source_refs: [item.source_ref],
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
              source_refs: [...new Set([...existing.data.source_refs, item.source_ref])],
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
}

import type { MarkdownIndexSync } from "../core/markdown-index-sync";
import type { MarkdownStore } from "../core/markdown-store";
import type { KnowledgeMetadata, Overview, WorkspaceDocument } from "../core/types";

function datedIdentity(date: string): { id: string; path: string } {
  const segment = date.replaceAll("-", "_");
  return {
    id: `daily_summary_${segment}`,
    path: `knowledge/drafts/daily_summary_${segment}.md`
  };
}

function list(title: string, values: string[]): string[] {
  return [
    `## ${title}`,
    "",
    ...(values.length ? values.map((value) => `- ${value}`) : ["- 无"]),
    ""
  ];
}

export class DailySummaryService {
  constructor(
    private readonly store: MarkdownStore,
    private readonly indexSync: MarkdownIndexSync
  ) {}

  async create(
    date: string,
    overview: Overview,
    timestamp = new Date().toISOString()
  ): Promise<WorkspaceDocument<KnowledgeMetadata>> {
    const identity = datedIdentity(date);
    if (await this.store.exists(identity.path)) {
      return this.store.read<KnowledgeMetadata>(identity.path);
    }
    const sourceRefs = [
      ...new Set([
        ...overview.topTodos.flatMap(({ source_refs }) => source_refs),
        ...overview.waitingItems.flatMap(({ source_refs }) => source_refs),
        ...overview.upcomingCalendar.map(({ id }) => id),
        ...overview.recentMentions.map(({ id }) => id),
        ...overview.upstreamTasks.map(({ id }) => id)
      ])
    ];
    const metadata: KnowledgeMetadata = {
      schema: "work-context/knowledge@1",
      id: identity.id,
      type: "knowledge",
      title: `${date} 工作摘要`,
      managed: "manual",
      created_at: timestamp,
      updated_at: timestamp,
      source_refs: sourceRefs,
      status: "draft",
      knowledge_kind: "draft",
      curation_state: "draft",
      superseded_by: null,
      tags: ["daily-summary", date]
    };
    const body = [
      `# ${metadata.title}`,
      "",
      ...list(
        "重要 Todo",
        overview.topTodos.map(({ title }) => title)
      ),
      ...list(
        "等待事项",
        overview.waitingItems.map(({ title }) => title)
      ),
      ...list(
        "近期日程",
        overview.upcomingCalendar.map(({ title, occurred_at }) =>
          `${occurred_at} · ${title}`
        )
      ),
      ...list(
        "最近提及",
        overview.recentMentions.map(({ title }) => title)
      ),
      ...list(
        "上游任务",
        overview.upstreamTasks.map(({ title }) => title)
      )
    ].join("\n");
    const saved = await this.store.write(
      identity.path,
      metadata,
      body,
      { createOnly: true }
    );
    await this.indexSync.refreshPath(saved.path);
    return saved;
  }
}

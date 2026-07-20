import type { ContextIndex } from "../core/index";
import type { MarkdownIndexSync } from "../core/markdown-index-sync";
import { MarkdownSchemaRegistry } from "../core/markdown-schema";
import type { MarkdownStore } from "../core/markdown-store";
import type {
  TodoMetadata,
  TodoStatus,
  WorkspaceDocument
} from "../core/types";
import { nowIso } from "../core/types";

export class HumanDocumentService {
  private readonly schemas = new MarkdownSchemaRegistry();

  constructor(
    private readonly store: MarkdownStore,
    private readonly index: ContextIndex,
    private readonly indexSync: MarkdownIndexSync
  ) {}

  async updateContent(input: {
    id: string;
    etag: string;
    title?: string;
    body: string;
  }): Promise<WorkspaceDocument | null> {
    const existing = this.index.byId(input.id);
    if (!existing) return null;
    const data = this.schemas.parse({
      ...existing.data,
      ...(input.title ? { title: input.title } : {}),
      updated_at: nowIso()
    });
    const saved = await this.store.write(existing.path, data, input.body, {
      expectedEtag: input.etag
    });
    await this.indexSync.refreshPath(saved.path);
    return saved;
  }

  async updateTodoStatus(
    id: string,
    status: TodoStatus
  ): Promise<WorkspaceDocument<TodoMetadata> | null> {
    const existing = this.index.byId<TodoMetadata>(id);
    if (!existing || existing.data.type !== "todo") return null;
    const saved = await this.store.write(
      existing.path,
      {
        ...existing.data,
        status,
        updated_at: nowIso()
      },
      existing.body,
      { expectedEtag: existing.etag }
    );
    await this.indexSync.refreshPath(saved.path);
    return saved;
  }
}

import type { BaseMetadata, SearchResult, WorkspaceDocument } from "./types";
import { MarkdownStore } from "./markdown-store";
import { listMarkdownFiles } from "./workspace";
import type { MarkdownIndexRepository } from "../machine";
import { MarkdownIndexSync } from "./markdown-index-sync";

function excerpt(body: string, query: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (!query) return compact.slice(0, 180);
  const index = compact.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, index < 0 ? 0 : index - 50);
  return compact.slice(start, start + 180);
}

export class ContextIndex {
  private documentsById = new Map<string, WorkspaceDocument>();
  private documentsByPath = new Map<string, WorkspaceDocument>();
  private backlinksByRef = new Map<string, Set<string>>();

  constructor(
    private readonly repository?: MarkdownIndexRepository,
    private readonly synchronization?: MarkdownIndexSync
  ) {}

  get size(): number {
    return this.repository?.size ?? this.documentsByPath.size;
  }

  async rebuild(store: MarkdownStore): Promise<number> {
    if (this.repository) {
      return (this.synchronization ??
        new MarkdownIndexSync(store, this.repository)).reconcile();
    }
    this.documentsById.clear();
    this.documentsByPath.clear();
    this.backlinksByRef.clear();
    const paths = await listMarkdownFiles(store.root);
    for (const filePath of paths) {
      const document = await store.read(filePath);
      this.documentsByPath.set(filePath, document);
      this.documentsById.set(document.data.id, document);
      for (const reference of document.data.source_refs) {
        const linked = this.backlinksByRef.get(reference) ?? new Set<string>();
        linked.add(document.data.id);
        this.backlinksByRef.set(reference, linked);
      }
    }
    return this.size;
  }

  all<T extends BaseMetadata = BaseMetadata>(
    options: { type?: string; status?: string } = {}
  ): WorkspaceDocument<T>[] {
    const documents = this.repository
      ? this.repository.all<T>(options)
      : ([...this.documentsByPath.values()] as WorkspaceDocument<T>[]);
    return documents
      .filter(({ data }) => !options.type || data.type === options.type)
      .filter(({ data }) => !options.status || data.status === options.status);
  }

  byId<T extends BaseMetadata = BaseMetadata>(id: string): WorkspaceDocument<T> | undefined {
    if (this.repository) return this.repository.byId<T>(id);
    return this.documentsById.get(id) as WorkspaceDocument<T> | undefined;
  }

  byPath<T extends BaseMetadata = BaseMetadata>(filePath: string): WorkspaceDocument<T> | undefined {
    if (this.repository) return this.repository.byPath<T>(filePath);
    return this.documentsByPath.get(filePath) as WorkspaceDocument<T> | undefined;
  }

  backlinks(reference: string): WorkspaceDocument[] {
    if (this.repository) return this.repository.backlinks(reference);
    const ids = this.backlinksByRef.get(reference) ?? new Set<string>();
    return [...ids].flatMap((id) => {
      const document = this.documentsById.get(id);
      return document ? [document] : [];
    });
  }

  search(query: string, type?: string): SearchResult[] {
    if (this.repository) return this.repository.search(query, type);
    const normalized = query.trim().toLocaleLowerCase();
    return this.all()
      .filter((document) => !type || document.data.type === type)
      .map((document) => {
        const title = document.data.title.toLocaleLowerCase();
        const body = document.body.toLocaleLowerCase();
        const metadata = JSON.stringify(document.data).toLocaleLowerCase();
        let score = normalized ? 0 : 1;
        if (normalized && title.includes(normalized)) score += 8;
        if (normalized && body.includes(normalized)) score += 4;
        if (normalized && metadata.includes(normalized)) score += 2;
        return {
          id: document.data.id,
          path: document.path,
          title: document.data.title,
          type: document.data.type,
          status: document.data.status,
          excerpt: excerpt(document.body, normalized),
          score,
          source_refs: document.data.source_refs
        };
      })
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
  }
}

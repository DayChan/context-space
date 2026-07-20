import type {
  BaseMetadata,
  SearchResult,
  WorkspaceDocument
} from "../core/types";
import { MachineDatabase } from "./database";
import { decodeJson, encodeJson } from "./json";

export interface MarkdownIndexInput {
  document: WorkspaceDocument;
  modifiedMs: number;
  sizeBytes: number;
}

export interface MarkdownDiagnostic {
  path: string;
  code: string;
  message: string;
  observedAt: string;
}

interface MarkdownRow {
  path: string;
  document_id: string;
  type: BaseMetadata["type"];
  title: string;
  status: string | null;
  body: string;
  metadata_json: string;
  etag: string;
}

function excerpt(body: string, query: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  const index = compact.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, index < 0 ? 0 : index - 50);
  return compact.slice(start, start + 180);
}

export class MarkdownIndexRepository {
  constructor(private readonly database: MachineDatabase) {}

  rebuild(
    inputs: MarkdownIndexInput[],
    diagnostics: MarkdownDiagnostic[]
  ): number {
    const timestamp = new Date().toISOString();
    return this.database.transaction(() => {
      const previous = this.activeGeneration();
      const generation = Number(
        this.database.connection
          .prepare(
            `INSERT INTO markdown_generations(status, created_at)
             VALUES ('building', ?)`
          )
          .run(timestamp).lastInsertRowid
      );
      const validPaths = new Set(inputs.map(({ document }) => document.path));
      for (const input of inputs) this.insert(generation, input);

      for (const diagnostic of diagnostics) {
        this.saveDiagnostic(diagnostic);
        if (!previous || validPaths.has(diagnostic.path)) continue;
        this.database.connection
          .prepare(
            `INSERT INTO markdown_documents(
               generation_id, path, document_id, schema_id, type, title,
               status, body, metadata_json, etag, modified_ms, size_bytes, indexed_at
             )
             SELECT ?, path, document_id, schema_id, type, title, status, body,
                    metadata_json, etag, modified_ms, size_bytes, indexed_at
             FROM markdown_documents
             WHERE generation_id = ? AND path = ?`
          )
          .run(generation, previous, diagnostic.path);
        this.database.connection
          .prepare(
            `INSERT INTO markdown_backlinks(generation_id, document_id, reference)
             SELECT ?, document_id, reference
             FROM markdown_backlinks
             WHERE generation_id = ? AND document_id = (
               SELECT document_id FROM markdown_documents
               WHERE generation_id = ? AND path = ?
             )`
          )
          .run(generation, previous, previous, diagnostic.path);
      }

      this.database.connection
        .prepare(
          `DELETE FROM markdown_diagnostics
           WHERE path IN (${inputs.map(() => "?").join(",") || "NULL"})`
        )
        .run(...inputs.map(({ document }) => document.path));
      this.database.connection
        .prepare(
          "UPDATE markdown_generations SET status = 'retired' WHERE status = 'active'"
        )
        .run();
      this.database.connection
        .prepare(
          `UPDATE markdown_generations
           SET status = 'active', activated_at = ?
           WHERE id = ?`
        )
        .run(timestamp, generation);
      this.database.connection
        .prepare("DELETE FROM markdown_generations WHERE status = 'retired'")
        .run();
      return generation;
    });
  }

  upsert(input: MarkdownIndexInput): void {
    this.database.transaction(() => {
      const generation = this.ensureActiveGeneration();
      this.database.connection
        .prepare(
          "DELETE FROM markdown_documents WHERE generation_id = ? AND path = ?"
        )
        .run(generation, input.document.path);
      this.insert(generation, input);
      this.database.connection
        .prepare("DELETE FROM markdown_diagnostics WHERE path = ?")
        .run(input.document.path);
    });
  }

  remove(filePath: string): void {
    const generation = this.activeGeneration();
    if (!generation) return;
    this.database.connection
      .prepare(
        "DELETE FROM markdown_documents WHERE generation_id = ? AND path = ?"
      )
      .run(generation, filePath);
    this.database.connection
      .prepare("DELETE FROM markdown_diagnostics WHERE path = ?")
      .run(filePath);
  }

  diagnose(diagnostic: MarkdownDiagnostic): void {
    this.saveDiagnostic(diagnostic);
  }

  diagnostics(): MarkdownDiagnostic[] {
    return (
      this.database.connection
        .prepare("SELECT * FROM markdown_diagnostics ORDER BY path")
        .all() as Array<{
        path: string;
        code: string;
        message: string;
        observed_at: string;
      }>
    ).map((row) => ({
      path: row.path,
      code: row.code,
      message: row.message,
      observedAt: row.observed_at
    }));
  }

  all<T extends BaseMetadata = BaseMetadata>(): WorkspaceDocument<T>[] {
    const generation = this.activeGeneration();
    if (!generation) return [];
    const rows = this.database.connection
      .prepare(
        "SELECT * FROM markdown_documents WHERE generation_id = ? ORDER BY path"
      )
      .all(generation) as MarkdownRow[];
    return rows.map((row) => this.hydrate<T>(row));
  }

  byId<T extends BaseMetadata = BaseMetadata>(
    id: string
  ): WorkspaceDocument<T> | undefined {
    const generation = this.activeGeneration();
    if (!generation) return undefined;
    const row = this.database.connection
      .prepare(
        `SELECT * FROM markdown_documents
         WHERE generation_id = ? AND document_id = ?`
      )
      .get(generation, id) as MarkdownRow | undefined;
    return row ? this.hydrate<T>(row) : undefined;
  }

  byPath<T extends BaseMetadata = BaseMetadata>(
    filePath: string
  ): WorkspaceDocument<T> | undefined {
    const generation = this.activeGeneration();
    if (!generation) return undefined;
    const row = this.database.connection
      .prepare(
        `SELECT * FROM markdown_documents
         WHERE generation_id = ? AND path = ?`
      )
      .get(generation, filePath) as MarkdownRow | undefined;
    return row ? this.hydrate<T>(row) : undefined;
  }

  backlinks(reference: string): WorkspaceDocument[] {
    const generation = this.activeGeneration();
    if (!generation) return [];
    const rows = this.database.connection
      .prepare(
        `SELECT document.*
         FROM markdown_backlinks backlink
         JOIN markdown_documents document
           ON document.generation_id = backlink.generation_id
          AND document.document_id = backlink.document_id
         WHERE backlink.generation_id = ? AND backlink.reference = ?
         ORDER BY document.path`
      )
      .all(generation, reference) as MarkdownRow[];
    return rows.map((row) => this.hydrate(row));
  }

  search(query: string, type?: string): SearchResult[] {
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
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.title.localeCompare(right.title)
      );
  }

  get size(): number {
    const generation = this.activeGeneration();
    if (!generation) return 0;
    return (
      this.database.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM markdown_documents WHERE generation_id = ?"
        )
        .get(generation) as { count: number }
    ).count;
  }

  private insert(generation: number, input: MarkdownIndexInput): void {
    const { document } = input;
    this.database.connection
      .prepare(
        `INSERT INTO markdown_documents(
           generation_id, path, document_id, schema_id, type, title, status,
           body, metadata_json, etag, modified_ms, size_bytes, indexed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        generation,
        document.path,
        document.data.id,
        document.data.schema,
        document.data.type,
        document.data.title,
        document.data.status ?? null,
        document.body,
        encodeJson(document.data),
        document.etag,
        input.modifiedMs,
        input.sizeBytes,
        new Date().toISOString()
      );
    const insertBacklink = this.database.connection.prepare(
      `INSERT INTO markdown_backlinks(generation_id, document_id, reference)
       VALUES (?, ?, ?)`
    );
    for (const reference of new Set(document.data.source_refs)) {
      insertBacklink.run(generation, document.data.id, reference);
    }
  }

  private saveDiagnostic(diagnostic: MarkdownDiagnostic): void {
    this.database.connection
      .prepare(
        `INSERT INTO markdown_diagnostics(path, code, message, observed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           code = excluded.code,
           message = excluded.message,
           observed_at = excluded.observed_at`
      )
      .run(
        diagnostic.path,
        diagnostic.code,
        diagnostic.message,
        diagnostic.observedAt
      );
  }

  private ensureActiveGeneration(): number {
    const active = this.activeGeneration();
    if (active) return active;
    const timestamp = new Date().toISOString();
    return Number(
      this.database.connection
        .prepare(
          `INSERT INTO markdown_generations(status, created_at, activated_at)
           VALUES ('active', ?, ?)`
        )
        .run(timestamp, timestamp).lastInsertRowid
    );
  }

  private activeGeneration(): number | null {
    const row = this.database.connection
      .prepare(
        "SELECT id FROM markdown_generations WHERE status = 'active' LIMIT 1"
      )
      .get() as { id: number } | undefined;
    return row?.id ?? null;
  }

  private hydrate<T extends BaseMetadata>(row: MarkdownRow): WorkspaceDocument<T> {
    return {
      path: row.path,
      data: decodeJson<T>(row.metadata_json),
      body: row.body,
      etag: row.etag
    };
  }
}

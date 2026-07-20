import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { BaseMetadata, WorkspaceDocument } from "./types";

export class UnsafeWorkspacePathError extends Error {}
export class DocumentConflictError extends Error {}
export class InvalidDocumentError extends Error {}

export interface WriteOptions {
  expectedEtag?: string;
  createOnly?: boolean;
}

export function etagFor(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .map(([key, nested]) => [key, withoutUndefined(nested)])
    );
  }
  return value;
}

export function serializeDocument(data: BaseMetadata, body: string): string {
  return matter.stringify(
    body.trimEnd() ? `${body.trimEnd()}\n` : "",
    withoutUndefined(data) as BaseMetadata
  );
}

export class MarkdownStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolve(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new UnsafeWorkspacePathError(`Unsafe workspace path: ${relativePath}`);
    }
    const resolved = path.resolve(this.root, relativePath);
    const relation = path.relative(this.root, resolved);
    if (relation.startsWith("..") || path.isAbsolute(relation)) {
      throw new UnsafeWorkspacePathError(`Path escapes workspace: ${relativePath}`);
    }
    return resolved;
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await stat(this.resolve(relativePath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async read<T extends BaseMetadata = BaseMetadata>(relativePath: string): Promise<WorkspaceDocument<T>> {
    const absolute = this.resolve(relativePath);
    const raw = await readFile(absolute, "utf8");
    const parsed = matter(raw);
    this.validateMetadata(parsed.data);
    return {
      path: relativePath.replaceAll(path.sep, "/"),
      data: parsed.data as T,
      body: parsed.content.trim(),
      etag: etagFor(raw)
    };
  }

  async write<T extends BaseMetadata>(
    relativePath: string,
    data: T,
    body: string,
    options: WriteOptions = {}
  ): Promise<WorkspaceDocument<T>> {
    if (!relativePath.endsWith(".md")) {
      throw new InvalidDocumentError("Canonical documents must use the .md extension");
    }
    this.validateMetadata(data);
    const absolute = this.resolve(relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });

    const alreadyExists = await this.exists(relativePath);
    if (options.createOnly && alreadyExists) {
      throw new DocumentConflictError(`Document already exists: ${relativePath}`);
    }
    if (options.expectedEtag !== undefined) {
      if (!alreadyExists) throw new DocumentConflictError(`Document no longer exists: ${relativePath}`);
      const current = await this.read(relativePath);
      if (current.etag !== options.expectedEtag) {
        throw new DocumentConflictError(`Document changed since it was loaded: ${relativePath}`);
      }
    }

    const raw = serializeDocument(data, body);
    const temporary = `${absolute}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, raw, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, absolute);
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      path: relativePath.replaceAll(path.sep, "/"),
      data,
      body: body.trim(),
      etag: etagFor(raw)
    };
  }

  async move<T extends BaseMetadata>(
    fromPath: string,
    toPath: string,
    options: Pick<WriteOptions, "expectedEtag"> = {}
  ): Promise<WorkspaceDocument<T>> {
    if (!fromPath.endsWith(".md") || !toPath.endsWith(".md")) {
      throw new InvalidDocumentError("Canonical documents must use the .md extension");
    }
    const current = await this.read<T>(fromPath);
    if (
      options.expectedEtag !== undefined &&
      current.etag !== options.expectedEtag
    ) {
      throw new DocumentConflictError(`Document changed since it was loaded: ${fromPath}`);
    }
    if (await this.exists(toPath)) {
      throw new DocumentConflictError(`Document already exists: ${toPath}`);
    }
    const destination = this.resolve(toPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(this.resolve(fromPath), destination);
    return {
      ...current,
      path: toPath.replaceAll(path.sep, "/")
    };
  }

  private validateMetadata(value: Record<string, unknown>): asserts value is BaseMetadata {
    const required = ["schema", "id", "type", "title", "managed", "created_at", "updated_at", "source_refs"];
    for (const field of required) {
      if (!(field in value)) throw new InvalidDocumentError(`Missing frontmatter field: ${field}`);
    }
    if (!Array.isArray(value.source_refs)) {
      throw new InvalidDocumentError("source_refs must be an array");
    }
  }
}

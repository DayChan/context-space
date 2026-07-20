import { stat } from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { MarkdownIndexRepository } from "../machine/markdown-index-repository";
import { listMarkdownFiles } from "./workspace";
import { MarkdownStore } from "./markdown-store";
import { MarkdownSchemaRegistry } from "./markdown-schema";

const HUMAN_ROOTS = ["todos/items", "people", "knowledge"] as const;

export async function listHumanMarkdownFiles(root: string): Promise<string[]> {
  const all = await listMarkdownFiles(root);
  return all.filter((filePath) =>
    HUMAN_ROOTS.some(
      (humanRoot) =>
        filePath === `${humanRoot}.md` ||
        filePath.startsWith(`${humanRoot}/`)
    )
  );
}

export class MarkdownIndexSync {
  private watcher: FSWatcher | null = null;
  private interval: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private lastReconciledAt: string | null = null;
  private lastIncrementalAt: string | null = null;

  constructor(
    private readonly store: MarkdownStore,
    private readonly repository: MarkdownIndexRepository,
    private readonly registry = new MarkdownSchemaRegistry(),
    private readonly reconcileMilliseconds = 5 * 60 * 1_000
  ) {}

  async reconcile(): Promise<number> {
    const files = await listHumanMarkdownFiles(this.store.root);
    const inputs = [];
    const diagnostics = [];
    for (const filePath of files) {
      try {
        const document = await this.store.read(filePath);
        document.data = this.registry.parse(document.data);
        const details = await stat(this.store.resolve(filePath));
        inputs.push({
          document,
          modifiedMs: details.mtimeMs,
          sizeBytes: details.size
        });
      } catch (error) {
        diagnostics.push({
          path: filePath,
          code: error instanceof Error ? error.name : "invalid_document",
          message: error instanceof Error ? error.message : String(error),
          observedAt: new Date().toISOString()
        });
      }
    }
    this.repository.rebuild(inputs, diagnostics);
    this.lastReconciledAt = new Date().toISOString();
    return this.repository.size;
  }

  async refreshPath(filePath: string): Promise<void> {
    const normalized = filePath.replaceAll(path.sep, "/");
    if (
      !HUMAN_ROOTS.some((root) => normalized.startsWith(`${root}/`)) ||
      !normalized.endsWith(".md")
    ) {
      return;
    }
    if (!(await this.store.exists(normalized))) {
      this.repository.remove(normalized);
      this.lastIncrementalAt = new Date().toISOString();
      return;
    }
    try {
      const document = await this.store.read(normalized);
      document.data = this.registry.parse(document.data);
      const details = await stat(this.store.resolve(normalized));
      this.repository.upsert({
        document,
        modifiedMs: details.mtimeMs,
        sizeBytes: details.size
      });
      this.lastIncrementalAt = new Date().toISOString();
    } catch (error) {
      this.repository.diagnose({
        path: normalized,
        code: error instanceof Error ? error.name : "invalid_document",
        message: error instanceof Error ? error.message : String(error),
        observedAt: new Date().toISOString()
      });
    }
  }

  async start(): Promise<void> {
    if (this.watcher) return;
    this.watcher = chokidar.watch(
      HUMAN_ROOTS.map((root) => path.join(this.store.root, root)),
      { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 150 } }
    );
    const schedule = (absolutePath: string) => {
      const relativePath = path
        .relative(this.store.root, absolutePath)
        .replaceAll(path.sep, "/");
      const previous = this.pending.get(relativePath);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        this.pending.delete(relativePath);
        void this.refreshPath(relativePath);
      }, 50);
      timer.unref();
      this.pending.set(relativePath, timer);
    };
    this.watcher.on("add", schedule).on("change", schedule).on("unlink", schedule);
    await new Promise<void>((resolve, reject) => {
      this.watcher!.once("ready", resolve).once("error", reject);
    });
    this.interval = setInterval(() => void this.reconcile(), this.reconcileMilliseconds);
    this.interval.unref();
  }

  async stop(): Promise<void> {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    await this.watcher?.close();
    this.watcher = null;
  }

  status(): {
    watcherRunning: boolean;
    lastReconciledAt: string | null;
    lastIncrementalAt: string | null;
    reconcileMilliseconds: number;
  } {
    return {
      watcherRunning: this.watcher !== null,
      lastReconciledAt: this.lastReconciledAt,
      lastIncrementalAt: this.lastIncrementalAt,
      reconcileMilliseconds: this.reconcileMilliseconds
    };
  }
}

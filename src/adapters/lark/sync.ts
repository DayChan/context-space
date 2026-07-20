import { AnalysisCoordinator } from "../../analysis/coordinator";
import { ContextIndex } from "../../core/index";
import type { BaseMetadata } from "../../core/types";
import {
  EMPTY_SYNC_STATUS,
  type NormalizedSourceRecord,
  type PersonMetadata,
  type SourceMetadata,
  type SyncSourceResult,
  type SyncStatus,
  type WorkspaceDocument,
  nowIso
} from "../../core/types";
import { discoverPeople } from "../../core/people";
import { MarkdownStore } from "../../core/markdown-store";
import { LarkAdapter, type LarkSyncSource, splitWindows } from "./adapter";
import { sourceKindDirectory } from "./normalize";

interface CheckpointData extends BaseMetadata {
  source_checkpoints: Record<string, { last_success_at: string }>;
  last_completed_at: string | null;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 140);
}

function sourcePath(record: NormalizedSourceRecord): string {
  const id = safeSegment(record.sourceId);
  const date = record.occurredAt.slice(0, 10);
  const directory = sourceKindDirectory(record.kind);
  if (record.kind === "mention") {
    const [year, month] = date.split("-");
    return `sources/lark/${directory}/${year}/${month}/${id}.md`;
  }
  if (record.kind === "p2p") {
    const partner = record.participants.find((entry) => entry.role === "partner")?.provider_id ?? "unknown";
    return `sources/lark/${directory}/${safeSegment(partner)}/${date}-${id}.md`;
  }
  return `sources/lark/${directory}/${id}.md`;
}

function sourceMetadata(record: NormalizedSourceRecord): SourceMetadata {
  const timestamp = nowIso();
  return {
    schema: "work-context/source@1",
    id: record.sourceId,
    type: "source",
    title: record.title,
    managed: "generated",
    created_at: timestamp,
    updated_at: timestamp,
    source_refs: [],
    provider: record.provider,
    source_kind: record.kind,
    source_id: record.sourceId,
    occurred_at: record.occurredAt,
    participants: record.participants,
    provider_metadata: record.metadata
  };
}

function sourceBody(record: NormalizedSourceRecord): string {
  const participants = record.participants.map((entry) => entry.name).filter(Boolean).join(", ");
  return [
    `# ${record.title}`,
    "",
    participants ? `**Participants:** ${participants}` : "",
    `**Occurred:** ${record.occurredAt}`,
    "",
    record.text || "_No text content._"
  ]
    .filter((line, index, lines) => line || lines[index - 1] !== "")
    .join("\n");
}

export interface SyncOptions {
  backfillDays?: number;
  overlapMinutes?: number;
  windowDays?: number;
  now?: Date;
}

export class LarkSyncService {
  private status: SyncStatus = { ...EMPTY_SYNC_STATUS };

  constructor(
    private readonly store: MarkdownStore,
    private readonly index: ContextIndex,
    private readonly adapter: LarkAdapter,
    private readonly analysis: AnalysisCoordinator
  ) {}

  getStatus(): SyncStatus {
    return this.status;
  }

  async loadStatus(): Promise<SyncStatus> {
    try {
      const document = await this.store.read(".context/sync/lark-status.md");
      this.status = {
        running: Boolean(document.data.running),
        started_at: typeof document.data.started_at === "string" ? document.data.started_at : null,
        completed_at:
          typeof document.data.completed_at === "string" ? document.data.completed_at : null,
        results: Array.isArray(document.data.results)
          ? (document.data.results as unknown as SyncSourceResult[])
          : [],
        last_error: typeof document.data.last_error === "string" ? document.data.last_error : null
      };
    } catch {
      this.status = { ...EMPTY_SYNC_STATUS };
    }
    return this.status;
  }

  async sync(options: SyncOptions = {}): Promise<SyncStatus> {
    if (this.status.running) throw new Error("A Lark synchronization is already running");
    const now = options.now ?? new Date();
    const backfillDays = options.backfillDays ?? 30;
    const overlapMinutes = options.overlapMinutes ?? 10;
    const windowDays = options.windowDays ?? 7;
    this.status = {
      running: true,
      started_at: nowIso(),
      completed_at: null,
      results: [],
      last_error: null
    };
    await this.persistStatus();

    const checkpoint = await this.readCheckpoint();
    const sources: LarkSyncSource[] = ["self", "mentions", "p2p", "calendar", "tasks"];
    const results: SyncSourceResult[] = [];

    for (const source of sources) {
      const previous = checkpoint.data.source_checkpoints[source]?.last_success_at;
      const defaultStart = new Date(now.getTime() - backfillDays * 24 * 60 * 60 * 1000);
      const start = previous
        ? new Date(new Date(previous).getTime() - overlapMinutes * 60 * 1000)
        : defaultStart;
      const windows =
        source === "mentions" || source === "p2p" || source === "calendar"
          ? splitWindows(start, now, windowDays)
          : [{ start, end: now }];
      let sourceResult: SyncSourceResult = {
        source,
        ok: true,
        received: 0,
        persisted: 0,
        completed_at: now.toISOString()
      };

      for (const window of windows) {
        const fetched = await this.adapter.fetchSource(source, window.start, window.end);
        sourceResult.received += fetched.result.received;
        if (!fetched.result.ok) {
          sourceResult = {
            ...sourceResult,
            ok: false,
            error: fetched.result.error,
            completed_at: undefined
          };
          break;
        }
        for (const record of fetched.records) {
          const persisted = await this.persistRecord(record);
          sourceResult.persisted += persisted.created;
          sourceResult.analyzed = (sourceResult.analyzed ?? 0) + persisted.analyzed;
          sourceResult.analysis_failed =
            (sourceResult.analysis_failed ?? 0) + persisted.analysisFailed;
        }
      }

      if (sourceResult.ok) {
        checkpoint.data.source_checkpoints[source] = { last_success_at: now.toISOString() };
      }
      results.push(sourceResult);
    }

    if (results.every((result) => result.ok)) {
      checkpoint.data.last_completed_at = now.toISOString();
    }
    checkpoint.data.updated_at = nowIso();
    await this.store.write(checkpoint.path, checkpoint.data, checkpoint.body, {
      expectedEtag: checkpoint.etag
    });

    this.status = {
      running: false,
      started_at: this.status.started_at,
      completed_at: nowIso(),
      results,
      last_error: results.some((result) => !result.ok)
        ? "One or more Lark sources failed; successful sources were preserved."
        : null
    };
    await this.persistStatus();
    await this.index.rebuild(this.store);
    return this.status;
  }

  private async readCheckpoint(): Promise<WorkspaceDocument<CheckpointData>> {
    return this.store.read<CheckpointData>(".context/sync/lark.md");
  }

  private async persistStatus(): Promise<void> {
    const existing = await this.store.read(".context/sync/lark-status.md");
    await this.store.write(
      existing.path,
      {
        ...existing.data,
        updated_at: nowIso(),
        ...this.status
      },
      "",
      { expectedEtag: existing.etag }
    );
  }

  private async persistRecord(record: NormalizedSourceRecord): Promise<{
    created: number;
    analyzed: number;
    analysisFailed: number;
  }> {
    const relativePath = sourcePath(record);
    const exists = await this.store.exists(relativePath);
    if (exists) {
      const existing = await this.store.read(relativePath);
      await this.store.write(
        relativePath,
        {
          ...sourceMetadata(record),
          created_at: existing.data.created_at
        },
        sourceBody(record),
        { expectedEtag: existing.etag }
      );
    } else {
      await this.store.write(relativePath, sourceMetadata(record), sourceBody(record), {
        createOnly: true
      });
    }

    await this.persistPeople(record);
    try {
      const result = await this.analysis.analyze(record);
      return {
        created: exists ? 0 : 1,
        analyzed: result.outcome === "not_applicable" ? 0 : 1,
        analysisFailed: 0
      };
    } catch {
      return {
        created: exists ? 0 : 1,
        analyzed: 0,
        analysisFailed: 1
      };
    }
  }

  private async persistPeople(record: NormalizedSourceRecord): Promise<void> {
    for (const person of discoverPeople([record])) {
      const relativePath = `people/${safeSegment(person.id)}.md`;
      if (await this.store.exists(relativePath)) {
        const existing = await this.store.read<PersonMetadata>(relativePath);
        const identities = [...existing.data.identities];
        for (const identity of person.identities) {
          if (
            !identities.some(
              (entry) =>
                entry.provider === identity.provider && entry.external_id === identity.external_id
            )
          ) {
            identities.push(identity);
          }
        }
        await this.store.write(
          relativePath,
          {
            ...person,
            ...existing.data,
            identities,
            title: existing.data.title || person.title,
            last_interaction_at:
              !existing.data.last_interaction_at ||
              existing.data.last_interaction_at < record.occurredAt
                ? record.occurredAt
                : existing.data.last_interaction_at,
            source_refs: [...new Set([...existing.data.source_refs, record.sourceId])],
            updated_at: nowIso()
          },
          existing.body,
          { expectedEtag: existing.etag }
        );
      } else {
        await this.store.write(relativePath, person, "# Profile\n", { createOnly: true });
      }
    }
  }

}

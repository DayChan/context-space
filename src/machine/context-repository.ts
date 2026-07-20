import { createHash } from "node:crypto";
import type { NormalizedSourceRecord, SourceParticipant } from "../core/types";
import { personIdForIdentity } from "../core/people";
import { MachineDatabase } from "./database";
import { decodeJson, encodeJson } from "./json";

export interface StoredSource {
  id: string;
  provider: string;
  externalId: string;
  kind: NormalizedSourceRecord["kind"];
  title: string;
  body: string | null;
  bodyHash: string;
  occurredAt: string;
  participants: SourceParticipant[];
  metadata: Record<string, unknown>;
  analyzedAt: string | null;
  bodyPurgedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredUpstreamPerson {
  personId: string;
  provider: string;
  externalId: string;
  displayName: string | null;
  payload: Record<string, unknown>;
  updatedAt: string;
}

interface SourceRow {
  id: string;
  provider: string;
  external_id: string;
  kind: NormalizedSourceRecord["kind"];
  title: string;
  body: string | null;
  body_hash: string;
  occurred_at: string;
  metadata_json: string;
  analyzed_at: string | null;
  body_purged_at: string | null;
  created_at: string;
  updated_at: string;
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function readString(
  metadata: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

const UNKNOWN_PARTICIPANT_NAMES = new Set([
  "Unknown",
  "Lark user",
  "Direct message partner"
]);

function displayName(participant: SourceParticipant): string | null {
  const name = participant.name.trim();
  if (
    !name ||
    name === participant.provider_id ||
    UNKNOWN_PARTICIPANT_NAMES.has(name)
  ) {
    return null;
  }
  return name;
}

export class MachineContextRepository {
  constructor(private readonly database: MachineDatabase) {}

  upsertSource(
    record: NormalizedSourceRecord,
    timestamp = new Date().toISOString()
  ): { inserted: boolean; changed: boolean } {
    return this.database.transaction(() => {
      const existing = this.database.connection
        .prepare("SELECT body_hash FROM sources WHERE id = ?")
        .get(record.sourceId) as { body_hash: string } | undefined;
      const hash = bodyHash(record.text);
      this.database.connection
        .prepare(
          `INSERT INTO sources(
             id, provider, external_id, kind, title, body, body_hash,
             occurred_at, metadata_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, external_id) DO UPDATE SET
             kind = excluded.kind,
             title = excluded.title,
             body = excluded.body,
             body_hash = excluded.body_hash,
             occurred_at = excluded.occurred_at,
             metadata_json = excluded.metadata_json,
             body_purged_at = NULL,
             updated_at = excluded.updated_at`
        )
        .run(
          record.sourceId,
          record.provider,
          record.sourceId,
          record.kind,
          record.title,
          record.text,
          hash,
          record.occurredAt,
          encodeJson(record.metadata),
          timestamp,
          timestamp
        );
      this.database.connection
        .prepare("DELETE FROM source_participants WHERE source_id = ?")
        .run(record.sourceId);
      const insertParticipant = this.database.connection.prepare(
        `INSERT INTO source_participants(
           source_id, provider_id, name, role, position
         ) VALUES (?, ?, ?, ?, ?)`
      );
      record.participants.forEach((participant, position) => {
        insertParticipant.run(
          record.sourceId,
          participant.provider_id,
          participant.name,
          participant.role ?? null,
          position
        );
      });
      this.upsertMachineOwnedProjection(record, timestamp);
      return {
        inserted: !existing,
        changed: !existing || existing.body_hash !== hash
      };
    });
  }

  private upsertMachineOwnedProjection(
    record: NormalizedSourceRecord,
    timestamp: string
  ): void {
    for (const participant of record.participants) {
      const personId = personIdForIdentity(record.provider, participant.provider_id);
      this.database.connection
        .prepare(
          `INSERT INTO upstream_people(
             person_id, provider, external_id, display_name, payload_json, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, external_id) DO UPDATE SET
             display_name = COALESCE(
               excluded.display_name,
               upstream_people.display_name
             ),
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at`
        )
        .run(
          personId,
          record.provider,
          participant.provider_id,
          displayName(participant),
          encodeJson({ role: participant.role ?? null }),
          timestamp
        );
    }

    if (record.kind !== "task") return;
    const status = readString(record.metadata, "status") ?? "open";
    const dueAt = readString(record.metadata, "due_at", "due", "dueAt");
    const assigneeIds = record.participants
      .filter(({ role }) => role === "assignee")
      .map(({ provider_id }) => provider_id);
    this.database.connection
      .prepare(
        `INSERT INTO upstream_tasks(
           source_id, external_id, status, due_at, assignee_ids_json,
           payload_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           status = excluded.status,
           due_at = excluded.due_at,
           assignee_ids_json = excluded.assignee_ids_json,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`
      )
      .run(
        record.sourceId,
        record.sourceId,
        status,
        dueAt,
        encodeJson(assigneeIds),
        encodeJson(record.metadata),
        timestamp
      );
  }

  getSource(id: string): StoredSource | null {
    const row = this.database.connection
      .prepare("SELECT * FROM sources WHERE id = ?")
      .get(id) as SourceRow | undefined;
    return row ? this.hydrateSource(row) : null;
  }

  listSources(options: {
    kinds?: NormalizedSourceRecord["kind"][];
    from?: string;
    to?: string;
    limit?: number;
  } = {}): StoredSource[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (options.kinds?.length) {
      clauses.push(`kind IN (${options.kinds.map(() => "?").join(", ")})`);
      parameters.push(...options.kinds);
    }
    if (options.from) {
      clauses.push("occurred_at >= ?");
      parameters.push(options.from);
    }
    if (options.to) {
      clauses.push("occurred_at <= ?");
      parameters.push(options.to);
    }
    if (options.limit !== undefined) parameters.push(options.limit);
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM sources
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY occurred_at ASC
         ${options.limit !== undefined ? "LIMIT ?" : ""}`
      )
      .all(...parameters) as SourceRow[];
    if (!rows.length) return [];
    const participantRows = this.database.connection
      .prepare(
        `SELECT participant.source_id, participant.provider_id,
                participant.name, participant.role
         FROM source_participants participant
         JOIN (
           SELECT id
           FROM sources
           ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
           ORDER BY occurred_at ASC
           ${options.limit !== undefined ? "LIMIT ?" : ""}
         ) selected ON selected.id = participant.source_id
         ORDER BY participant.source_id, participant.position`
      )
      .all(...parameters) as Array<{
        source_id: string;
        provider_id: string;
        name: string;
        role: SourceParticipant["role"] | null;
      }>;
    const participantsBySource = new Map<string, SourceParticipant[]>();
    for (const { source_id, role, ...participant } of participantRows) {
      const participants = participantsBySource.get(source_id) ?? [];
      participants.push({
        ...participant,
        ...(role ? { role } : {})
      });
      participantsBySource.set(source_id, participants);
    }
    return rows.map((row) =>
      this.hydrateSource(row, participantsBySource.get(row.id) ?? [])
    );
  }

  markAnalyzed(
    sourceIds: string[],
    timestamp = new Date().toISOString()
  ): void {
    if (!sourceIds.length) return;
    const update = this.database.connection.prepare(
      "UPDATE sources SET analyzed_at = ?, updated_at = ? WHERE id = ?"
    );
    this.database.transaction(() => {
      for (const sourceId of sourceIds) update.run(timestamp, timestamp, sourceId);
    });
  }

  purgeExpiredBodies(
    retentionDays: number,
    now = new Date()
  ): number {
    const cutoff = new Date(
      now.getTime() - retentionDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const timestamp = now.toISOString();
    const result = this.database.connection
      .prepare(
        `UPDATE sources
         SET body = NULL, body_purged_at = ?, updated_at = ?
         WHERE body IS NOT NULL
           AND occurred_at < ?
           AND (kind NOT IN ('mention', 'p2p') OR analyzed_at IS NOT NULL)
           AND NOT EXISTS (
             SELECT 1
             FROM candidate_evidence evidence
             JOIN analysis_candidates candidate
               ON candidate.id = evidence.candidate_id
             WHERE evidence.source_id = sources.id
               AND candidate.status IN ('proposed', 'pending')
           )`
      )
      .run(timestamp, timestamp, cutoff);
    return result.changes;
  }

  countUpstreamTasks(): number {
    return (
      this.database.connection
        .prepare("SELECT COUNT(*) AS count FROM upstream_tasks")
        .get() as { count: number }
    ).count;
  }

  countUpstreamPeople(): number {
    return (
      this.database.connection
        .prepare("SELECT COUNT(*) AS count FROM upstream_people")
        .get() as { count: number }
    ).count;
  }

  listUpstreamPeople(): StoredUpstreamPerson[] {
    return (
      this.database.connection
        .prepare(
          `SELECT person_id, provider, external_id, display_name,
                  payload_json, updated_at
           FROM upstream_people
           ORDER BY COALESCE(display_name, external_id)`
        )
        .all() as Array<{
        person_id: string;
        provider: string;
        external_id: string;
        display_name: string | null;
        payload_json: string;
        updated_at: string;
      }>
    ).map((row) => ({
      personId: row.person_id,
      provider: row.provider,
      externalId: row.external_id,
      displayName: row.display_name,
      payload: decodeJson<Record<string, unknown>>(row.payload_json),
      updatedAt: row.updated_at
    }));
  }

  private hydrateSource(
    row: SourceRow,
    prefetchedParticipants?: SourceParticipant[]
  ): StoredSource {
    const participants = prefetchedParticipants ?? (
      this.database.connection
        .prepare(
          `SELECT provider_id, name, role
           FROM source_participants
           WHERE source_id = ?
           ORDER BY position`
        )
        .all(row.id) as Array<{
          provider_id: string;
          name: string;
          role: SourceParticipant["role"] | null;
        }>
    ).map(({ role, ...participant }) => ({
      ...participant,
      ...(role ? { role } : {})
    }));
    return {
      id: row.id,
      provider: row.provider,
      externalId: row.external_id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      bodyHash: row.body_hash,
      occurredAt: row.occurred_at,
      participants,
      metadata: decodeJson<Record<string, unknown>>(row.metadata_json),
      analyzedAt: row.analyzed_at,
      bodyPurgedAt: row.body_purged_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

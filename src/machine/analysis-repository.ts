import { randomUUID } from "node:crypto";
import type { AnalysisUsage } from "../analysis/contracts";
import { MachineDatabase } from "./database";
import { decodeJson, encodeJson } from "./json";

export type AnalysisJobStatus =
  | "queued"
  | "leased"
  | "succeeded"
  | "failed_retryable"
  | "failed_terminal";

export interface AnalysisJob {
  id: string;
  idempotencyKey: string;
  sourceIds: string[];
  status: AnalysisJobStatus;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attempts: number;
  maxAttempts: number;
  config: Record<string, unknown>;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AnalysisJobRow {
  id: string;
  idempotency_key: string;
  source_ids_json: string;
  status: AnalysisJobStatus;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempts: number;
  max_attempts: number;
  config_json: string;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnalysisCandidateInput {
  id: string;
  stableKey: string;
  kind: "todo" | "knowledge" | "person_insight";
  title: string;
  data: Record<string, unknown>;
  sourceRefs: string[];
  confidence: number;
  reason: string;
  evidence: Array<{
    sourceId: string;
    quote: string;
  }>;
}

export interface StoredCandidate {
  id: string;
  runId: string;
  stableKey: string;
  kind: AnalysisCandidateInput["kind"];
  status: "proposed" | "rejected" | "pending" | "accepted";
  title: string;
  data: Record<string, unknown>;
  sourceRefs: string[];
  confidence: number;
  reason: string;
  provider: string;
  promptVersion: string;
  analyzedAt: string;
  createdAt: string;
  reviewedAt: string | null;
  evidence: AnalysisCandidateInput["evidence"];
}

export interface AcceptanceOperation {
  candidateId: string;
  state: "pending" | "materialized" | "accepted" | "conflict";
  documentId: string;
  documentPath: string;
  documentEtag: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BeginAnalysisRunInput {
  id: string;
  jobId: string;
  provider: string;
  model: string | null;
  promptVersion: string;
  schemaVersion: string;
  configHash: string;
  startedAt?: string;
}

export interface CompleteAnalysisRunInput {
  runId: string;
  jobId: string;
  workerId: string;
  sourceIds: string[];
  candidates: AnalysisCandidateInput[];
  eventTypes: string[];
  usage: AnalysisUsage | null;
  completedAt?: string;
}

export class AnalysisJobRepository {
  constructor(private readonly database: MachineDatabase) {}

  enqueue(input: {
    idempotencyKey: string;
    sourceIds: string[];
    config: Record<string, unknown>;
    maxAttempts?: number;
    availableAt?: string;
    id?: string;
  }): AnalysisJob {
    const timestamp = input.availableAt ?? new Date().toISOString();
    const id = input.id ?? `job_${randomUUID()}`;
    this.database.connection
      .prepare(
        `INSERT INTO analysis_jobs(
           id, idempotency_key, source_ids_json, status, available_at,
           max_attempts, config_json, created_at, updated_at
         ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`
      )
      .run(
        id,
        input.idempotencyKey,
        encodeJson([...new Set(input.sourceIds)]),
        timestamp,
        input.maxAttempts ?? 3,
        encodeJson(input.config),
        timestamp,
        timestamp
      );
    return this.byIdempotencyKey(input.idempotencyKey)!;
  }

  claim(
    owner: string,
    now = new Date(),
    leaseMilliseconds = 120_000
  ): AnalysisJob | null {
    return this.database.transaction(() => {
      const nowIso = now.toISOString();
      const row = this.database.connection
        .prepare(
          `SELECT *
           FROM analysis_jobs
           WHERE (
             status IN ('queued', 'failed_retryable')
             AND available_at <= ?
           ) OR (
             status = 'leased'
             AND lease_expires_at <= ?
           )
           ORDER BY available_at ASC, created_at ASC
           LIMIT 1`
        )
        .get(nowIso, nowIso) as AnalysisJobRow | undefined;
      if (!row) return null;
      const leaseExpiresAt = new Date(
        now.getTime() + leaseMilliseconds
      ).toISOString();
      const changed = this.database.connection
        .prepare(
          `UPDATE analysis_jobs
           SET status = 'leased',
               lease_owner = ?,
               lease_expires_at = ?,
               attempts = attempts + 1,
               updated_at = ?
           WHERE id = ?
             AND (
               status IN ('queued', 'failed_retryable')
               OR (status = 'leased' AND lease_expires_at <= ?)
             )`
        )
        .run(owner, leaseExpiresAt, nowIso, row.id, nowIso);
      return changed.changes ? this.get(row.id) : null;
    });
  }

  renew(
    jobId: string,
    owner: string,
    now = new Date(),
    leaseMilliseconds = 120_000
  ): boolean {
    const result = this.database.connection
      .prepare(
        `UPDATE analysis_jobs
         SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_owner = ?`
      )
      .run(
        new Date(now.getTime() + leaseMilliseconds).toISOString(),
        now.toISOString(),
        jobId,
        owner
      );
    return result.changes === 1;
  }

  fail(
    jobId: string,
    owner: string,
    input: {
      retryable: boolean;
      code: string;
      message: string;
      now?: Date;
    }
  ): AnalysisJob {
    const now = input.now ?? new Date();
    return this.database.transaction(() => {
      const job = this.get(jobId);
      if (!job || job.status !== "leased" || job.leaseOwner !== owner) {
        throw new Error(`分析任务租约不属于当前 Worker：${jobId}`);
      }
      const retryable = input.retryable && job.attempts < job.maxAttempts;
      const delay = retryable
        ? Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1))
        : 0;
      this.database.connection
        .prepare(
          `UPDATE analysis_jobs
           SET status = ?,
               available_at = ?,
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error_code = ?,
               last_error_message = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          retryable ? "failed_retryable" : "failed_terminal",
          new Date(now.getTime() + delay).toISOString(),
          input.code,
          input.message,
          now.toISOString(),
          jobId
        );
      return this.get(jobId)!;
    });
  }

  retry(jobId: string, timestamp = new Date().toISOString()): AnalysisJob {
    const changed = this.database.connection
      .prepare(
        `UPDATE analysis_jobs
         SET status = 'queued',
             attempts = 0,
             available_at = ?,
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error_code = NULL,
             last_error_message = NULL,
             updated_at = ?
         WHERE id = ? AND status = 'failed_terminal'`
      )
      .run(timestamp, timestamp, jobId);
    if (!changed.changes) throw new Error(`任务当前不可重试：${jobId}`);
    return this.get(jobId)!;
  }

  complete(
    jobId: string,
    owner: string,
    timestamp = new Date().toISOString()
  ): void {
    const result = this.database.connection
      .prepare(
        `UPDATE analysis_jobs
         SET status = 'succeeded',
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error_code = NULL,
             last_error_message = NULL,
             updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_owner = ?`
      )
      .run(timestamp, jobId, owner);
    if (!result.changes) {
      throw new Error(`无法完成不属于当前 Worker 的任务：${jobId}`);
    }
  }

  get(id: string): AnalysisJob | null {
    const row = this.database.connection
      .prepare("SELECT * FROM analysis_jobs WHERE id = ?")
      .get(id) as AnalysisJobRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  byIdempotencyKey(key: string): AnalysisJob | null {
    const row = this.database.connection
      .prepare("SELECT * FROM analysis_jobs WHERE idempotency_key = ?")
      .get(key) as AnalysisJobRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  counts(): Record<AnalysisJobStatus, number> {
    const result: Record<AnalysisJobStatus, number> = {
      queued: 0,
      leased: 0,
      succeeded: 0,
      failed_retryable: 0,
      failed_terminal: 0
    };
    const rows = this.database.connection
      .prepare("SELECT status, COUNT(*) AS count FROM analysis_jobs GROUP BY status")
      .all() as Array<{ status: AnalysisJobStatus; count: number }>;
    for (const row of rows) result[row.status] = row.count;
    return result;
  }

  list(status?: AnalysisJobStatus, limit = 50): AnalysisJob[] {
    const rows = this.database.connection
      .prepare(
        `SELECT *
         FROM analysis_jobs
         ${status ? "WHERE status = ?" : ""}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...(status ? [status, limit] : [limit])) as AnalysisJobRow[];
    return rows.map((row) => this.hydrate(row));
  }

  private hydrate(row: AnalysisJobRow): AnalysisJob {
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      sourceIds: decodeJson<string[]>(row.source_ids_json),
      status: row.status,
      availableAt: row.available_at,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      config: decodeJson<Record<string, unknown>>(row.config_json),
      lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

export class AnalysisResultRepository {
  constructor(private readonly database: MachineDatabase) {}

  beginRun(input: BeginAnalysisRunInput): void {
    this.database.connection
      .prepare(
        `INSERT INTO analysis_runs(
           id, job_id, status, provider, model, prompt_version,
           schema_version, config_hash, event_types_json, started_at
         ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, '[]', ?)`
      )
      .run(
        input.id,
        input.jobId,
        input.provider,
        input.model,
        input.promptVersion,
        input.schemaVersion,
        input.configHash,
        input.startedAt ?? new Date().toISOString()
      );
  }

  completeRun(input: CompleteAnalysisRunInput): void {
    const timestamp = input.completedAt ?? new Date().toISOString();
    this.database.transaction(() => {
      const run = this.database.connection
        .prepare("SELECT status FROM analysis_runs WHERE id = ? AND job_id = ?")
        .get(input.runId, input.jobId) as { status: string } | undefined;
      if (!run || run.status !== "running") {
        throw new Error(`分析运行不存在或不可完成：${input.runId}`);
      }
      const insertCandidate = this.database.connection.prepare(
        `INSERT INTO analysis_candidates(
           id, run_id, stable_key, kind, status, title, data_json,
           source_refs_json, confidence, reason, created_at
         ) VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)`
      );
      const insertEvidence = this.database.connection.prepare(
        `INSERT INTO candidate_evidence(
           candidate_id, source_id, quote, position
         ) VALUES (?, ?, ?, ?)`
      );
      for (const candidate of input.candidates) {
        insertCandidate.run(
          candidate.id,
          input.runId,
          candidate.stableKey,
          candidate.kind,
          candidate.title,
          encodeJson(candidate.data),
          encodeJson([...new Set(candidate.sourceRefs)]),
          candidate.confidence,
          candidate.reason,
          timestamp
        );
        candidate.evidence.forEach((evidence, position) => {
          insertEvidence.run(
            candidate.id,
            evidence.sourceId,
            evidence.quote,
            position
          );
        });
      }
      this.database.connection
        .prepare(
          `UPDATE analysis_runs
           SET status = 'succeeded',
               event_types_json = ?,
               usage_json = ?,
               completed_at = ?,
               duration_ms = MAX(
                 0,
                 CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
               )
           WHERE id = ?`
        )
        .run(
          encodeJson(input.eventTypes),
          input.usage ? encodeJson(input.usage) : null,
          timestamp,
          timestamp,
          input.runId
        );
      const completedJob = this.database.connection
        .prepare(
          `UPDATE analysis_jobs
           SET status = 'succeeded',
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error_code = NULL,
               last_error_message = NULL,
               updated_at = ?
           WHERE id = ? AND status = 'leased' AND lease_owner = ?`
        )
        .run(timestamp, input.jobId, input.workerId);
      if (completedJob.changes !== 1) {
        throw new Error(`分析任务租约已失效：${input.jobId}`);
      }
      const sourceIds = [...new Set(input.sourceIds)];
      const markAnalyzed = this.database.connection.prepare(
        "UPDATE sources SET analyzed_at = ?, updated_at = ? WHERE id = ?"
      );
      for (const sourceId of sourceIds) {
        markAnalyzed.run(timestamp, timestamp, sourceId);
      }
    });
  }

  failRun(input: {
    runId: string;
    errorCode: string;
    errorMessage: string;
    eventTypes?: string[];
    completedAt?: string;
  }): void {
    const timestamp = input.completedAt ?? new Date().toISOString();
    this.database.connection
      .prepare(
        `UPDATE analysis_runs
         SET status = 'failed',
             error_code = ?,
             error_message = ?,
             event_types_json = ?,
             completed_at = ?,
             duration_ms = MAX(
               0,
               CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
             )
         WHERE id = ?`
      )
      .run(
        input.errorCode,
        input.errorMessage,
        encodeJson(input.eventTypes ?? []),
        timestamp,
        timestamp,
        input.runId
      );
  }

  listCandidates(
    status: StoredCandidate["status"] | null = "proposed"
  ): StoredCandidate[] {
    const rows = this.database.connection
      .prepare(
        `SELECT candidate.*,
                run.provider AS run_provider,
                run.prompt_version AS run_prompt_version,
                COALESCE(run.completed_at, run.started_at) AS analyzed_at
         FROM analysis_candidates candidate
         JOIN analysis_runs run ON run.id = candidate.run_id
         ${status ? "WHERE candidate.status = ?" : ""}
         ORDER BY candidate.created_at DESC`
      )
      .all(...(status ? [status] : [])) as CandidateRow[];
    return rows.map((row) => this.hydrateCandidate(row));
  }

  getCandidate(id: string): StoredCandidate | null {
    const row = this.database.connection
      .prepare(
        `SELECT candidate.*,
                run.provider AS run_provider,
                run.prompt_version AS run_prompt_version,
                COALESCE(run.completed_at, run.started_at) AS analyzed_at
         FROM analysis_candidates candidate
         JOIN analysis_runs run ON run.id = candidate.run_id
         WHERE candidate.id = ?`
      )
      .get(id) as CandidateRow | undefined;
    return row ? this.hydrateCandidate(row) : null;
  }

  rejectCandidate(
    id: string,
    timestamp = new Date().toISOString()
  ): StoredCandidate {
    const result = this.database.connection
      .prepare(
        `UPDATE analysis_candidates
         SET status = 'rejected', reviewed_at = ?
         WHERE id = ? AND status = 'proposed'`
      )
      .run(timestamp, id);
    const candidate = this.getCandidate(id);
    if (!candidate) throw new Error(`候选不存在：${id}`);
    if (!result.changes && candidate.status !== "rejected") {
      throw new Error(`候选当前不可拒绝：${id}`);
    }
    return candidate;
  }

  beginAcceptance(input: {
    candidateId: string;
    documentId: string;
    documentPath: string;
    timestamp?: string;
  }): AcceptanceOperation {
    const timestamp = input.timestamp ?? new Date().toISOString();
    return this.database.transaction(() => {
      const candidate = this.getCandidate(input.candidateId);
      if (!candidate) throw new Error(`候选不存在：${input.candidateId}`);
      if (candidate.status === "rejected") {
        throw new Error(`已拒绝候选不能接受：${input.candidateId}`);
      }
      this.database.connection
        .prepare(
          `INSERT INTO acceptance_operations(
             candidate_id, state, document_id, document_path, created_at, updated_at
           ) VALUES (?, 'pending', ?, ?, ?, ?)
           ON CONFLICT(candidate_id) DO NOTHING`
        )
        .run(
          input.candidateId,
          input.documentId,
          input.documentPath,
          timestamp,
          timestamp
        );
      this.database.connection
        .prepare(
          `UPDATE analysis_candidates
           SET status = 'pending'
           WHERE id = ? AND status = 'proposed'`
        )
        .run(input.candidateId);
      const operation = this.getAcceptance(input.candidateId)!;
      if (
        operation.documentId !== input.documentId ||
        operation.documentPath !== input.documentPath
      ) {
        throw new Error(`候选接受目标不一致：${input.candidateId}`);
      }
      return operation;
    });
  }

  markMaterialized(
    candidateId: string,
    etag: string,
    timestamp = new Date().toISOString()
  ): AcceptanceOperation {
    this.database.connection
      .prepare(
        `UPDATE acceptance_operations
         SET state = 'materialized',
             document_etag = ?,
             error = NULL,
             updated_at = ?
         WHERE candidate_id = ? AND state IN ('pending', 'materialized')`
      )
      .run(etag, timestamp, candidateId);
    const operation = this.getAcceptance(candidateId);
    if (!operation) throw new Error(`候选接受操作不存在：${candidateId}`);
    return operation;
  }

  markAccepted(
    candidateId: string,
    timestamp = new Date().toISOString()
  ): AcceptanceOperation {
    return this.database.transaction(() => {
      const changed = this.database.connection
        .prepare(
          `UPDATE acceptance_operations
           SET state = 'accepted', error = NULL, updated_at = ?
           WHERE candidate_id = ? AND state IN ('materialized', 'accepted')`
        )
        .run(timestamp, candidateId);
      if (!changed.changes) {
        throw new Error(`候选尚未物化：${candidateId}`);
      }
      this.database.connection
        .prepare(
          `UPDATE analysis_candidates
           SET status = 'accepted', reviewed_at = ?
           WHERE id = ? AND status IN ('pending', 'accepted')`
        )
        .run(timestamp, candidateId);
      return this.getAcceptance(candidateId)!;
    });
  }

  markAcceptanceConflict(
    candidateId: string,
    error: string,
    timestamp = new Date().toISOString()
  ): AcceptanceOperation {
    this.database.connection
      .prepare(
        `UPDATE acceptance_operations
         SET state = 'conflict', error = ?, updated_at = ?
         WHERE candidate_id = ? AND state <> 'accepted'`
      )
      .run(error, timestamp, candidateId);
    const operation = this.getAcceptance(candidateId);
    if (!operation) throw new Error(`候选接受操作不存在：${candidateId}`);
    return operation;
  }

  getAcceptance(candidateId: string): AcceptanceOperation | null {
    const row = this.database.connection
      .prepare("SELECT * FROM acceptance_operations WHERE candidate_id = ?")
      .get(candidateId) as AcceptanceRow | undefined;
    return row ? hydrateAcceptance(row) : null;
  }

  recoverableAcceptances(): AcceptanceOperation[] {
    return (
      this.database.connection
        .prepare(
          `SELECT * FROM acceptance_operations
           WHERE state IN ('pending', 'materialized')
           ORDER BY created_at`
        )
        .all() as AcceptanceRow[]
    ).map(hydrateAcceptance);
  }

  private hydrateCandidate(row: CandidateRow): StoredCandidate {
    const evidence = this.database.connection
      .prepare(
        `SELECT source_id, quote
         FROM candidate_evidence
         WHERE candidate_id = ?
         ORDER BY position`
      )
      .all(row.id) as Array<{ source_id: string; quote: string }>;
    return {
      id: row.id,
      runId: row.run_id,
      stableKey: row.stable_key,
      kind: row.kind,
      status: row.status,
      title: row.title,
      data: decodeJson<Record<string, unknown>>(row.data_json),
      sourceRefs: decodeJson<string[]>(row.source_refs_json),
      confidence: row.confidence,
      reason: row.reason,
      provider: row.run_provider,
      promptVersion: row.run_prompt_version,
      analyzedAt: row.analyzed_at,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      evidence: evidence.map(({ source_id, quote }) => ({
        sourceId: source_id,
        quote
      }))
    };
  }
}

interface CandidateRow {
  id: string;
  run_id: string;
  stable_key: string;
  kind: AnalysisCandidateInput["kind"];
  status: StoredCandidate["status"];
  title: string;
  data_json: string;
  source_refs_json: string;
  confidence: number;
  reason: string;
  created_at: string;
  reviewed_at: string | null;
  run_provider: string;
  run_prompt_version: string;
  analyzed_at: string;
}

interface AcceptanceRow {
  candidate_id: string;
  state: AcceptanceOperation["state"];
  document_id: string;
  document_path: string;
  document_etag: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function hydrateAcceptance(row: AcceptanceRow): AcceptanceOperation {
  return {
    candidateId: row.candidate_id,
    state: row.state,
    documentId: row.document_id,
    documentPath: row.document_path,
    documentEtag: row.document_etag,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

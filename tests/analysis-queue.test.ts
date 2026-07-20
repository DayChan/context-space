import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedSourceRecord } from "../src/core/types";
import {
  AnalysisJobRepository,
  AnalysisResultRepository,
  MachineContextRepository,
  openMachineDatabase,
  type MachineDatabase
} from "../src/machine";

const now = new Date("2026-07-20T00:00:00.000Z");

function record(id: string): NormalizedSourceRecord {
  return {
    sourceId: id,
    provider: "lark",
    kind: "mention",
    title: id,
    text: "Please follow up",
    occurredAt: "2026-07-19T00:00:00.000Z",
    participants: [],
    metadata: {}
  };
}

describe("durable analysis queue", () => {
  let root: string;
  let database: MachineDatabase;
  let jobs: AnalysisJobRepository;
  let results: AnalysisResultRepository;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-queue-"));
    database = await openMachineDatabase(root);
    jobs = new AnalysisJobRepository(database);
    results = new AnalysisResultRepository(database);
    new MachineContextRepository(database).upsertSource(
      record("lark:message:1"),
      now.toISOString()
    );
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("deduplicates jobs and recovers expired leases", () => {
    const first = jobs.enqueue({
      id: "job_1",
      idempotencyKey: "same",
      sourceIds: ["lark:message:1"],
      config: {},
      availableAt: now.toISOString()
    });
    const duplicate = jobs.enqueue({
      id: "job_2",
      idempotencyKey: "same",
      sourceIds: ["lark:message:1"],
      config: {},
      availableAt: now.toISOString()
    });
    expect(duplicate.id).toBe(first.id);
    expect(jobs.claim("worker-a", now, 1_000)).toMatchObject({
      id: "job_1",
      attempts: 1,
      status: "leased"
    });
    expect(jobs.claim("worker-b", new Date(now.getTime() + 500))).toBeNull();
    expect(
      jobs.claim("worker-b", new Date(now.getTime() + 1_001), 1_000)
    ).toMatchObject({
      id: "job_1",
      attempts: 2,
      leaseOwner: "worker-b"
    });
  });

  it("backs off retryable failures and reaches a terminal state", () => {
    jobs.enqueue({
      id: "job_retry",
      idempotencyKey: "retry",
      sourceIds: ["lark:message:1"],
      config: {},
      maxAttempts: 2,
      availableAt: now.toISOString()
    });
    jobs.claim("worker", now);
    expect(
      jobs.fail("job_retry", "worker", {
        retryable: true,
        code: "timeout",
        message: "timeout",
        now
      })
    ).toMatchObject({ status: "failed_retryable" });
    const secondAttemptAt = new Date(now.getTime() + 1_000);
    jobs.claim("worker", secondAttemptAt);
    expect(
      jobs.fail("job_retry", "worker", {
        retryable: true,
        code: "timeout",
        message: "timeout",
        now: secondAttemptAt
      })
    ).toMatchObject({ status: "failed_terminal", attempts: 2 });
    expect(jobs.retry("job_retry", secondAttemptAt.toISOString())).toMatchObject({
      status: "queued",
      attempts: 0
    });
  });

  it("atomically completes a run and stores candidates with evidence", () => {
    jobs.enqueue({
      id: "job_success",
      idempotencyKey: "success",
      sourceIds: ["lark:message:1"],
      config: {},
      availableAt: now.toISOString()
    });
    jobs.claim("worker", now);
    results.beginRun({
      id: "run_1",
      jobId: "job_success",
      provider: "test",
      model: null,
      promptVersion: "p1",
      schemaVersion: "s1",
      configHash: "hash",
      startedAt: now.toISOString()
    });
    results.completeRun({
      runId: "run_1",
      jobId: "job_success",
      workerId: "worker",
      sourceIds: ["lark:message:1"],
      eventTypes: [],
      usage: null,
      completedAt: now.toISOString(),
      candidates: [
        {
          id: "candidate_1",
          stableKey: "todo:1",
          kind: "todo",
          title: "Follow up",
          data: { status: "candidate" },
          sourceRefs: ["lark:message:1"],
          confidence: 0.9,
          reason: "explicit request",
          evidence: [
            { sourceId: "lark:message:1", quote: "Please follow up" }
          ]
        }
      ]
    });
    expect(jobs.get("job_success")?.status).toBe("succeeded");
    expect(results.getCandidate("candidate_1")).toMatchObject({
      title: "Follow up",
      status: "proposed",
      evidence: [{ sourceId: "lark:message:1", quote: "Please follow up" }]
    });
  });

  it("rolls back all candidates when one evidence reference is invalid", () => {
    jobs.enqueue({
      id: "job_atomic",
      idempotencyKey: "atomic",
      sourceIds: ["lark:message:1"],
      config: {},
      availableAt: now.toISOString()
    });
    jobs.claim("worker", now);
    results.beginRun({
      id: "run_atomic",
      jobId: "job_atomic",
      provider: "test",
      model: null,
      promptVersion: "p1",
      schemaVersion: "s1",
      configHash: "hash",
      startedAt: now.toISOString()
    });
    expect(() =>
      results.completeRun({
        runId: "run_atomic",
        jobId: "job_atomic",
        workerId: "worker",
        sourceIds: ["lark:message:1"],
        eventTypes: [],
        usage: null,
        candidates: [
          {
            id: "candidate_valid",
            stableKey: "one",
            kind: "todo",
            title: "One",
            data: {},
            sourceRefs: ["lark:message:1"],
            confidence: 0.8,
            reason: "reason",
            evidence: [
              { sourceId: "lark:message:1", quote: "valid" }
            ]
          },
          {
            id: "candidate_invalid",
            stableKey: "two",
            kind: "knowledge",
            title: "Two",
            data: {},
            sourceRefs: ["missing"],
            confidence: 0.8,
            reason: "reason",
            evidence: [{ sourceId: "missing", quote: "invalid" }]
          }
        ]
      })
    ).toThrow();
    expect(results.listCandidates(null)).toHaveLength(0);
    expect(jobs.get("job_atomic")?.status).toBe("leased");
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnalysisProvider,
  ProviderAnalysisResponse
} from "../src/analysis/contracts";
import { DEFAULT_ANALYSIS_CONFIG } from "../src/analysis/config";
import { CandidateReviewService } from "../src/analysis/candidate-review";
import {
  PersistentAnalysisProcessor
} from "../src/analysis/persistent-processor";
import { AnalysisWorker, AnalysisWorkerPool } from "../src/analysis/worker";
import { AnalysisProviderRegistry } from "../src/analysis/providers/registry";
import type { NormalizedSourceRecord } from "../src/core/types";
import { personIdForIdentity } from "../src/core/people";
import { initializeWorkspace } from "../src/core/workspace";
import {
  AnalysisJobRepository,
  AnalysisResultRepository,
  MachineContextRepository,
  openMachineDatabase,
  type MachineDatabase
} from "../src/machine";
import { nullLogger } from "../src/logging";

class FakeProvider implements AnalysisProvider {
  readonly id = "fake";
  calls = 0;

  async getAvailability() {
    return { available: true, detail: "ok" };
  }

  async analyze(): Promise<ProviderAnalysisResponse> {
    this.calls += 1;
    return {
      finalResponse: JSON.stringify({
        schema_version: "work-context/analysis@2",
        items: [
          {
            kind: "todo",
            title: "Prepare report",
            source_refs: ["lark:message:worker"],
            confidence: 1,
            evidence: [
              {
                source_ref: "lark:message:worker",
                quote: "Please prepare the report"
              }
            ],
            reason: "Direct request",
            status: "open",
            direction: "owed_by_me",
            due_at: null,
            explicit: true,
            stakeholders: []
          },
          {
            kind: "knowledge",
            title: "Reporting process",
            source_refs: ["lark:message:worker"],
            confidence: 0.9,
            evidence: [
              {
                source_ref: "lark:message:worker",
                quote: "Please prepare the report"
              }
            ],
            reason: "Reusable reporting context",
            knowledge_kind: "playbook",
            summary: "Prepare the report before review.",
            tags: ["reporting"]
          }
        ],
        person_insights: [
          {
            person_id: personIdForIdentity("lark", "ou_alice"),
            category: "responsibility",
            text: "Alice owns reporting",
            source_refs: ["lark:message:worker"],
            confidence: 0.95,
            evidence: [
              {
                source_ref: "lark:message:worker",
                quote: "Please prepare the report"
              }
            ],
            reason: "Explicit reporting responsibility"
          }
        ]
      }),
      model: "fake",
      usage: null,
      eventTypes: ["agent_message"]
    };
  }
}

class InvalidProvider implements AnalysisProvider {
  readonly id = "invalid";

  async getAvailability() {
    return { available: true, detail: "ok" };
  }

  async analyze(): Promise<ProviderAnalysisResponse> {
    return {
      finalResponse: JSON.stringify({
        schema_version: "work-context/analysis@2",
        items: [{ kind: "todo", title: "missing required fields" }],
        person_insights: []
      }),
      model: null,
      usage: null,
      eventTypes: ["agent_message"]
    };
  }
}

describe("AnalysisWorker", () => {
  let root: string;
  let database: MachineDatabase;
  let store: Awaited<ReturnType<typeof initializeWorkspace>>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-worker-"));
    store = await initializeWorkspace(root);
    database = await openMachineDatabase(root);
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("publishes Todo and workplace insights while keeping knowledge in the review queue", async () => {
    const sources = new MachineContextRepository(database);
    const record: NormalizedSourceRecord = {
      sourceId: "lark:message:worker",
      provider: "lark",
      kind: "mention",
      title: "Request",
      text: "Please prepare the report",
      occurredAt: "2026-07-20T00:00:00.000Z",
      participants: [
        { provider_id: "ou_alice", name: "Alice", role: "sender" }
      ],
      metadata: {}
    };
    sources.upsertSource(record);
    const jobs = new AnalysisJobRepository(database);
    const results = new AnalysisResultRepository(database);
    jobs.enqueue({
      id: "job_worker",
      idempotencyKey: "worker",
      sourceIds: [record.sourceId],
      config: {
        analysis: {
          ...DEFAULT_ANALYSIS_CONFIG,
          provider: "fake",
          prompt_version: "context-analysis@2"
        },
        timezone: "Asia/Singapore",
        currentUserId: "self"
      },
      availableAt: "2026-07-20T00:00:00.000Z"
    });
    const provider = new FakeProvider();
    const processor = new PersistentAnalysisProcessor(
      sources,
      jobs,
      results,
      new AnalysisProviderRegistry([provider]),
      new CandidateReviewService(results, store)
    );
    const worker = new AnalysisWorker(jobs, processor);
    expect(await worker.runOnce(new Date("2026-07-20T00:00:00.000Z"))).toBe(true);
    expect(provider.calls).toBe(1);
    expect(jobs.get("job_worker")?.status).toBe("succeeded");
    expect(results.listCandidates()).toMatchObject([
      {
        kind: "knowledge",
        status: "proposed",
        title: "Reporting process"
      }
    ]);
    const allCandidates = results.listCandidates(null);
    const acceptedTodo = allCandidates.find(({ kind }) => kind === "todo");
    const proposedKnowledge = allCandidates.find(
      ({ kind }) => kind === "knowledge"
    );
    const acceptedInsight = allCandidates.find(
      ({ kind }) => kind === "person_insight"
    );
    expect(acceptedTodo).toBeDefined();
    expect(acceptedTodo?.status).toBe("accepted");
    expect(proposedKnowledge).toBeDefined();
    expect(acceptedInsight?.status).toBe("accepted");
    expect(
      await store.exists(`todos/items/todo_${acceptedTodo!.id}.md`)
    ).toBe(true);
    expect(
      await store.exists(
        `knowledge/playbooks/knowledge_${proposedKnowledge!.id}.md`
      )
    ).toBe(false);
    expect(
      await store.exists(`people/person_insight_${acceptedInsight!.id}.md`)
    ).toBe(true);
  });

  it("rejects an invalid batch atomically and records a retryable failure", async () => {
    const sources = new MachineContextRepository(database);
    const record: NormalizedSourceRecord = {
      sourceId: "lark:message:invalid-worker",
      provider: "lark",
      kind: "mention",
      title: "Invalid",
      text: "Unstructured request",
      occurredAt: "2026-07-20T00:00:00.000Z",
      participants: [],
      metadata: {}
    };
    sources.upsertSource(record);
    const jobs = new AnalysisJobRepository(database);
    const results = new AnalysisResultRepository(database);
    jobs.enqueue({
      id: "job_invalid_worker",
      idempotencyKey: "invalid-worker",
      sourceIds: [record.sourceId],
      config: {
        analysis: { ...DEFAULT_ANALYSIS_CONFIG, provider: "invalid" },
        timezone: "Asia/Singapore",
        currentUserId: "self"
      },
      availableAt: "2026-07-20T00:00:00.000Z"
    });
    const processor = new PersistentAnalysisProcessor(
      sources,
      jobs,
      results,
      new AnalysisProviderRegistry([new InvalidProvider()]),
      new CandidateReviewService(results, store)
    );
    const worker = new AnalysisWorker(jobs, processor);

    expect(
      await worker.runOnce(new Date("2026-07-20T00:00:00.000Z"))
    ).toBe(true);
    expect(jobs.get("job_invalid_worker")).toMatchObject({
      status: "failed_retryable",
      lastErrorCode: "invalid_output"
    });
    expect(results.listCandidates(null)).toEqual([]);
  });

  it("uses distinct run IDs after a terminal job is manually retried", async () => {
    const sources = new MachineContextRepository(database);
    const record: NormalizedSourceRecord = {
      sourceId: "lark:message:retried-worker",
      provider: "lark",
      kind: "mention",
      title: "Invalid retry",
      text: "Unstructured request",
      occurredAt: "2026-07-20T00:00:00.000Z",
      participants: [],
      metadata: {}
    };
    sources.upsertSource(record);
    const jobs = new AnalysisJobRepository(database);
    const results = new AnalysisResultRepository(database);
    jobs.enqueue({
      id: "job_retried_worker",
      idempotencyKey: "retried-worker",
      sourceIds: [record.sourceId],
      config: {
        analysis: { ...DEFAULT_ANALYSIS_CONFIG, provider: "invalid" },
        timezone: "Asia/Singapore",
        currentUserId: "self"
      },
      maxAttempts: 1,
      availableAt: "2026-07-20T00:00:00.000Z"
    });
    const processor = new PersistentAnalysisProcessor(
      sources,
      jobs,
      results,
      new AnalysisProviderRegistry([new InvalidProvider()]),
      new CandidateReviewService(results, store)
    );
    const worker = new AnalysisWorker(jobs, processor);

    expect(await worker.runOnce(new Date("2026-07-20T00:00:00.000Z"))).toBe(true);
    expect(jobs.get("job_retried_worker")?.status).toBe("failed_terminal");
    jobs.retry("job_retried_worker", "2026-07-20T00:00:01.000Z");
    expect(await worker.runOnce(new Date("2026-07-20T00:00:01.000Z"))).toBe(true);

    const runs = database.connection
      .prepare("SELECT id, status FROM analysis_runs WHERE job_id = ?")
      .all("job_retried_worker") as Array<{ id: string; status: string }>;
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map(({ id }) => id)).size).toBe(2);
    expect(runs.every(({ status }) => status === "failed")).toBe(true);
  });

  it("claims and processes jobs concurrently across the configured pool", async () => {
    const jobs = new AnalysisJobRepository(database);
    for (const id of ["parallel_a", "parallel_b"]) {
      jobs.enqueue({
        id: `job_${id}`,
        idempotencyKey: id,
        sourceIds: [],
        config: {},
        availableAt: "2026-07-20T00:00:00.000Z"
      });
    }
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processor = {
      async process(job: { id: string }, workerId: string) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate;
        jobs.complete(job.id, workerId);
        active -= 1;
      }
    } as unknown as PersistentAnalysisProcessor;
    const pool = new AnalysisWorkerPool(
      jobs,
      processor,
      nullLogger,
      {},
      2
    );

    const running = pool.runOnce(new Date("2026-07-20T00:00:00.000Z"));
    await vi.waitFor(() => expect(active).toBe(2));
    release();
    expect(await running).toBe(true);
    expect(maximumActive).toBe(2);
    expect(jobs.counts().succeeded).toBe(2);
  });
});

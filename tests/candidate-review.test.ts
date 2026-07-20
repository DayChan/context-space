import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CandidateReviewService } from "../src/analysis/candidate-review";
import type { NormalizedSourceRecord } from "../src/core/types";
import { initializeWorkspace } from "../src/core/workspace";
import {
  AnalysisJobRepository,
  AnalysisResultRepository,
  MachineContextRepository,
  openMachineDatabase,
  type MachineDatabase
} from "../src/machine";

describe("CandidateReviewService", () => {
  let root: string;
  let database: MachineDatabase;
  let results: AnalysisResultRepository;
  let review: CandidateReviewService;
  let store: Awaited<ReturnType<typeof initializeWorkspace>>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-review-"));
    store = await initializeWorkspace(root);
    database = await openMachineDatabase(root);
    const context = new MachineContextRepository(database);
    const source: NormalizedSourceRecord = {
      sourceId: "lark:message:review",
      provider: "lark",
      kind: "mention",
      title: "Review",
      text: "Please prepare the report",
      occurredAt: "2026-07-20T00:00:00.000Z",
      participants: [],
      metadata: {}
    };
    context.upsertSource(source);
    const jobs = new AnalysisJobRepository(database);
    jobs.enqueue({
      id: "job_review",
      idempotencyKey: "review",
      sourceIds: [source.sourceId],
      config: {},
      availableAt: "2026-07-20T00:00:00.000Z"
    });
    jobs.claim("worker", new Date("2026-07-20T00:00:00.000Z"));
    results = new AnalysisResultRepository(database);
    results.beginRun({
      id: "run_review",
      jobId: "job_review",
      provider: "test",
      model: null,
      promptVersion: "p1",
      schemaVersion: "s1",
      configHash: "hash"
    });
    results.completeRun({
      runId: "run_review",
      jobId: "job_review",
      workerId: "worker",
      sourceIds: [source.sourceId],
      eventTypes: [],
      usage: null,
      candidates: [
        {
          id: "candidate_review",
          stableKey: "todo",
          kind: "todo",
          title: "Prepare report",
          data: {
            direction: "owed_by_me",
            due_at: null,
            explicit: true,
            stakeholders: []
          },
          sourceRefs: [source.sourceId],
          confidence: 1,
          reason: "Direct request",
          evidence: [
            {
              sourceId: source.sourceId,
              quote: "Please prepare the report"
            }
          ]
        }
      ]
    });
    review = new CandidateReviewService(results, store);
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a candidate into deterministic Markdown idempotently", async () => {
    const first = await review.accept("candidate_review");
    expect(first).toMatchObject({
      state: "accepted",
      documentId: "todo_candidate_review",
      documentPath: "todos/items/todo_candidate_review.md"
    });
    const document = await store.read(first.documentPath);
    expect(document.data).toMatchObject({
      id: first.documentId,
      candidate_id: "candidate_review",
      type: "todo",
      managed: "manual"
    });
    expect(document.body).toContain("Please prepare the report");
    const second = await review.accept("candidate_review");
    expect(second.documentEtag).toBe(first.documentEtag);
    expect(
      results.getCandidate("candidate_review")?.status
    ).toBe("accepted");
  });

  it("recovers a pending operation when its deterministic file already exists", async () => {
    const operation = results.beginAcceptance({
      candidateId: "candidate_review",
      documentId: "todo_candidate_review",
      documentPath: "todos/items/todo_candidate_review.md"
    });
    await store.write(
      operation.documentPath,
      {
        schema: "work-context/todo@1",
        id: operation.documentId,
        type: "todo",
        title: "Prepare report",
        managed: "manual",
        created_at: "2026-07-20T00:00:00.000Z",
        updated_at: "2026-07-20T00:00:00.000Z",
        source_refs: ["lark:message:review"],
        candidate_id: "candidate_review"
      },
      "# Prepare report",
      { createOnly: true }
    );
    expect(await review.recover()).toMatchObject([
      { state: "accepted", candidateId: "candidate_review" }
    ]);
  });

  it("isolates a conflicting deterministic path without overwriting", async () => {
    await store.write(
      "todos/items/todo_candidate_review.md",
      {
        schema: "work-context/todo@1",
        id: "someone_else",
        type: "todo",
        title: "Existing",
        managed: "manual",
        created_at: "2026-07-20T00:00:00.000Z",
        updated_at: "2026-07-20T00:00:00.000Z",
        source_refs: []
      },
      "# Existing",
      { createOnly: true }
    );
    expect(await review.accept("candidate_review")).toMatchObject({
      state: "conflict"
    });
    expect(
      (await store.read("todos/items/todo_candidate_review.md")).data.id
    ).toBe("someone_else");
  });

  it("rejects a candidate idempotently without creating Markdown", () => {
    expect(review.reject("candidate_review").status).toBe("rejected");
    expect(review.reject("candidate_review").status).toBe("rejected");
  });
});

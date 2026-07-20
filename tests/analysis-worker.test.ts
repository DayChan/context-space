import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnalysisProvider,
  ProviderAnalysisResponse
} from "../src/analysis/contracts";
import { DEFAULT_ANALYSIS_CONFIG } from "../src/analysis/config";
import {
  PersistentAnalysisProcessor
} from "../src/analysis/persistent-processor";
import { AnalysisWorker } from "../src/analysis/worker";
import { AnalysisProviderRegistry } from "../src/analysis/providers/registry";
import type { NormalizedSourceRecord } from "../src/core/types";
import {
  AnalysisJobRepository,
  AnalysisResultRepository,
  MachineContextRepository,
  openMachineDatabase,
  type MachineDatabase
} from "../src/machine";

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
          }
        ],
        person_insights: []
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

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-worker-"));
    database = await openMachineDatabase(root);
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("turns provider output into candidates without creating Markdown", async () => {
    const sources = new MachineContextRepository(database);
    const record: NormalizedSourceRecord = {
      sourceId: "lark:message:worker",
      provider: "lark",
      kind: "mention",
      title: "Request",
      text: "Please prepare the report",
      occurredAt: "2026-07-20T00:00:00.000Z",
      participants: [],
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
        analysis: { ...DEFAULT_ANALYSIS_CONFIG, provider: "fake" },
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
      new AnalysisProviderRegistry([provider])
    );
    const worker = new AnalysisWorker(jobs, processor);
    expect(await worker.runOnce(new Date("2026-07-20T00:00:00.000Z"))).toBe(true);
    expect(provider.calls).toBe(1);
    expect(jobs.get("job_worker")?.status).toBe("succeeded");
    expect(results.listCandidates()).toMatchObject([
      {
        kind: "todo",
        status: "proposed",
        title: "Prepare report"
      }
    ]);
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
      new AnalysisProviderRegistry([new InvalidProvider()])
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
});

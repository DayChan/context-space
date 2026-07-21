import { z } from "zod";
import { AnalysisJobRepository, SettingsRepository } from "../machine";
import { nullLogger, type Logger } from "../logging";
import {
  newWorkerId,
  PersistentAnalysisProcessor
} from "./persistent-processor";

export interface AnalysisWorkerOptions {
  idleDelayMilliseconds?: number;
  leaseMilliseconds?: number;
}

export const DEFAULT_ANALYSIS_WORKER_COUNT = 1;
export const MAX_ANALYSIS_WORKER_COUNT = 8;

const workerCountSchema = z.number().int().min(1).max(MAX_ANALYSIS_WORKER_COUNT);

export interface EffectiveAnalysisWorkerConfig {
  worker_count: number;
  source: "workspace" | "environment";
  locked: boolean;
}

export class AnalysisWorkerConfigService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  getEffective(): EffectiveAnalysisWorkerConfig {
    const override = this.environment.CONTEXT_SPACE_ANALYSIS_WORKERS?.trim();
    if (override) {
      return {
        worker_count: workerCountSchema.parse(Number(override)),
        source: "environment",
        locked: true
      };
    }
    const stored = this.settings.get<number>("analysis_worker_count");
    return {
      worker_count: workerCountSchema.parse(
        stored ?? DEFAULT_ANALYSIS_WORKER_COUNT
      ),
      source: "workspace",
      locked: false
    };
  }

  update(input: unknown): EffectiveAnalysisWorkerConfig {
    const { worker_count } = z
      .object({ worker_count: workerCountSchema })
      .strict()
      .parse(input);
    const current = this.getEffective();
    if (current.locked && worker_count !== current.worker_count) {
      throw new Error("LLM Worker 数量已被环境变量锁定");
    }
    if (!current.locked) {
      this.settings.set("analysis_worker_count", worker_count);
    }
    return this.getEffective();
  }
}

export class AnalysisWorker {
  private readonly workerId = newWorkerId();
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private running: Promise<boolean> | null = null;

  constructor(
    private readonly jobs: AnalysisJobRepository,
    private readonly processor: PersistentAnalysisProcessor,
    logger: Logger = nullLogger,
    private readonly options: AnalysisWorkerOptions = {}
  ) {
    this.logger = logger.child({ component: "analysis-worker" });
  }

  start(): void {
    if (this.timer || this.running) return;
    this.stopping = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      await this.running;
    } catch (error) {
      this.logger.error("analysis.worker.stop_after_iteration_failure", {
        error
      });
    }
  }

  async runOnce(now = new Date()): Promise<boolean> {
    if (this.running) return this.running;
    this.running = this.executeOne(now);
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  private async executeOne(now: Date): Promise<boolean> {
    const leaseMilliseconds = this.options.leaseMilliseconds ?? 120_000;
    const job = this.jobs.claim(
      this.workerId,
      now,
      leaseMilliseconds
    );
    if (!job) return false;
    const renewal = setInterval(() => {
      const renewed = this.jobs.renew(
        job.id,
        this.workerId,
        new Date(),
        leaseMilliseconds
      );
      if (!renewed) {
        this.logger.warn("analysis.job.lease_lost", { job_id: job.id });
      }
    }, Math.max(1_000, Math.floor(leaseMilliseconds / 3)));
    renewal.unref();
    try {
      await this.processor.process(job, this.workerId);
    } finally {
      clearInterval(renewal);
    }
    return true;
  }

  private schedule(delay: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .catch((error) => {
          this.logger.error("analysis.worker.iteration.failed", { error });
        })
        .finally(() => {
          this.schedule(this.options.idleDelayMilliseconds ?? 1_000);
        });
    }, delay);
    this.timer.unref();
  }
}

export class AnalysisWorkerPool {
  private readonly workers: AnalysisWorker[] = [];
  private readonly retiring = new Set<Promise<void>>();
  private started = false;

  constructor(
    private readonly jobs: AnalysisJobRepository,
    private readonly processor: PersistentAnalysisProcessor,
    private readonly logger: Logger = nullLogger,
    private readonly options: AnalysisWorkerOptions = {},
    workerCount = DEFAULT_ANALYSIS_WORKER_COUNT
  ) {
    this.resize(workerCount);
  }

  get workerCount(): number {
    return this.workers.length;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const worker of this.workers) worker.start();
  }

  setWorkerCount(workerCount: number): void {
    this.resize(workerCount);
  }

  async stop(): Promise<void> {
    this.started = false;
    const active = this.workers.splice(0).map((worker) => worker.stop());
    await Promise.all([...active, ...this.retiring]);
  }

  async runOnce(now = new Date()): Promise<boolean> {
    const results = await Promise.all(
      this.workers.map((worker) => worker.runOnce(now))
    );
    return results.some(Boolean);
  }

  private resize(workerCount: number): void {
    const desired = workerCountSchema.parse(workerCount);
    while (this.workers.length < desired) {
      const worker = new AnalysisWorker(
        this.jobs,
        this.processor,
        this.logger,
        this.options
      );
      this.workers.push(worker);
      if (this.started) worker.start();
    }
    while (this.workers.length > desired) {
      const worker = this.workers.pop()!;
      const retirement = worker.stop();
      this.retiring.add(retirement);
      void retirement.then(() => this.retiring.delete(retirement));
    }
  }
}

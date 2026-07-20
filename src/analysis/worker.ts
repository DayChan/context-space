import { AnalysisJobRepository } from "../machine";
import { nullLogger, type Logger } from "../logging";
import {
  newWorkerId,
  PersistentAnalysisProcessor
} from "./persistent-processor";

export interface AnalysisWorkerOptions {
  idleDelayMilliseconds?: number;
  leaseMilliseconds?: number;
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
    await this.running;
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

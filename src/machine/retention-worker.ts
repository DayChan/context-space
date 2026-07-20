import type { MachineContextRepository } from "./context-repository";
import type { SettingsRepository } from "./settings-repository";

export class SourceRetentionWorker {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly context: MachineContextRepository,
    private readonly settings: SettingsRepository,
    private readonly intervalMilliseconds = 24 * 60 * 60 * 1000
  ) {}

  runOnce(now = new Date()): number {
    return this.context.purgeExpiredBodies(
      this.settings.getSourceRetentionDays(),
      now
    );
  }

  start(): number {
    if (this.timer) return 0;
    const purged = this.runOnce();
    this.timer = setInterval(() => {
      this.runOnce();
    }, this.intervalMilliseconds);
    this.timer.unref();
    return purged;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

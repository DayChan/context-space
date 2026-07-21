import { z } from "zod";
import { nullLogger, type Logger } from "../../logging";
import { SettingsRepository } from "../../machine";
import type { LarkSyncService } from "./sync";

export const DEFAULT_LARK_SYNC_SCHEDULE: LarkSyncScheduleConfig = {
  enabled: false,
  interval: 1,
  unit: "hours"
};

const larkSyncScheduleSchema = z
  .object({
    enabled: z.boolean(),
    interval: z.number().int().min(1),
    unit: z.enum(["minutes", "hours"])
  })
  .strict()
  .superRefine((config, context) => {
    const maximum = config.unit === "minutes" ? 10_080 : 168;
    if (config.interval > maximum) {
      context.addIssue({
        code: "custom",
        path: ["interval"],
        message: `同步周期不得超过 ${maximum} ${config.unit === "minutes" ? "分钟" : "小时"}`
      });
    }
  });

export interface LarkSyncScheduleConfig {
  enabled: boolean;
  interval: number;
  unit: "minutes" | "hours";
}

export class LarkSyncScheduleConfigService {
  constructor(private readonly settings: SettingsRepository) {}

  get(): LarkSyncScheduleConfig {
    return larkSyncScheduleSchema.parse({
      ...DEFAULT_LARK_SYNC_SCHEDULE,
      ...(this.settings.get<Partial<LarkSyncScheduleConfig>>(
        "lark_sync_schedule"
      ) ?? {})
    });
  }

  update(input: unknown): LarkSyncScheduleConfig {
    const config = larkSyncScheduleSchema.parse(input);
    this.settings.set("lark_sync_schedule", config);
    return config;
  }
}

function intervalMilliseconds(config: LarkSyncScheduleConfig): number {
  const unitMilliseconds =
    config.unit === "minutes" ? 60 * 1_000 : 60 * 60 * 1_000;
  return config.interval * unitMilliseconds;
}

export class PeriodicLarkSyncScheduler {
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private nextRunAt: string | null = null;

  constructor(
    private readonly sync: LarkSyncService,
    private readonly config: LarkSyncScheduleConfigService,
    logger: Logger = nullLogger
  ) {
    this.logger = logger.child({ component: "lark-sync-scheduler" });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.reschedule();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    if (!this.started) return;
    const schedule = this.config.get();
    if (!schedule.enabled) return;
    const delay = intervalMilliseconds(schedule);
    this.nextRunAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => this.trigger(), delay);
    this.timer.unref();
  }

  status(): {
    config: LarkSyncScheduleConfig;
    running: boolean;
    next_run_at: string | null;
  } {
    return {
      config: this.config.get(),
      running: this.started,
      next_run_at: this.nextRunAt
    };
  }

  private trigger(): void {
    this.timer = null;
    this.nextRunAt = null;
    if (!this.started) return;
    const schedule = this.config.get();
    if (!schedule.enabled) return;

    // 先安排下一个固定周期，当前同步过长时，下次触发会明确跳过。
    this.reschedule();
    if (this.sync.getStatus().running) {
      this.logger.info("lark.sync.scheduled.skipped", {
        reason: "sync_already_running"
      });
      return;
    }
    this.logger.info("lark.sync.scheduled.triggered");
    void this.sync.sync().catch((error) => {
      this.logger.error("lark.sync.scheduled.failed", { error });
    });
  }
}

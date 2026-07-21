import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PeriodicLarkSyncScheduler,
  type LarkSyncScheduleConfig,
  type LarkSyncScheduleConfigService
} from "../src/adapters/lark/scheduler";
import type { LarkSyncService } from "../src/adapters/lark/sync";
import { EMPTY_SYNC_STATUS } from "../src/core/types";

describe("PeriodicLarkSyncScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips an occupied interval and triggers on the next interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:00:00.000Z"));
    const schedule: LarkSyncScheduleConfig = {
      enabled: true,
      interval: 1,
      unit: "minutes"
    };
    let running = true;
    let calls = 0;
    const sync = {
      getStatus: () => ({ ...EMPTY_SYNC_STATUS, running }),
      async sync() {
        calls += 1;
        return { ...EMPTY_SYNC_STATUS };
      }
    } as unknown as LarkSyncService;
    const config = {
      get: () => schedule
    } as LarkSyncScheduleConfigService;
    const scheduler = new PeriodicLarkSyncScheduler(sync, config);

    scheduler.start();
    expect(scheduler.status().next_run_at).toBe(
      "2026-07-21T00:01:00.000Z"
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(0);
    expect(scheduler.status().next_run_at).toBe(
      "2026-07-21T00:02:00.000Z"
    );

    running = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
    scheduler.stop();
  });

  it("reschedules immediately after configuration changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:00:00.000Z"));
    const schedule: LarkSyncScheduleConfig = {
      enabled: true,
      interval: 1,
      unit: "hours"
    };
    let calls = 0;
    const sync = {
      getStatus: () => ({ ...EMPTY_SYNC_STATUS }),
      async sync() {
        calls += 1;
        return { ...EMPTY_SYNC_STATUS };
      }
    } as unknown as LarkSyncService;
    const config = {
      get: () => schedule
    } as LarkSyncScheduleConfigService;
    const scheduler = new PeriodicLarkSyncScheduler(sync, config);

    scheduler.start();
    schedule.interval = 30;
    schedule.unit = "minutes";
    scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
    scheduler.stop();
  });
});

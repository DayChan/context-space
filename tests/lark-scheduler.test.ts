import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PeriodicLarkSyncScheduler,
  type LarkSyncScheduleConfig,
  type LarkSyncScheduleConfigService
} from "../src/adapters/lark/scheduler";
import type { LarkSyncService } from "../src/adapters/lark/sync";
import { LarkPermissionPreflightError } from "../src/adapters/lark/permissions";
import { EMPTY_SYNC_STATUS, type LarkPermissionPreflight } from "../src/core/types";

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

  it("keeps scheduling after an initial-sync permission preflight blocks a run", async () => {
    vi.useFakeTimers();
    const schedule: LarkSyncScheduleConfig = {
      enabled: true,
      interval: 1,
      unit: "minutes"
    };
    const preflight: LarkPermissionPreflight = {
      state: "missing_permissions",
      ready: false,
      required_scopes: ["search:message"],
      granted_scopes: [],
      missing_scopes: ["search:message"],
      checked_at: "2026-07-22T00:00:00.000Z",
      initial_sync_completed: false,
      message: "飞书同步缺少必要权限。",
      authorization_command:
        'lark-cli auth login --scope "search:message"'
    };
    let calls = 0;
    const sync = {
      getStatus: () => ({ ...EMPTY_SYNC_STATUS }),
      async sync() {
        calls += 1;
        throw new LarkPermissionPreflightError(preflight);
      }
    } as unknown as LarkSyncService;
    const config = { get: () => schedule } as LarkSyncScheduleConfigService;
    const scheduler = new PeriodicLarkSyncScheduler(sync, config);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
    expect(scheduler.status().running).toBe(true);
    expect(scheduler.status().next_run_at).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);
    scheduler.stop();
  });
});

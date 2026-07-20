import { MachineDatabase } from "./database";
import { decodeJson, encodeJson } from "./json";

export const DEFAULT_SOURCE_RETENTION_DAYS = 90;

export class SettingsRepository {
  constructor(private readonly database: MachineDatabase) {}

  get<T>(key: string): T | null {
    const row = this.database.connection
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(key) as { value_json: string } | undefined;
    return row ? decodeJson<T>(row.value_json) : null;
  }

  set(
    key: string,
    value: unknown,
    timestamp = new Date().toISOString()
  ): void {
    this.database.connection
      .prepare(
        `INSERT INTO settings(key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(key, encodeJson(value), timestamp);
  }

  getSourceRetentionDays(): number {
    const stored = this.get<number>("source_retention_days");
    return Number.isInteger(stored) && stored! > 0
      ? stored!
      : DEFAULT_SOURCE_RETENTION_DAYS;
  }

  setSourceRetentionDays(days: number): void {
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error("来源正文保留天数必须是 1 到 3650 之间的整数");
    }
    this.set("source_retention_days", days);
  }
}

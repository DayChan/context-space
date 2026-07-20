import type { NormalizedSourceRecord, SyncSourceResult } from "../../core/types";
import { LarkCliCommandError, type CommandRunner } from "./runner";
import {
  normalizeCalendar,
  normalizeMessages,
  normalizeSelf,
  normalizeTasks
} from "./normalize";

export type LarkSyncSource = SyncSourceResult["source"];

export interface FetchResult {
  records: NormalizedSourceRecord[];
  result: SyncSourceResult;
  pagination: {
    hasMore: boolean;
    nextPageToken?: string;
  };
}

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function paginationFrom(payload: unknown): FetchResult["pagination"] {
  const root =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const nested =
    root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root;
  const token =
    typeof nested.page_token === "string" && nested.page_token.trim()
      ? nested.page_token
      : undefined;
  return {
    hasMore: nested.has_more === true,
    ...(token ? { nextPageToken: token } : {})
  };
}

export function splitWindows(start: Date, end: Date, windowDays = 7): Array<{ start: Date; end: Date }> {
  if (start >= end) return [];
  const windows: Array<{ start: Date; end: Date }> = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const next = new Date(
      Math.min(end.getTime(), cursor.getTime() + windowDays * 24 * 60 * 60 * 1000)
    );
    windows.push({ start: new Date(cursor), end: next });
    cursor = next;
  }
  return windows;
}

export class LarkAdapter {
  constructor(private readonly runner: CommandRunner) {}

  async fetchSource(
    source: LarkSyncSource,
    start: Date,
    end: Date,
    pageToken?: string
  ): Promise<FetchResult> {
    const baseResult: SyncSourceResult = {
      source,
      ok: false,
      received: 0,
      persisted: 0
    };
    try {
      let payload: unknown;
      let records: NormalizedSourceRecord[];
      if (source === "self") {
        payload = await this.runner.run(["contact", "+get-user"]);
        records = normalizeSelf(payload);
      } else if (source === "mentions") {
        const args = [
          "im",
          "+messages-search",
          "--is-at-me",
          "--start",
          iso(start),
          "--end",
          iso(end),
          "--page-size",
          "50",
          "--page-limit",
          "1",
          "--exclude-sender-type",
          "bot",
          "--no-reactions"
        ];
        if (pageToken) args.push("--page-token", pageToken);
        payload = await this.runner.run(args);
        records = normalizeMessages(payload, "mention");
      } else if (source === "p2p") {
        const args = [
          "im",
          "+messages-search",
          "--chat-type",
          "p2p",
          "--start",
          iso(start),
          "--end",
          iso(end),
          "--page-size",
          "50",
          "--page-limit",
          "1",
          "--exclude-sender-type",
          "bot",
          "--no-reactions"
        ];
        if (pageToken) args.push("--page-token", pageToken);
        payload = await this.runner.run(args);
        records = normalizeMessages(payload, "p2p");
      } else if (source === "calendar") {
        payload = await this.runner.run([
          "calendar",
          "+agenda",
          "--start",
          iso(start),
          "--end",
          iso(end)
        ]);
        records = normalizeCalendar(payload);
      } else {
        payload = await this.runner.run([
          "task",
          "+get-my-tasks",
          "--complete=false",
          "--page-all"
        ]);
        records = normalizeTasks(payload);
      }
      return {
        records,
        pagination:
          source === "mentions" || source === "p2p"
            ? paginationFrom(payload)
            : { hasMore: false },
        result: {
          ...baseResult,
          ok: true,
          received: records.length,
          completed_at: new Date().toISOString()
        }
      };
    } catch (error) {
      const issue = error instanceof LarkCliCommandError ? error.issue : undefined;
      return {
        records: [],
        pagination: { hasMore: false },
        result: {
          ...baseResult,
          error: error instanceof Error ? error.message : String(error),
          ...(issue ? { issue } : {})
        }
      };
    }
  }
}

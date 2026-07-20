import type { NormalizedSourceRecord } from "../core/types";

export interface AnalysisBatch {
  records: NormalizedSourceRecord[];
  sourceCharacters: number;
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function recordSourceCharacters(
  record: NormalizedSourceRecord,
  maxSourceCharacters: number
): number {
  return Math.min(characterCount(record.text), maxSourceCharacters);
}

export function buildAnalysisBatches(
  records: NormalizedSourceRecord[],
  options: {
    maxRecords: number;
    maxSourceCharacters: number;
    maxBatchSourceCharacters: number;
  }
): AnalysisBatch[] {
  const unique = new Map<string, NormalizedSourceRecord>();
  for (const record of records) unique.set(record.sourceId, record);
  const ordered = [...unique.values()].sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.sourceId.localeCompare(right.sourceId)
  );

  const batches: AnalysisBatch[] = [];
  let current: AnalysisBatch = { records: [], sourceCharacters: 0 };
  for (const record of ordered) {
    const characters = recordSourceCharacters(record, options.maxSourceCharacters);
    const exceedsRecords = current.records.length >= options.maxRecords;
    const exceedsCharacters =
      current.records.length > 0 &&
      current.sourceCharacters + characters > options.maxBatchSourceCharacters;
    if (exceedsRecords || exceedsCharacters) {
      batches.push(current);
      current = { records: [], sourceCharacters: 0 };
    }
    current.records.push(record);
    current.sourceCharacters += characters;
  }
  if (current.records.length) batches.push(current);
  return batches;
}

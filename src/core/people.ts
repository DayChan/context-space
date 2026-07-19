import { createHash } from "node:crypto";
import type {
  LeaderConfig,
  NormalizedSourceRecord,
  PersonMetadata,
  PersonObservation,
  TodoMetadata,
  WorkspaceDocument
} from "./types";
import { nowIso } from "./types";

const SENSITIVE_TERMS = [
  "religion",
  "religious",
  "政治",
  "宗教",
  "病史",
  "疾病",
  "性取向",
  "民族",
  "种族"
];

export function personIdForIdentity(provider: string, externalId: string): string {
  const hash = createHash("sha256").update(`${provider}:${externalId}`).digest("hex").slice(0, 16);
  return `person_${hash}`;
}

export function safeObservations(observations: PersonObservation[]): PersonObservation[] {
  return observations.filter(
    (observation) =>
      !SENSITIVE_TERMS.some((term) => observation.text.toLocaleLowerCase().includes(term.toLocaleLowerCase()))
  );
}

export function discoverPeople(records: NormalizedSourceRecord[]): PersonMetadata[] {
  const people = new Map<string, PersonMetadata>();
  for (const record of records) {
    for (const participant of record.participants) {
      if (!participant.provider_id) continue;
      const id = personIdForIdentity(record.provider, participant.provider_id);
      const existing = people.get(id);
      if (existing) {
        existing.updated_at = record.occurredAt;
        existing.last_interaction_at =
          !existing.last_interaction_at || existing.last_interaction_at < record.occurredAt
            ? record.occurredAt
            : existing.last_interaction_at;
        continue;
      }
      people.set(id, {
        schema: "work-context/person@1",
        id,
        type: "person",
        title: participant.name || participant.provider_id,
        managed: "hybrid",
        created_at: nowIso(),
        updated_at: record.occurredAt,
        source_refs: [record.sourceId],
        identities: [
          {
            provider: record.provider,
            external_id: participant.provider_id,
            display_name: participant.name
          }
        ],
        role: null,
        role_origin: null,
        is_leader: false,
        leader_boost: 20,
        observations: [],
        last_interaction_at: record.occurredAt
      });
    }
  }
  return [...people.values()];
}

export function applyLeaderConfiguration(
  person: PersonMetadata,
  leaders: LeaderConfig[]
): PersonMetadata {
  const leader = leaders.find((entry) => entry.person_id === person.id);
  return {
    ...person,
    is_leader: Boolean(leader),
    leader_boost: leader?.boost ?? person.leader_boost
  };
}

export function commitmentsForPerson(
  personId: string,
  todos: Array<WorkspaceDocument<TodoMetadata>>
): {
  owedByMe: Array<WorkspaceDocument<TodoMetadata>>;
  waitingOnThem: Array<WorkspaceDocument<TodoMetadata>>;
  shared: Array<WorkspaceDocument<TodoMetadata>>;
} {
  const relevant = todos.filter(({ data }) => data.stakeholders.includes(personId));
  return {
    owedByMe: relevant.filter(({ data }) => data.direction === "owed_by_me"),
    waitingOnThem: relevant.filter(({ data }) => data.direction === "waiting_on_them"),
    shared: relevant.filter(({ data }) => data.direction === "shared")
  };
}

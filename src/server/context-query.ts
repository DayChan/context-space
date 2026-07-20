import type {
  AnalysisResultRepository,
  MachineContextRepository,
  StoredCandidate,
  StoredSource,
  StoredUpstreamPerson
} from "../machine";
import type {
  BaseMetadata,
  PersonMetadata,
  SearchResult,
  SourceMetadata,
  WorkspaceDocument
} from "../core/types";
import type { ContextIndex } from "../core/index";

const MACHINE_SOURCE_PATH_PREFIX = ".context/machine/sources";
const MACHINE_CANDIDATE_PATH_PREFIX = ".context/machine/candidates";
const UNKNOWN_PERSON_NAMES = new Set([
  "Unknown",
  "Lark user",
  "Direct message partner"
]);

function isUnknownPersonName(
  name: string | null | undefined,
  externalId: string
): boolean {
  return !name || name === externalId || UNKNOWN_PERSON_NAMES.has(name);
}

function sourceDocument(source: StoredSource): WorkspaceDocument<SourceMetadata> {
  return {
    path: `${MACHINE_SOURCE_PATH_PREFIX}/${encodeURIComponent(source.id)}`,
    data: {
      schema: "work-context/source@1",
      id: source.id,
      type: "source",
      title: source.title,
      managed: "generated",
      created_at: source.createdAt,
      updated_at: source.updatedAt,
      source_refs: [],
      provider: "lark",
      source_kind: source.kind,
      source_id: source.externalId,
      occurred_at: source.occurredAt,
      participants: source.participants,
      provider_metadata: {
        ...source.metadata,
        body_purged_at: source.bodyPurgedAt
      }
    },
    body: source.body ?? "",
    etag: source.bodyHash
  };
}

function candidateDocument(
  candidate: StoredCandidate
): WorkspaceDocument<BaseMetadata> {
  return {
    path: `${MACHINE_CANDIDATE_PATH_PREFIX}/${encodeURIComponent(candidate.id)}`,
    data: {
      schema: "work-context/candidate@1",
      id: candidate.id,
      type: "candidate",
      title: candidate.title,
      managed: "generated",
      created_at: candidate.createdAt,
      updated_at: candidate.reviewedAt ?? candidate.createdAt,
      source_refs: candidate.sourceRefs,
      status: candidate.status,
      confidence: candidate.confidence,
      candidate_kind: candidate.kind,
      reason: candidate.reason,
      provider: candidate.provider,
      prompt_version: candidate.promptVersion,
      analyzed_at: candidate.analyzedAt,
      ...candidate.data
    },
    body: candidate.evidence
      .map(({ quote }) => quote)
      .filter(Boolean)
      .join("\n\n"),
    etag: `${candidate.runId}:${candidate.status}:${candidate.reviewedAt ?? ""}`
  };
}

function upstreamPersonDocument(
  person: StoredUpstreamPerson
): WorkspaceDocument<PersonMetadata> {
  return {
    path: `.context/machine/people/${encodeURIComponent(person.personId)}`,
    data: {
      schema: "work-context/person@1",
      id: person.personId,
      type: "person",
      title: person.displayName ?? person.externalId,
      managed: "generated",
      created_at: person.updatedAt,
      updated_at: person.updatedAt,
      source_refs: [],
      identities: [
        {
          provider: person.provider,
          external_id: person.externalId,
          ...(person.displayName ? { display_name: person.displayName } : {})
        }
      ],
      role:
        typeof person.payload.role === "string" ? person.payload.role : null,
      role_origin: null,
      is_leader: false,
      leader_boost: 0,
      observations: [],
      last_interaction_at: null
    },
    body: "",
    etag: person.updatedAt
  };
}

function mergeUpstreamIdentity(
  document: WorkspaceDocument,
  person: StoredUpstreamPerson | undefined
): WorkspaceDocument {
  if (!person || document.data.type !== "person") return document;
  const current = document as WorkspaceDocument<PersonMetadata>;
  const identityKey = `${person.provider}\u0000${person.externalId}`;
  const hasIdentity = current.data.identities.some(
    ({ provider, external_id }) =>
      `${provider}\u0000${external_id}` === identityKey
  );
  const identities = hasIdentity
    ? current.data.identities.map((identity) => {
        if (
          `${identity.provider}\u0000${identity.external_id}` !== identityKey
        ) {
          return identity;
        }
        const { display_name, ...stableIdentity } = identity;
        const resolvedDisplayName =
          person.displayName ??
          (isUnknownPersonName(display_name, person.externalId)
            ? null
            : display_name);
        return {
          ...stableIdentity,
          ...(resolvedDisplayName
            ? { display_name: resolvedDisplayName }
            : {})
        };
      })
    : [
        ...current.data.identities,
        {
          provider: person.provider,
          external_id: person.externalId,
          ...(person.displayName ? { display_name: person.displayName } : {})
        }
      ];
  return {
    ...current,
    data: {
      ...current.data,
      title: isUnknownPersonName(current.data.title, person.externalId)
        ? person.displayName ?? person.externalId
        : current.data.title,
      identities
    }
  };
}

function resultExcerpt(body: string, query: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (!query) return compact.slice(0, 180);
  const position = compact.toLocaleLowerCase().indexOf(query);
  const start = Math.max(0, position < 0 ? 0 : position - 50);
  return compact.slice(start, start + 180);
}

export class ContextQueryService {
  constructor(
    private readonly markdown: ContextIndex,
    private readonly machine: MachineContextRepository,
    private readonly analysis: AnalysisResultRepository
  ) {}

  all(options: {
    type?: string;
    status?: string;
    direction?: string;
  } = {}): WorkspaceDocument[] {
    const includePeople = !options.type || options.type === "person";
    const includeSources = !options.type || options.type === "source";
    const includeCandidates = !options.type || options.type === "candidate";
    const upstreamPeople = includePeople
      ? this.machine.listUpstreamPeople()
      : [];
    const upstreamById = new Map(
      upstreamPeople.map((person) => [person.personId, person])
    );
    const humanDocuments = this.markdown
      .all({ type: options.type, status: options.status })
      .filter(
        ({ data }) =>
          data.type !== "person" ||
          typeof (data as PersonMetadata).related_person_id !== "string"
      )
      .map((document) =>
        mergeUpstreamIdentity(document, upstreamById.get(document.data.id))
      );
    const humanIds = new Set(humanDocuments.map(({ data }) => data.id));
    const candidates = includeCandidates
      ? this.analysis
          .listCandidates(null)
          .filter(({ status }) => status === "proposed" || status === "pending")
          .map(candidateDocument)
      : [];
    return [
      ...humanDocuments,
      ...(includeSources ? this.machine.listSources().map(sourceDocument) : []),
      ...upstreamPeople
        .filter(({ personId }) => !humanIds.has(personId))
        .map(upstreamPersonDocument),
      ...candidates
    ]
      .filter(
        ({ data }) => !options.status || data.status === options.status
      )
      .filter(
        ({ data }) =>
          !options.direction ||
          (data.type === "todo" &&
            (data as { direction?: string }).direction === options.direction)
      );
  }

  byId(id: string): WorkspaceDocument | undefined {
    const humanDocument = this.markdown.byId(id);
    if (humanDocument) {
      const upstreamPerson = this.machine
        .listUpstreamPeople()
        .find(({ personId }) => personId === id);
      return mergeUpstreamIdentity(humanDocument, upstreamPerson);
    }
    const source = this.machine.getSource(id);
    if (source) return sourceDocument(source);
    const upstreamPerson = this.machine
      .listUpstreamPeople()
      .find(({ personId }) => personId === id);
    if (upstreamPerson) return upstreamPersonDocument(upstreamPerson);
    const candidate = this.analysis.getCandidate(id);
    return candidate ? candidateDocument(candidate) : undefined;
  }

  search(query: string, type?: string): SearchResult[] {
    const normalized = query.trim().toLocaleLowerCase();
    const machineResults = this.all()
      .filter(({ path }) => path.startsWith(".context/machine/"))
      .filter(({ data }) => !type || data.type === type)
      .map((document) => {
        const title = document.data.title.toLocaleLowerCase();
        const body = document.body.toLocaleLowerCase();
        const metadata = JSON.stringify(document.data).toLocaleLowerCase();
        let score = normalized ? 0 : 1;
        if (normalized && title.includes(normalized)) score += 8;
        if (normalized && body.includes(normalized)) score += 4;
        if (normalized && metadata.includes(normalized)) score += 2;
        return {
          id: document.data.id,
          path: document.path,
          title: document.data.title,
          type: document.data.type,
          status: document.data.status,
          excerpt: resultExcerpt(document.body, normalized),
          score,
          source_refs: document.data.source_refs
        };
      })
      .filter(({ score }) => score > 0);
    return [...this.markdown.search(query, type), ...machineResults].sort(
      (left, right) =>
        right.score - left.score || left.title.localeCompare(right.title)
    );
  }
}

import type { MarkdownStore } from "../core/markdown-store";
import { createTodoMetadata } from "../core/todo";
import {
  nowIso,
  type BaseMetadata,
  type KnowledgeKind,
  type KnowledgeMetadata,
  type PersonMetadata
} from "../core/types";
import {
  AnalysisResultRepository,
  type AcceptanceOperation,
  type StoredCandidate
} from "../machine";

export interface AutomaticPublicationResult {
  operations: AcceptanceOperation[];
  failures: Array<{ candidateId: string; error: string }>;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 140);
}

function documentIdentity(candidate: StoredCandidate): {
  id: string;
  path: string;
} {
  const id = `${candidate.kind}_${safeSegment(candidate.id)}`;
  if (candidate.kind === "todo") {
    return { id, path: `todos/items/${id}.md` };
  }
  if (candidate.kind === "knowledge") {
    const kind =
      typeof candidate.data.knowledge_kind === "string"
        ? candidate.data.knowledge_kind
        : "draft";
    const directories: Record<string, string> = {
      project: "projects",
      decision: "decisions",
      playbook: "playbooks",
      concept: "concepts",
      glossary: "glossary",
      draft: "drafts"
    };
    const directory = directories[kind] ?? "drafts";
    return { id, path: `knowledge/${directory}/${id}.md` };
  }
  return { id, path: `people/${id}.md` };
}

function evidenceBody(candidate: StoredCandidate): string {
  return [
    `# ${candidate.title}`,
    "",
    candidate.kind === "knowledge" &&
    typeof candidate.data.summary === "string"
      ? candidate.data.summary
      : "",
    "",
    "## 已确认依据",
    "",
    ...candidate.evidence.map(
      ({ sourceId, quote }) => `- \`${sourceId}\`：${quote}`
    )
  ]
    .filter((line, index, lines) => line || lines[index - 1] !== "")
    .join("\n");
}

function documentMetadata(
  candidate: StoredCandidate,
  id: string
): BaseMetadata {
  const timestamp = nowIso();
  const shared = {
    id,
    title: candidate.title,
    managed: "manual" as const,
    created_at: timestamp,
    updated_at: timestamp,
    source_refs: [...candidate.sourceRefs],
    confidence: candidate.confidence,
    candidate_id: candidate.id,
    accepted_at: timestamp
  };
  if (candidate.kind === "todo") {
    return {
      ...createTodoMetadata({
        id,
        title: candidate.title,
        type: "todo",
        status: "open",
        direction:
          candidate.data.direction === "waiting_on_them" ||
          candidate.data.direction === "shared"
            ? candidate.data.direction
            : "owed_by_me",
        stakeholders: Array.isArray(candidate.data.stakeholders)
          ? candidate.data.stakeholders.filter(
              (value): value is string => typeof value === "string"
            )
          : [],
        due_at:
          typeof candidate.data.due_at === "string"
            ? candidate.data.due_at
            : null,
        explicit: candidate.data.explicit === true,
        upstream: "extracted_context",
        managed: "manual",
        source_refs: candidate.sourceRefs,
        confidence: candidate.confidence
      }),
      candidate_id: candidate.id,
      accepted_at: timestamp
    };
  }
  if (candidate.kind === "knowledge") {
    const knowledgeKind =
      typeof candidate.data.knowledge_kind === "string"
        ? (candidate.data.knowledge_kind as KnowledgeKind)
        : "draft";
    return {
      schema: "work-context/knowledge@1",
      type: "knowledge",
      ...shared,
      status: "curated",
      knowledge_kind: knowledgeKind,
      curation_state: "curated",
      superseded_by: null,
      tags: Array.isArray(candidate.data.tags)
        ? candidate.data.tags.filter(
            (value): value is string => typeof value === "string"
          )
        : []
    } satisfies KnowledgeMetadata;
  }
  const personId =
    typeof candidate.data.person_id === "string"
      ? candidate.data.person_id
      : id;
  return {
    schema: "work-context/person@1",
    type: "person",
    ...shared,
    related_person_id: personId,
    identities: [],
    role: null,
    role_origin: null,
    is_leader: false,
    leader_boost: 0,
    observations: [
      {
        text:
          typeof candidate.data.text === "string"
            ? candidate.data.text
            : candidate.title,
        evidence: candidate.evidence.map(({ quote }) => quote),
        confidence: candidate.confidence,
        observed_at: timestamp,
        origin: "manual",
        category:
          typeof candidate.data.category === "string"
            ? (candidate.data.category as
                | "responsibility"
                | "communication_style"
                | "collaboration_style"
                | "work_preference")
            : undefined,
        source_refs: candidate.sourceRefs
      }
    ],
    last_interaction_at: null
  } satisfies PersonMetadata;
}

export class CandidateReviewService {
  constructor(
    private readonly results: AnalysisResultRepository,
    private readonly store: MarkdownStore,
    private readonly onMaterialized: (path: string) => Promise<void> = async () => {}
  ) {}

  list(status: StoredCandidate["status"] | null = "proposed") {
    return this.results.listCandidates(status);
  }

  get(id: string) {
    return this.results.getCandidate(id);
  }

  reject(id: string) {
    return this.results.rejectCandidate(id);
  }

  async accept(candidateId: string): Promise<AcceptanceOperation> {
    const candidate = this.results.getCandidate(candidateId);
    if (!candidate) throw new Error(`候选不存在：${candidateId}`);
    const identity = documentIdentity(candidate);
    let operation = this.results.beginAcceptance({
      candidateId,
      documentId: identity.id,
      documentPath: identity.path
    });
    if (operation.state === "accepted" || operation.state === "conflict") {
      return operation;
    }
    operation = await this.materialize(candidate, operation);
    if (operation.state === "conflict") return operation;
    await this.onMaterialized(operation.documentPath);
    return this.results.markAccepted(candidateId);
  }

  async publishWithoutReview(
    candidateIds?: string[]
  ): Promise<AutomaticPublicationResult> {
    const candidates = candidateIds
      ? candidateIds.flatMap((id) => {
          const candidate = this.results.getCandidate(id);
          return candidate ? [candidate] : [];
        })
      : this.results.listCandidates("proposed");
    const operations: AcceptanceOperation[] = [];
    const failures: AutomaticPublicationResult["failures"] = [];
    for (const candidate of candidates) {
      if (candidate.kind === "knowledge" || candidate.status !== "proposed") {
        continue;
      }
      try {
        operations.push(await this.accept(candidate.id));
      } catch (error) {
        failures.push({
          candidateId: candidate.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { operations, failures };
  }

  async recover(): Promise<AcceptanceOperation[]> {
    const recovered: AcceptanceOperation[] = [];
    for (const operation of this.results.recoverableAcceptances()) {
      const candidate = this.results.getCandidate(operation.candidateId);
      if (!candidate) {
        recovered.push(
          this.results.markAcceptanceConflict(
            operation.candidateId,
            "接受操作引用的候选不存在"
          )
        );
        continue;
      }
      const materialized = await this.materialize(candidate, operation);
      if (materialized.state === "conflict") {
        recovered.push(materialized);
        continue;
      }
      await this.onMaterialized(materialized.documentPath);
      recovered.push(this.results.markAccepted(operation.candidateId));
    }
    return recovered;
  }

  private async materialize(
    candidate: StoredCandidate,
    operation: AcceptanceOperation
  ): Promise<AcceptanceOperation> {
    if (await this.store.exists(operation.documentPath)) {
      const existing = await this.store.read(operation.documentPath);
      if (
        existing.data.id !== operation.documentId ||
        existing.data.candidate_id !== candidate.id
      ) {
        return this.results.markAcceptanceConflict(
          candidate.id,
          "确定性 Markdown 路径已被其他文档占用"
        );
      }
      return this.results.markMaterialized(candidate.id, existing.etag);
    }
    const saved = await this.store.write(
      operation.documentPath,
      documentMetadata(candidate, operation.documentId),
      evidenceBody(candidate),
      { createOnly: true }
    );
    return this.results.markMaterialized(candidate.id, saved.etag);
  }
}

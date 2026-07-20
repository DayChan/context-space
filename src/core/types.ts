export type ManagementMode = "generated" | "manual" | "hybrid";

export type DocumentType =
  | "config"
  | "source"
  | "todo"
  | "person"
  | "knowledge"
  | "summary"
  | "candidate"
  | "sync-status"
  | "analysis-run"
  | "analysis-status"
  | "loop-policy";

export interface AnalysisProvenance {
  run_id: string;
  item_key: string;
  provider: string;
  prompt_version: string;
  schema_version: string;
  analyzed_at: string;
  evidence: string[];
  reason: string;
  stale?: boolean;
  superseded_at?: string;
}

export interface BaseMetadata {
  [key: string]: unknown;
  schema: string;
  id: string;
  type: DocumentType;
  title: string;
  managed: ManagementMode;
  created_at: string;
  updated_at: string;
  source_refs: string[];
  confidence?: number;
  status?: string;
  analysis?: AnalysisProvenance;
}

export interface AutomationConfig {
  mode: "disabled" | "suggest" | "approved";
  handler: string | null;
  requires_confirmation: boolean;
  allowed_capabilities: string[];
  blocked_reason?: string;
}

export interface PriorityReason {
  key: "due-overdue" | "due-soon" | "explicit" | "stale" | "leader" | "leader-follow-up";
  label: string;
  value: number;
}

export interface TodoPriority {
  base: number;
  manual: number | null;
  effective: number;
  reasons: PriorityReason[];
}

export type TodoDirection = "owed_by_me" | "waiting_on_them" | "shared";
export type TodoStatus = "candidate" | "open" | "in_progress" | "waiting" | "done" | "dismissed";

export interface TodoMetadata extends BaseMetadata {
  type: "todo" | "candidate";
  status: TodoStatus;
  direction: TodoDirection;
  owner: "self" | string;
  stakeholders: string[];
  due_at: string | null;
  explicit: boolean;
  upstream: "lark_task" | "extracted_context" | "manual";
  priority: TodoPriority;
  automation: AutomationConfig;
}

export interface PersonIdentity {
  provider: string;
  external_id: string;
  display_name?: string;
}

export interface PersonObservation {
  text: string;
  evidence: string[];
  confidence: number;
  observed_at: string;
  origin: "manual" | "inferred";
}

export interface PersonMetadata extends BaseMetadata {
  type: "person";
  identities: PersonIdentity[];
  role: string | null;
  role_origin: "directory" | "manual" | "inferred" | null;
  is_leader: boolean;
  leader_boost: number;
  observations: PersonObservation[];
  last_interaction_at: string | null;
}

export type KnowledgeKind = "project" | "decision" | "playbook" | "concept" | "glossary" | "draft";

export interface KnowledgeMetadata extends BaseMetadata {
  type: "knowledge" | "candidate";
  knowledge_kind: KnowledgeKind;
  curation_state: "draft" | "curated" | "stale" | "superseded";
  superseded_by: string | null;
  tags: string[];
}

export type SourceKind = "mention" | "p2p" | "calendar" | "task" | "person";

export interface SourceParticipant {
  provider_id: string;
  name: string;
  role?: "sender" | "partner" | "attendee" | "assignee" | "creator" | "mentioned";
}

export interface NormalizedSourceRecord {
  sourceId: string;
  provider: "lark";
  kind: SourceKind;
  title: string;
  text: string;
  occurredAt: string;
  participants: SourceParticipant[];
  metadata: Record<string, unknown>;
}

export interface SourceMetadata extends BaseMetadata {
  type: "source";
  provider: "lark";
  source_kind: SourceKind;
  source_id: string;
  occurred_at: string;
  participants: SourceParticipant[];
  provider_metadata: Record<string, unknown>;
}

export interface WorkspaceDocument<T extends BaseMetadata = BaseMetadata> {
  path: string;
  data: T;
  body: string;
  etag: string;
}

export interface SearchResult {
  id: string;
  path: string;
  title: string;
  type: DocumentType;
  status?: string;
  excerpt: string;
  score: number;
  source_refs: string[];
}

export interface LeaderConfig {
  person_id: string;
  boost: number;
}

export interface SyncSourceResult {
  source: "self" | "mentions" | "p2p" | "calendar" | "tasks";
  ok: boolean;
  received: number;
  persisted: number;
  analyzed?: number;
  analysis_failed?: number;
  error?: string;
  completed_at?: string;
}

export interface SyncStatus {
  running: boolean;
  started_at: string | null;
  completed_at: string | null;
  results: SyncSourceResult[];
  last_error: string | null;
}

export interface LoopReadiness {
  futureAutomatable: TodoMetadata[];
  confirmationRequired: TodoMetadata[];
  blocked: TodoMetadata[];
  recentRuns: never[];
}

export interface Overview {
  topTodos: TodoMetadata[];
  upcomingCalendar: SourceMetadata[];
  recentMentions: SourceMetadata[];
  waitingItems: TodoMetadata[];
  reviewCandidates: BaseMetadata[];
  knowledgeChanges: KnowledgeMetadata[];
  loopReadiness: LoopReadiness;
  syncStatus: SyncStatus;
  counts: {
    todos: number;
    people: number;
    knowledge: number;
    inbox: number;
  };
}

export const DEFAULT_AUTOMATION: AutomationConfig = {
  mode: "disabled",
  handler: null,
  requires_confirmation: true,
  allowed_capabilities: []
};

export const EMPTY_SYNC_STATUS: SyncStatus = {
  running: false,
  started_at: null,
  completed_at: null,
  results: [],
  last_error: null
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

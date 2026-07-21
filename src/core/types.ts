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

export type PersonInsightCategory =
  | "responsibility"
  | "communication_style"
  | "collaboration_style"
  | "work_preference";

export interface PersonObservation {
  text: string;
  evidence: string[];
  confidence: number;
  observed_at: string;
  origin: "manual" | "inferred";
  category?: PersonInsightCategory;
  source_refs?: string[];
  insight_key?: string;
  stale?: boolean;
  superseded_at?: string;
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

export type SourceProvider = "lark" | "meegle";

export type SourceKind =
  | "mention"
  | "p2p"
  | "calendar"
  | "task"
  | "person"
  | "meego";

export interface SourceParticipant {
  provider_id: string;
  name: string;
  role?: "sender" | "partner" | "attendee" | "assignee" | "creator" | "mentioned";
}

export interface NormalizedSourceRecord {
  sourceId: string;
  provider: SourceProvider;
  kind: SourceKind;
  title: string;
  text: string;
  occurredAt: string;
  participants: SourceParticipant[];
  metadata: Record<string, unknown>;
}

export interface SourceMetadata extends BaseMetadata {
  type: "source";
  provider: SourceProvider;
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
  issue?: LarkSyncIssue;
  completed_at?: string;
}

export type LarkSyncIssueKind =
  | "installation"
  | "permission"
  | "authentication"
  | "invalid_parameters"
  | "command";

export interface LarkCliUpdateNotice {
  command: string;
  current?: string;
  latest?: string;
  message?: string;
}

export interface LarkSyncIssue {
  kind: LarkSyncIssueKind;
  requires_action: boolean;
  message: string;
  type?: string;
  subtype?: string;
  code?: string | number;
  missing_scopes?: string[];
  hint?: string;
  console_url?: string;
  log_id?: string;
  troubleshooter?: string;
  update?: LarkCliUpdateNotice;
}

export interface SyncStatus {
  running: boolean;
  started_at: string | null;
  completed_at: string | null;
  results: SyncSourceResult[];
  last_error: string | null;
  progress: SyncProgress | null;
}

export type SyncPhase =
  | "collecting"
  | "analyzing"
  | "completed"
  | "failed";

export interface SyncProgress {
  phase: SyncPhase;
  source: SyncSourceResult["source"] | null;
  window_index: number | null;
  window_count: number | null;
  page_index: number | null;
  received: number;
  persisted: number;
  message: string;
  updated_at: string;
}

export interface MeegoConfig {
  enabled: boolean;
  qTagTimelineEnabled: boolean;
  projectKeys: string[];
}

export interface ParsedQTag {
  raw: string;
  quarter: number;
  month: number;
  day: number;
  sortKey: number;
}

export interface MeegoItem {
  id: string;
  title: string;
  projectKey: string;
  projectName: string;
  workItemType: string;
  workItemTypeName: string;
  workItemId: string;
  updatedAt: string;
  tags: string[];
  qTags: ParsedQTag[];
  primaryQTag: ParsedQTag | null;
  completed: boolean;
  url: string | null;
}

export interface MeegoGroup {
  qTag: ParsedQTag;
  items: MeegoItem[];
}

export interface MeegoList {
  mode: "q_tag_time" | "updated_at";
  items: MeegoItem[];
  groups: MeegoGroup[];
}

export interface MeegoSyncResult {
  projectKey: string;
  workItemType: string | null;
  ok: boolean;
  skipped?: boolean;
  received: number;
  persisted: number;
  message?: string;
  error?: string;
  completedAt?: string;
}

export interface MeegoSyncStatus {
  enabled: boolean;
  running: boolean;
  startedAt: string | null;
  completedAt: string | null;
  results: MeegoSyncResult[];
  lastError: string | null;
}

export type AgentWorkspaceMode = "read_only" | "isolated_worktree";
export type AgentWorkflowKind = "direct" | "openspec";
export type AgentSessionStatus = "active" | "completed" | "cancelled" | "failed";
export type AgentAttention =
  | "none"
  | "confirmation_required"
  | "reply_required"
  | "review_required";
export type AgentTurnStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export type AgentOutcome =
  | "completed"
  | "needs_confirmation"
  | "awaiting_reply"
  | "blocked";

export interface AgentRepository {
  id: string;
  name: string;
  path: string;
  kind: "git" | "directory";
  headCommit: string | null;
  branch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  turnId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface AgentEvent {
  id: string;
  sequence: number;
  sessionId: string;
  turnId: string | null;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AgentTurn {
  id: string;
  sessionId: string;
  inputMessageId: string;
  status: AgentTurnStatus;
  outcome: AgentOutcome | null;
  usage: Record<string, number> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AgentConfirmation {
  id: string;
  sessionId: string;
  turnId: string | null;
  kind:
    | "decision"
    | "action_approval"
    | "completion_review"
    | "workspace_upgrade"
    | "workspace_cleanup";
  question: string;
  options: string[];
  status: "pending" | "answered" | "approved" | "rejected" | "expired";
  answer: { selection?: string; text?: string } | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface AgentSession {
  id: string;
  title: string;
  sourceKind: "todo" | "meego";
  sourceId: string;
  repositoryId: string;
  repository?: AgentRepository;
  mode: AgentWorkspaceMode;
  workflowKind: AgentWorkflowKind;
  workspacePath: string;
  branch: string | null;
  baseCommit: string | null;
  threadId: string | null;
  status: AgentSessionStatus;
  attention: AgentAttention;
  workspaceLifecycle: "ready" | "retained" | "removed";
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  messages?: AgentMessage[];
  turns?: AgentTurn[];
  events?: AgentEvent[];
  confirmations?: AgentConfirmation[];
}

export interface OpenSpecReadiness {
  initialized: boolean;
  skillsReady: boolean;
  ready: boolean;
  missing: string[];
}

export interface OpenSpecChangeSummary {
  name: string;
  completedTasks: number;
  totalTasks: number;
  status: string;
  lastModified: string;
}

export interface OpenSpecWorkflowNode {
  id: string;
  description: string;
  outputPath: string;
  requires: string[];
  status: "done" | "ready" | "blocked";
  missingDeps: string[];
}

export interface OpenSpecWorkflow {
  changeName: string;
  schemaName: string;
  relativePath: string;
  isComplete: boolean;
  nodes: OpenSpecWorkflowNode[];
}

export const EMPTY_MEEGO_SYNC_STATUS: MeegoSyncStatus = {
  enabled: false,
  running: false,
  startedAt: null,
  completedAt: null,
  results: [],
  lastError: null
};

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
  upstreamTasks: SourceMetadata[];
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
  last_error: null,
  progress: null
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

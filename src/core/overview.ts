import type {
  BaseMetadata,
  KnowledgeMetadata,
  LeaderConfig,
  LoopReadiness,
  Overview,
  SourceMetadata,
  SyncStatus,
  TodoMetadata,
  WorkspaceDocument
} from "./types";
import { calculatePriority } from "./todo";
import { EMPTY_SYNC_STATUS } from "./types";

function byUpdatedDescending(left: BaseMetadata, right: BaseMetadata): number {
  return right.updated_at.localeCompare(left.updated_at);
}

export function buildLoopReadiness(todos: TodoMetadata[]): LoopReadiness {
  return {
    futureAutomatable: todos.filter((todo) => todo.automation?.mode === "approved"),
    confirmationRequired: todos.filter(
      (todo) => todo.automation?.mode === "suggest" && todo.automation.requires_confirmation
    ),
    blocked: todos.filter((todo) => Boolean(todo.automation?.blocked_reason)),
    recentRuns: []
  };
}

export function buildOverview(
  documents: WorkspaceDocument[],
  leaders: LeaderConfig[] = [],
  syncStatus: SyncStatus = EMPTY_SYNC_STATUS,
  clock = new Date()
): Overview {
  const todos = documents
    .filter((document): document is WorkspaceDocument<TodoMetadata> => document.data.type === "todo")
    .map((document) => ({
      ...document.data,
      priority: calculatePriority(document.data, leaders, clock)
    }));
  const candidates = documents
    .filter((document) => document.data.type === "candidate")
    .map((document) => document.data)
    .sort(byUpdatedDescending);
  const people = documents.filter((document) => document.data.type === "person");
  const knowledge = documents
    .filter(
      (document): document is WorkspaceDocument<KnowledgeMetadata> =>
        document.data.type === "knowledge"
    )
    .map((document) => document.data)
    .sort(byUpdatedDescending);
  const sources = documents
    .filter(
      (document): document is WorkspaceDocument<SourceMetadata> => document.data.type === "source"
    )
    .map((document) => document.data);

  const topTodos = todos
    .filter((todo) => ["open", "in_progress"].includes(todo.status) && todo.direction !== "waiting_on_them")
    .sort((left, right) => right.priority.effective - left.priority.effective)
    .slice(0, 8);
  const now = clock.getTime();
  const horizon = now + 24 * 60 * 60 * 1000;

  return {
    topTodos,
    upcomingCalendar: sources
      .filter(
        (source) =>
          source.source_kind === "calendar" &&
          new Date(source.occurred_at).getTime() >= now &&
          new Date(source.occurred_at).getTime() <= horizon
      )
      .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at)),
    recentMentions: sources
      .filter((source) => source.source_kind === "mention")
      .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))
      .slice(0, 8),
    upstreamTasks: sources
      .filter((source) => source.source_kind === "task")
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, 8),
    waitingItems: todos
      .filter((todo) => todo.direction === "waiting_on_them" && !["done", "dismissed"].includes(todo.status))
      .sort((left, right) => right.priority.effective - left.priority.effective),
    reviewCandidates: candidates.slice(0, 8),
    knowledgeChanges: knowledge.slice(0, 8),
    loopReadiness: buildLoopReadiness(todos),
    syncStatus,
    counts: {
      todos: todos.length,
      people: people.length,
      knowledge: knowledge.length,
      inbox: candidates.length
    }
  };
}

export function buildTimeline(documents: WorkspaceDocument[]): SourceMetadata[] {
  return documents
    .filter(
      (document): document is WorkspaceDocument<SourceMetadata> =>
        document.data.type === "source" &&
        (document.data as SourceMetadata).source_kind === "calendar"
    )
    .map((document) => document.data)
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
}

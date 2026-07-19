import type {
  AutomationConfig,
  LeaderConfig,
  PriorityReason,
  TodoMetadata,
  TodoPriority,
  WorkspaceDocument
} from "./types";
import { DEFAULT_AUTOMATION, nowIso } from "./types";

export function defaultAutomation(value?: Partial<AutomationConfig>): AutomationConfig {
  return {
    ...DEFAULT_AUTOMATION,
    ...value,
    allowed_capabilities: value?.allowed_capabilities ?? []
  };
}

export function calculatePriority(
  todo: Pick<
    TodoMetadata,
    "direction" | "stakeholders" | "due_at" | "explicit" | "updated_at" | "priority"
  >,
  leaders: LeaderConfig[],
  clock = new Date()
): TodoPriority {
  const base = Number.isFinite(todo.priority?.base) ? todo.priority.base : 50;
  const manual = Number.isFinite(todo.priority?.manual) ? todo.priority.manual : null;
  const reasons: PriorityReason[] = [];

  if (todo.due_at) {
    const remaining = new Date(todo.due_at).getTime() - clock.getTime();
    if (remaining < 0) {
      reasons.push({ key: "due-overdue", label: "已逾期", value: 30 });
    } else if (remaining <= 24 * 60 * 60 * 1000) {
      reasons.push({ key: "due-soon", label: "24 小时内到期", value: 25 });
    } else if (remaining <= 72 * 60 * 60 * 1000) {
      reasons.push({ key: "due-soon", label: "3 天内到期", value: 15 });
    }
  }

  if (todo.explicit) reasons.push({ key: "explicit", label: "明确指派", value: 10 });

  const age = clock.getTime() - new Date(todo.updated_at).getTime();
  if (age >= 7 * 24 * 60 * 60 * 1000) {
    reasons.push({ key: "stale", label: "超过 7 天未推进", value: 5 });
  }

  const matchedLeader = leaders.find((leader) => todo.stakeholders.includes(leader.person_id));
  if (matchedLeader && todo.direction === "owed_by_me") {
    reasons.push({ key: "leader", label: "Leader 相关交付", value: matchedLeader.boost });
  } else if (matchedLeader && todo.direction === "waiting_on_them") {
    reasons.push({
      key: "leader-follow-up",
      label: "Leader 相关跟进",
      value: Math.min(8, matchedLeader.boost)
    });
  }

  const automatic = Math.max(0, Math.min(100, base + reasons.reduce((sum, reason) => sum + reason.value, 0)));
  return {
    base,
    manual,
    effective: manual ?? automatic,
    reasons
  };
}

export function createTodoMetadata(
  input: Partial<TodoMetadata> & Pick<TodoMetadata, "id" | "title">
): TodoMetadata {
  const timestamp = nowIso();
  const provisional: TodoMetadata = {
    schema: "work-context/todo@1",
    id: input.id,
    type: input.type ?? "todo",
    title: input.title,
    managed: input.managed ?? "hybrid",
    created_at: input.created_at ?? timestamp,
    updated_at: input.updated_at ?? timestamp,
    source_refs: input.source_refs ?? [],
    confidence: input.confidence ?? 1,
    status: input.status ?? "open",
    direction: input.direction ?? "owed_by_me",
    owner: input.owner ?? "self",
    stakeholders: input.stakeholders ?? [],
    due_at: input.due_at ?? null,
    explicit: input.explicit ?? false,
    upstream: input.upstream ?? "manual",
    priority: input.priority ?? { base: 50, manual: null, effective: 50, reasons: [] },
    automation: defaultAutomation(input.automation)
  };
  provisional.priority = calculatePriority(provisional, []);
  return provisional;
}

export function activeExecutionTodos(
  documents: Array<WorkspaceDocument<TodoMetadata>>
): Array<WorkspaceDocument<TodoMetadata>> {
  return documents.filter(
    ({ data }) =>
      ["open", "in_progress"].includes(data.status) && data.direction !== "waiting_on_them"
  );
}

import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  Clock3,
  FileText,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Menu,
  Plus,
  Play,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Users,
  X
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import {
  BrowserRouter,
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams
} from "react-router-dom";
import type {
  BaseMetadata,
  AgentRepository,
  AgentSession,
  AgentWorkspaceMode,
  KnowledgeMetadata,
  LeaderConfig,
  LoopReadiness,
  MeegoConfig,
  MeegoItem,
  MeegoList,
  MeegoSyncStatus,
  Overview,
  PersonInsightCategory,
  PersonMetadata,
  SearchResult,
  SourceMetadata,
  SyncStatus,
  TodoMetadata,
  WorkspaceDocument
} from "../core/types";
import { EMPTY_MEEGO_SYNC_STATUS } from "../core/types";
import type {
  AnalysisConfig,
  AnalysisRunMetadata,
  AnalysisStatusMetadata,
  ProviderAvailability
} from "../analysis/contracts";
import { CODEX_REASONING_EFFORTS } from "../analysis/contracts";
import type {
  AcceptanceOperation,
  AnalysisJob,
  AnalysisJobStatus,
  MarkdownDiagnostic,
  StoredCandidate
} from "../machine";
import { EMPTY_SYNC_STATUS } from "../core/types";
import { api } from "./api";
import { useApi } from "./hooks";
import "./styles.css";

interface ApiDocument<T extends BaseMetadata = BaseMetadata> extends WorkspaceDocument<T> {
  provenanceSources?: Array<{
    id: string;
    provider: string;
    title: string;
    body: string | null;
    occurred_at: string;
    source_kind: SourceMetadata["source_kind"];
    body_purged_at?: string | null;
    conversation: {
      type: "direct" | "group";
      name: string;
    } | null;
    sender: {
      person_id: string;
      display_name: string;
    } | null;
  }>;
  provenancePagination?: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
  relationships?: {
    owedByMe: TodoMetadata[];
    waitingOnThem: TodoMetadata[];
    shared: TodoMetadata[];
  };
  acceptedInsights?: Array<{
    id: string;
    title: string;
    path: string;
    observations: PersonMetadata["observations"];
  }>;
  backlinks?: BaseMetadata[];
}

type AnalysisQueueCounts = Record<AnalysisJobStatus, number>;

interface OverviewResponse extends Overview {
  analysisQueue: AnalysisQueueCounts;
}

interface MarkdownSyncStatus {
  watcherRunning: boolean;
  lastReconciledAt: string | null;
  lastIncrementalAt: string | null;
  reconcileMilliseconds: number;
}

interface ReviewCandidate extends StoredCandidate {
  acceptance: AcceptanceOperation | null;
}

const emptyOverview: Overview = {
  topTodos: [],
  upcomingCalendar: [],
  recentMentions: [],
  upstreamTasks: [],
  waitingItems: [],
  reviewCandidates: [],
  knowledgeChanges: [],
  loopReadiness: {
    futureAutomatable: [],
    confirmationRequired: [],
    blocked: [],
    recentRuns: []
  },
  syncStatus: EMPTY_SYNC_STATUS,
  counts: { todos: 0, people: 0, knowledge: 0, inbox: 0 }
};

const emptyAnalysisQueue: AnalysisQueueCounts = {
  queued: 0,
  leased: 0,
  succeeded: 0,
  failed_retryable: 0,
  failed_terminal: 0
};

const navigation = [
  { to: "/", label: "Now", icon: LayoutDashboard },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/todos", label: "Todos", icon: ListTodo },
  { to: "/people", label: "People", icon: Users },
  { to: "/knowledge", label: "Knowledge", icon: BookOpen },
  { to: "/timeline", label: "Timeline", icon: Activity },
  { to: "/meego", label: "Meego", icon: ListTodo },
  { to: "/loop", label: "Loop", icon: Bot },
  { to: "/settings", label: "Settings", icon: Settings }
] as const;

const observationCategoryLabels: Record<PersonInsightCategory, string> = {
  responsibility: "职责",
  communication_style: "沟通方式",
  collaboration_style: "协作方式",
  work_preference: "工作偏好"
};

function formatDate(value: string | null | undefined, withTime = true): string {
  if (!value) return "未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {})
  }).format(date);
}

function statusLabel(status: string | undefined): string {
  const labels: Record<string, string> = {
    open: "待处理",
    in_progress: "进行中",
    waiting: "等待中",
    done: "已完成",
    candidate: "待确认",
    dismissed: "已忽略",
    draft: "草稿"
  };
  return status ? labels[status] ?? status : "—";
}

const larkSourceLabels: Record<SyncStatus["results"][number]["source"], string> = {
  self: "当前用户",
  mentions: "群聊提及",
  p2p: "P2P 消息",
  calendar: "日历",
  tasks: "任务"
};

function safeExternalUrl(value: string | undefined): string | null {
  const candidate = value?.match(/https?:\/\/[^\s]+/)?.[0]?.replace(/[),，。]+$/, "");
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function usePageTitle(): string {
  const location = useLocation();
  return (
    navigation.find(({ to }) => (to === "/" ? location.pathname === "/" : location.pathname.startsWith(to)))
      ?.label ?? "Search"
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const title = usePageTitle();

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const normalized = query.trim();
    if (normalized) navigate(`/search?q=${encodeURIComponent(normalized)}`);
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">C</div>
          <div>
            <strong>Context Space</strong>
            <span>Markdown work OS</span>
          </div>
          <button className="icon-button mobile-close" onClick={() => setMenuOpen(false)} aria-label="关闭导航">
            <X size={18} />
          </button>
        </div>

        <nav aria-label="主导航">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {label === "Loop" && <span className="nav-pill">V1</span>}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="local-status">
            <span className="status-dot" />
            <div>
              <strong>Local workspace</strong>
              <span>Markdown is canonical</span>
            </div>
          </div>
          <div className="privacy-note">
            <ShieldCheck size={15} />
            <span>Loop execution disabled</span>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMenuOpen(true)} aria-label="打开导航">
            <Menu size={20} />
          </button>
          <div className="topbar-title">
            <span>Workspace</span>
            <strong>{title}</strong>
          </div>
          <form className="global-search" onSubmit={submitSearch}>
            <Search size={17} />
            <input
              aria-label="全局搜索"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 Todo、人物和知识…"
            />
            <kbd>↵</kbd>
          </form>
          <Link className="avatar" to="/people" aria-label="人物档案">
            <CircleUserRound size={20} />
          </Link>
        </header>
        <div className="page-container">{children}</div>
      </main>
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  action
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  return message ? <div className="error-banner">{message}</div> : null;
}

function LarkSyncIssues({ status }: { status: SyncStatus }) {
  const failed = status.results.filter((result) => !result.ok);
  if (!failed.length) return null;
  return (
    <div className="lark-issue-list" aria-label="飞书同步问题">
      {failed.map((result) => {
        const issue = result.issue;
        const consoleUrl = safeExternalUrl(issue?.console_url);
        const troubleshooter = safeExternalUrl(issue?.troubleshooter);
        const title =
          issue?.kind === "permission"
            ? "需要处理飞书权限"
            : issue?.kind === "authentication"
              ? "需要重新认证飞书"
              : issue?.kind === "invalid_parameters"
                ? "飞书请求参数错误"
                : "来源同步失败";
        return (
          <div
            className={`lark-issue ${issue?.requires_action ? "requires-action" : ""}`}
            key={result.source}
          >
            <div className="lark-issue-head">
              <AlertTriangle size={16} />
              <div>
                <strong>{larkSourceLabels[result.source]} · {title}</strong>
                <span>{result.error ?? issue?.message ?? "未知错误"}</span>
              </div>
              <Badge tone={issue?.requires_action ? "amber" : "coral"}>
                {issue?.requires_action ? "需要处理" : "失败"}
              </Badge>
            </div>
            {issue?.missing_scopes?.length ? (
              <p>缺失 scope：<code>{issue.missing_scopes.join(" / ")}</code></p>
            ) : null}
            {issue?.hint ? <p>处理提示：<code>{issue.hint}</code></p> : null}
            {issue?.log_id ? <p>飞书日志 ID：<code>{issue.log_id}</code></p> : null}
            {issue?.update ? (
              <p>
                lark-cli {issue.update.current ?? "当前版本"} → {issue.update.latest ?? "新版本"}：
                <code>{issue.update.command}</code>
              </p>
            ) : null}
            {(consoleUrl || troubleshooter) && (
              <div className="lark-issue-links">
                {consoleUrl && (
                  <a href={consoleUrl} rel="noreferrer" target="_blank">
                    打开飞书权限配置 <ArrowUpRight size={13} />
                  </a>
                )}
                {troubleshooter && (
                  <a href={troubleshooter} rel="noreferrer" target="_blank">
                    查看飞书排查建议 <ArrowUpRight size={13} />
                  </a>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({
  icon: Icon = FileText,
  title,
  description
}: {
  icon?: typeof FileText;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <span><Icon size={22} /></span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function Section({
  title,
  subtitle,
  children,
  action
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="section-card">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  tone
}: {
  label: string;
  value: number | string;
  icon: typeof FileText;
  tone: string;
}) {
  return (
    <div className={`stat-card stat-${tone}`}>
      <span className="stat-icon"><Icon size={19} /></span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function Priority({ todo }: { todo: TodoMetadata }) {
  return (
    <div className="priority">
      <div className="priority-score">{todo.priority.effective}</div>
      <div>
        <div className="priority-bar">
          <span style={{ width: `${Math.min(100, todo.priority.effective)}%` }} />
        </div>
        <small>
          {todo.priority.manual !== null
            ? "手工优先级"
            : todo.priority.reasons.map((reason) => reason.label).join(" · ") || "基础优先级"}
        </small>
      </div>
    </div>
  );
}

function AgentStartDialog({
  sourceKind,
  sourceId,
  title,
  onClose
}: {
  sourceKind: "todo" | "meego";
  sourceId: string;
  title: string;
  onClose(): void;
}) {
  const repositories = useApi<AgentRepository[]>("/api/agent/repositories", []);
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState(title);
  const [repositoryId, setRepositoryId] = useState("");
  const [mode, setMode] = useState<AgentWorkspaceMode>("read_only");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const effectiveRepositoryId = repositoryId || repositories.data[0]?.id || "";

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStarting(true);
    setError("");
    try {
      const session = await api<AgentSession>("/api/agent/sessions", {
        method: "POST",
        body: JSON.stringify({ sourceKind, sourceId, repositoryId: effectiveRepositoryId, mode, prompt })
      });
      onClose();
      navigate(`/loop?session=${encodeURIComponent(session.id)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="agent-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="agent-dialog" aria-label="启动 Agent" onMouseDown={(event) => event.stopPropagation()} onSubmit={start} role="dialog">
        <div className="agent-dialog-head">
          <div><span>Manual Loop</span><h2>开始 Agent 干活</h2></div>
          <button aria-label="关闭启动 Agent" onClick={onClose} type="button"><X size={18} /></button>
        </div>
        <label><span>任务说明</span><textarea aria-label="Agent 任务说明" onChange={(event) => setPrompt(event.target.value)} required value={prompt} /></label>
        <label><span>代码仓库</span>
          <select aria-label="Agent 代码仓库" onChange={(event) => setRepositoryId(event.target.value)} required value={effectiveRepositoryId}>
            <option value="">选择已注册仓库</option>
            {repositories.data.map((repository) => <option key={repository.id} value={repository.id}>{repository.name} · {repository.path}</option>)}
          </select>
        </label>
        {!repositories.loading && !repositories.data.length && <div className="info-banner">尚未注册仓库，请先到 <Link to="/settings">Settings</Link> 添加。</div>}
        <fieldset className="agent-mode-options">
          <legend>工作模式</legend>
          <label><input checked={mode === "read_only"} name="agent-mode" onChange={() => setMode("read_only")} type="radio" /><span><strong>只读分析</strong><small>直接读取原仓库，强制只读，不创建 worktree</small></span></label>
          <label><input checked={mode === "isolated_worktree"} name="agent-mode" onChange={() => setMode("isolated_worktree")} type="radio" /><span><strong>隔离开发</strong><small>固定当前基线，创建会话专属分支和 worktree</small></span></label>
        </fieldset>
        <ErrorBanner message={error || repositories.error} />
        <div className="agent-dialog-actions"><button className="secondary-button" onClick={onClose} type="button">取消</button><button className="primary-button" disabled={starting || !effectiveRepositoryId} type="submit"><Play size={16} />{starting ? "正在启动…" : "开始干活"}</button></div>
      </form>
    </div>
  );
}

function AgentStartButton({ sourceKind, sourceId, title, disabled = false }: { sourceKind: "todo" | "meego"; sourceId: string; title: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button aria-label={`开始 Agent 干活：${title}`} className="agent-start-button" disabled={disabled} onClick={() => setOpen(true)} type="button"><Play size={14} />Agent</button>
    {open && <AgentStartDialog onClose={() => setOpen(false)} sourceId={sourceId} sourceKind={sourceKind} title={title} />}
  </>;
}

function TodoRow({
  todo,
  compact = false,
  onStatusChanged
}: {
  todo: TodoMetadata;
  compact?: boolean;
  onStatusChanged?: () => void | Promise<void>;
}) {
  const [statusOverride, setStatusOverride] = useState<TodoMetadata["status"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const status = statusOverride ?? todo.status;

  async function toggleStatus() {
    const next = status === "done" ? "open" : "done";
    setStatusOverride(next);
    setSaving(true);
    setError("");
    try {
      await api(`/api/todos/${encodeURIComponent(todo.id)}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: next })
      });
      await onStatusChanged?.();
    } catch (caught) {
      setStatusOverride(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`todo-row ${compact ? "compact" : ""}`}>
      <button
        aria-label={status === "done" ? `重新打开 ${todo.title}` : `标记完成 ${todo.title}`}
        className={`todo-check status-${status}`}
        disabled={saving}
        onClick={() => void toggleStatus()}
        title={error || undefined}
        type="button"
      >
        {status === "done" ? <Check size={15} /> : <span />}
      </button>
      <Link className="todo-link" to={`/documents/${encodeURIComponent(todo.id)}`}>
        <div className="todo-main">
          <div className="todo-title-line">
            <strong>{todo.title}</strong>
            <Badge tone={todo.direction === "waiting_on_them" ? "amber" : "blue"}>
              {todo.direction === "waiting_on_them" ? "等待对方" : todo.direction === "shared" ? "共同推进" : "我来处理"}
            </Badge>
            {todo.analysis && (
              <Badge tone={todo.analysis.stale ? "amber" : "purple"}>
                {todo.analysis.stale ? "分析已过时" : todo.analysis.provider}
              </Badge>
            )}
          </div>
          <span>{todo.due_at ? `${formatDate(todo.due_at)} 到期` : statusLabel(status)}</span>
        </div>
        {!compact && <Priority todo={{ ...todo, status }} />}
        <ChevronRight size={17} className="row-arrow" />
      </Link>
      <AgentStartButton
        disabled={!(["open", "in_progress"].includes(status) && todo.direction !== "waiting_on_them")}
        sourceId={todo.id}
        sourceKind="todo"
        title={todo.title}
      />
      {error && <span className="todo-status-error" role="alert">{error}</span>}
    </div>
  );
}

function SourceRow({ source }: { source: SourceMetadata }) {
  return (
    <Link className="source-row" to={`/documents/${encodeURIComponent(source.id)}`}>
      <span className="source-icon">
        {source.source_kind === "calendar" ? <CalendarDays size={17} /> : <FileText size={17} />}
      </span>
      <div>
        <strong>{source.title}</strong>
        <span>{formatDate(source.occurred_at)}</span>
      </div>
      <ArrowUpRight size={15} />
    </Link>
  );
}

function MeegoItemRow({ item }: { item: MeegoItem }) {
  const content = (
    <>
      <span className="source-icon"><ListTodo size={17} /></span>
      <div>
        <strong>{item.title}</strong>
        <span>
          {item.projectName} · {item.workItemTypeName} · 更新于 {formatDate(item.updatedAt)}
        </span>
        {item.qTags.length > 0 && (
          <span className="meego-tags">
            {item.qTags.map((tag) => <Badge key={tag.raw} tone="blue">{tag.raw}</Badge>)}
          </span>
        )}
      </div>
      <ArrowUpRight size={15} />
    </>
  );
  return <div className="meego-agent-row">
    {item.url ? (
      <a className="source-row meego-row" href={item.url} rel="noreferrer" target="_blank">{content}</a>
    ) : (
      <div className="source-row meego-row">{content}</div>
    )}
    <AgentStartButton disabled={item.completed} sourceId={item.id} sourceKind="meego" title={item.title} />
  </div>;
}

function ProvenanceSource({
  source
}: {
  source: NonNullable<ApiDocument["provenanceSources"]>[number];
}) {
  const excerpt = (source.body ?? "")
    .replace(/^# .*\n+/u, "")
    .replace(/\*\*Participants:\*\*.*\n?/u, "")
    .replace(/\*\*Occurred:\*\*.*\n?/u, "")
    .trim();
  return (
    <article className="provenance-source">
      <span>
        <Link to={`/documents/${encodeURIComponent(source.id)}`}>
          <strong>
            {source.conversation
              ? `${source.conversation.type === "direct" ? "私聊" : "群聊"} · ${source.conversation.name}`
              : source.title}
          </strong>
        </Link>
        <small>{source.provider} · {source.source_kind} · {formatDate(source.occurred_at)}</small>
      </span>
      {source.sender && (
        <div className="provenance-sender">
          <span>发送人</span>
          <Link to={`/documents/${encodeURIComponent(source.sender.person_id)}`}>
            {source.sender.display_name}
          </Link>
        </div>
      )}
      <code>{source.id}</code>
      <p>
        {excerpt || (source.body_purged_at
          ? `来源正文已于 ${formatDate(source.body_purged_at)} 按保留策略清理。`
          : "该来源没有文本内容。")}
      </p>
    </article>
  );
}

function NowPage() {
  const { data, loading, error } = useApi<OverviewResponse>("/api/overview", {
    ...emptyOverview,
    analysisQueue: emptyAnalysisQueue
  });
  const today = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(new Date());
  const [summaryMessage, setSummaryMessage] = useState("");

  async function createDailySummary() {
    try {
      const summary = await api<ApiDocument<KnowledgeMetadata>>(
        "/api/summaries/daily",
        { method: "POST" }
      );
      setSummaryMessage(`已保存 ${summary.data.title}`);
    } catch (error) {
      setSummaryMessage(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <>
      <PageHeader
        eyebrow={today}
        title="现在，先做重要的事。"
        description="从消息、日程和任务中汇总出的当前工作上下文。"
        action={
          <div className="page-actions">
            <button className="secondary-button" onClick={() => void createDailySummary()} type="button">
              <FileText size={17} />保存今日摘要
            </button>
            <Link className="primary-button" to="/inbox"><Sparkles size={17} />查看待确认</Link>
          </div>
        }
      />
      <ErrorBanner message={error} />
      {summaryMessage && <div className="info-banner">{summaryMessage}</div>}
      <div className="stats-grid">
        <StatCard label="开放 Todo" value={data.counts.todos} icon={ListTodo} tone="coral" />
        <StatCard label="协作人物" value={data.counts.people} icon={Users} tone="mint" />
        <StatCard label="知识页面" value={data.counts.knowledge} icon={BookOpen} tone="blue" />
        <StatCard label="待确认" value={data.counts.inbox} icon={Inbox} tone="amber" />
      </div>

      <div className="dashboard-grid">
        <Section
          title="Top Todo"
          subtitle="按截止时间、明确指派和 Leader 关系排序"
          action={<Link className="text-link" to="/todos">查看全部</Link>}
        >
          {data.topTodos.length ? (
            <div className="list-stack">{data.topTodos.map((todo) => <TodoRow key={todo.id} todo={todo} />)}</div>
          ) : (
            <EmptyState icon={CheckCircle2} title={loading ? "正在加载…" : "当前没有开放 Todo"} description="同步飞书或添加 Markdown Todo 后会在这里排序。" />
          )}
        </Section>

        <div className="dashboard-side">
          <Section title="未来 24 小时" subtitle="近期日程">
            {data.upcomingCalendar.length ? data.upcomingCalendar.map((source) => <SourceRow key={source.id} source={source} />) : <EmptyState icon={CalendarDays} title="日程清空" description="未来 24 小时没有已同步的日程。" />}
          </Section>
          <Link className="loop-teaser" to="/loop">
            <div>
              <span className="loop-orbit"><Bot size={20} /></span>
              <div>
                <small>LOOP READINESS</small>
                <strong>自动执行尚未启用</strong>
                <p>
                  排队 {data.analysisQueue.queued} · 运行 {data.analysisQueue.leased}
                  {" · "}重试 {data.analysisQueue.failed_retryable}
                  {" · "}失败 {data.analysisQueue.failed_terminal}
                </p>
              </div>
            </div>
            <ChevronRight size={18} />
          </Link>
        </div>
      </div>

      <div className="three-column">
        <Section title="飞书任务" subtitle="SQLite 上游数据（只读）">
          {data.upstreamTasks.length ? data.upstreamTasks.map((source) => <SourceRow key={source.id} source={source} />) : <EmptyState icon={ListTodo} title="没有上游任务" description="同步到的未完成飞书任务会显示在这里。" />}
        </Section>
        <Section title="@ 我" subtitle="最近的群聊触达">
          {data.recentMentions.length ? data.recentMentions.map((source) => <SourceRow key={source.id} source={source} />) : <EmptyState title="没有新消息" description="新的群聊 @ 我会显示在这里。" />}
        </Section>
        <Section title="等待他人" subtitle="由对方推进的开放事项">
          {data.waitingItems.length ? data.waitingItems.slice(0, 5).map((todo) => <TodoRow compact key={todo.id} todo={todo} />) : <EmptyState icon={Clock3} title="没有等待项" description="双方承诺会自动分流。" />}
        </Section>
        <Section title="知识变化" subtitle="最近形成或更新的内容">
          {data.knowledgeChanges.length ? data.knowledgeChanges.slice(0, 5).map((item) => (
            <Link className="knowledge-mini" key={item.id} to={`/documents/${encodeURIComponent(item.id)}`}>
              <span>{item.knowledge_kind.slice(0, 1).toUpperCase()}</span>
              <div><strong>{item.title}</strong><small>{statusLabel(item.curation_state)}</small></div>
            </Link>
          )) : <EmptyState icon={BookOpen} title="暂无知识变化" description="带来源的知识草稿会出现在这里。" />}
        </Section>
      </div>
    </>
  );
}

function InboxPage() {
  const { data, loading, error, reload } = useApi<ReviewCandidate[]>("/api/candidates", []);
  const [acting, setActing] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState("");

  async function reviewCandidate(
    candidate: ReviewCandidate,
    action: "accept" | "reject"
  ) {
    setActing(candidate.id);
    setConfirmError("");
    try {
      await api<AcceptanceOperation>(
        `/api/candidates/${encodeURIComponent(candidate.id)}/${action}`,
        { method: "POST" }
      );
      await reload();
    } catch (caught) {
      setConfirmError(caught instanceof Error ? caught.message : String(caught));
      await reload();
    } finally {
      setActing(null);
    }
  }

  return (
    <>
      <PageHeader eyebrow="Review queue" title="Inbox" description="只有知识草稿需要人工确认；Todo 和职场洞察会直接写入对应集合。" />
      <ErrorBanner message={error ?? confirmError} />
      <div className="document-grid">
        {data.map((candidate) => (
          <article className="document-card" key={candidate.id}>
            <Link className="document-card-link" to={`/documents/${encodeURIComponent(candidate.id)}`}>
              <div className="document-card-top">
                <Badge tone="amber">
                  {candidate.kind === "todo"
                    ? "Todo 候选"
                    : candidate.kind === "knowledge"
                      ? "知识候选"
                      : "人物洞察"}
                </Badge>
                <span>{Math.round(candidate.confidence * 100)}% confidence</span>
                {candidate.acceptance && (
                  <Badge
                    tone={
                      candidate.acceptance.state === "conflict"
                        ? "coral"
                        : "blue"
                    }
                  >
                    {candidate.acceptance.state}
                  </Badge>
                )}
              </div>
              <h3>{candidate.title}</h3>
              <p>{candidate.reason || "等待人工检查来源和上下文。"}</p>
              <small>
                {candidate.provider} · {candidate.promptVersion} ·{" "}
                {formatDate(candidate.analyzedAt)}
              </small>
            </Link>
            <div className="document-card-foot">
              <span>{candidate.sourceRefs.length} 个来源 · {candidate.evidence.length} 条证据</span>
              <Link aria-label={`查看 ${candidate.title}`} to={`/documents/${encodeURIComponent(candidate.id)}`}>
                <ChevronRight size={16} />
              </Link>
              <button
                aria-label={`拒绝 ${candidate.title}`}
                className="candidate-action secondary-button"
                disabled={acting === candidate.id}
                onClick={() => void reviewCandidate(candidate, "reject")}
                type="button"
              >
                <X size={14} />
                拒绝
              </button>
              <button
                aria-label={`确认 ${candidate.title}`}
                className="candidate-action confirm-candidate"
                disabled={acting === candidate.id}
                onClick={() => void reviewCandidate(candidate, "accept")}
                type="button"
              >
                <Check size={14} />
                {acting === candidate.id
                  ? "处理中…"
                  : candidate.status === "pending"
                    ? "恢复接受"
                    : "确认"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {!data.length && <EmptyState icon={Inbox} title={loading ? "正在加载…" : "Inbox 已清空"} description="待确认的知识草稿会保留来源并进入这里。" />}
    </>
  );
}

function TodosPage() {
  const [category, setCategory] = useState("active");
  const {
    data,
    loading,
    error,
    reload
  } = useApi<ApiDocument<TodoMetadata>[]>("/api/documents?type=todo", []);
  const filtered = useMemo(
    () =>
      data.filter(({ data: todo }) => {
        if (category === "done") return todo.status === "done";
        if (todo.status === "done") return false;
        return category === "active" || todo.direction === category;
      }),
    [data, category]
  );
  return (
    <>
      <PageHeader eyebrow="Commitments" title="Todos" description="把原生任务与聊天承诺放进同一个、可解释的优先级队列。" />
      <div className="filter-bar" role="group" aria-label="Todo 分类筛选">
        {[
          ["active", "全部未完成"],
          ["owed_by_me", "我来处理"],
          ["waiting_on_them", "等待对方"],
          ["shared", "共同推进"],
          ["done", "已完成"]
        ].map(([value, label]) => (
          <button key={value} className={category === value ? "active" : ""} onClick={() => setCategory(value)}>{label}</button>
        ))}
      </div>
      <ErrorBanner message={error} />
      <Section title={`${filtered.length} 个事项`} subtitle="优先级原因始终可见">
        {filtered.length ? <div className="list-stack">{filtered.sort((a, b) => b.data.priority.effective - a.data.priority.effective).map(({ data: todo }) => <TodoRow key={todo.id} todo={todo} onStatusChanged={reload} />)}</div> : <EmptyState icon={ListTodo} title={loading ? "正在加载…" : "没有匹配的 Todo"} description="更换筛选条件或同步新的工作上下文。" />}
      </Section>
    </>
  );
}

function PeoplePage() {
  const { data, loading, error } = useApi<ApiDocument<PersonMetadata>[]>("/api/documents?type=person", []);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () =>
      data.filter(({ data: person }) => {
        if (!normalizedQuery) return true;
        return [
          person.title,
          person.role ?? "",
          ...person.identities.flatMap((identity) => [
            identity.display_name ?? "",
            identity.external_id
          ]),
          ...person.observations.flatMap((observation) => [
            observation.text,
            ...observation.evidence
          ])
        ].some((value) =>
          value.toLocaleLowerCase().includes(normalizedQuery)
        );
      }),
    [data, normalizedQuery]
  );
  return (
    <>
      <PageHeader eyebrow="Working relationships" title="People" description="角色、协作观察和双方承诺，全部带证据并可修正。" />
      <ErrorBanner message={error} />
      <label className="people-page-search">
        <Search size={16} />
        <input
          aria-label="搜索 People"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索姓名、角色、身份或观察"
          type="search"
          value={query}
        />
        <span>{filtered.length} / {data.length}</span>
      </label>
      <div className="people-grid">
        {filtered.map((document) => {
          const person = document.data;
          const responsibility = person.observations.find(
            (observation) =>
              observation.category === "responsibility" && !observation.stale
          );
          const openLoops =
            (document.relationships?.owedByMe.length ?? 0) +
            (document.relationships?.waitingOnThem.length ?? 0) +
            (document.relationships?.shared.length ?? 0);
          return (
            <Link className="person-card" key={person.id} to={`/documents/${encodeURIComponent(person.id)}`}>
              <div className="person-avatar">{person.title.slice(0, 1).toUpperCase()}</div>
              <div className="person-card-main">
                <div><h3>{person.title}</h3>{person.is_leader && <Badge tone="coral">Leader +{person.leader_boost}</Badge>}</div>
                <p>{person.role ?? responsibility?.text ?? "角色待补充"}</p>
                <div className="person-meta"><span>{openLoops} 个开放承诺</span><span>最近 {formatDate(person.last_interaction_at)}</span></div>
              </div>
              <ChevronRight size={17} />
            </Link>
          );
        })}
      </div>
      {!filtered.length && (
        <EmptyState
          icon={Users}
          title={
            loading
              ? "正在加载…"
              : data.length
                ? "没有匹配人物"
                : "还没有人物档案"
          }
          description={
            data.length
              ? "尝试搜索姓名、角色、身份或职场观察。"
              : "相关消息、日程和任务会自动发现协作对象。"
          }
        />
      )}
    </>
  );
}

function KnowledgePage() {
  const { data, loading, error } = useApi<ApiDocument[]>("/api/documents?type=knowledge", []);
  const grouped = useMemo(() => {
    return data.reduce<Record<string, ApiDocument[]>>((result, document) => {
      const kind = String(document.data.knowledge_kind ?? "concept");
      (result[kind] ??= []).push(document);
      return result;
    }, {});
  }, [data]);
  return (
    <>
      <PageHeader eyebrow="Evidence-backed wiki" title="Knowledge" description="项目、决策、流程和概念都保留来源与演进历史。" />
      <ErrorBanner message={error} />
      <div className="knowledge-layout">
        {Object.entries(grouped).map(([kind, documents]) => (
          <Section key={kind} title={kind[0].toUpperCase() + kind.slice(1)} subtitle={`${documents.length} pages`}>
            {documents.map((document) => (
              <Link className="knowledge-row" key={document.data.id} to={`/documents/${encodeURIComponent(document.data.id)}`}>
                <span className="knowledge-symbol">{kind.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{document.data.title}</strong>
                  <small>
                    {document.data.source_refs.length} 个来源
                    {document.data.analysis ? ` · ${document.data.analysis.provider}` : ""}
                    {" · "}{formatDate(document.data.updated_at)}
                  </small>
                </div>
                <ChevronRight size={16} />
              </Link>
            ))}
          </Section>
        ))}
      </div>
      {!data.length && <EmptyState icon={BookOpen} title={loading ? "正在加载…" : "知识库还是空的"} description="确认 Inbox 中的知识草稿后，它们会进入长期 Wiki。" />}
    </>
  );
}

interface TimelineResponse {
  items: SourceMetadata[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
}

function TimelinePage() {
  const [page, setPage] = useState(1);
  const { data, loading, error } = useApi<TimelineResponse>(
    `/api/timeline?page=${page}&page_size=20`,
    {
      items: [],
      pagination: { page: 1, page_size: 20, total: 0, total_pages: 1 }
    }
  );
  return (
    <>
      <PageHeader eyebrow="Calendar" title="Timeline" description="只展示日历事件，并按发生时间倒序排列。" />
      <ErrorBanner message={error} />
      <div className="timeline">
        {data.items.map((item) => (
          <Link key={item.id} className="timeline-item" to={`/documents/${encodeURIComponent(item.id)}`}>
            <div className="timeline-time">{formatDate(item.occurred_at)}</div>
            <span className="timeline-dot type-calendar" />
            <div className="timeline-content"><Badge>日历</Badge><strong>{item.title}</strong><small>{item.provider}</small></div>
            <ChevronRight size={16} />
          </Link>
        ))}
      </div>
      {data.pagination.total_pages > 1 && (
        <div className="provenance-pagination timeline-pagination">
          <button
            aria-label="上一页 Timeline"
            disabled={data.pagination.page <= 1}
            onClick={() => setPage(data.pagination.page - 1)}
            type="button"
          >
            <ChevronLeft size={14} />上一页
          </button>
          <span>
            第 {data.pagination.page} / {data.pagination.total_pages} 页
            · 共 {data.pagination.total} 条
          </span>
          <button
            aria-label="下一页 Timeline"
            disabled={data.pagination.page >= data.pagination.total_pages}
            onClick={() => setPage(data.pagination.page + 1)}
            type="button"
          >
            下一页<ChevronRight size={14} />
          </button>
        </div>
      )}
      {!data.items.length && <EmptyState icon={CalendarDays} title={loading ? "正在加载…" : "还没有日历事件"} description="同步后的日历事件会按发生时间显示在这里。" />}
    </>
  );
}

interface LoopResponse {
  enabled: boolean;
  automaticExecutionEnabled: boolean;
  message: string;
  readiness: LoopReadiness;
  sessions: AgentSession[];
}

function LoopPage() {
  const loop = useApi<LoopResponse>("/api/loop", {
    enabled: true,
    automaticExecutionEnabled: false,
    message: "仅支持人工启动 Agent；自动执行仍未启用。",
    readiness: { futureAutomatable: [], confirmationRequired: [], blocked: [], recentRuns: [] },
    sessions: []
  });
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedId = searchParams.get("session");
  const [selectedId, setSelectedId] = useState(requestedId ?? "");
  const [detail, setDetail] = useState<AgentSession | null>(null);
  const [detailError, setDetailError] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const effectiveSelectedId = requestedId && loop.data.sessions.some(({ id }) => id === requestedId)
    ? requestedId
    : selectedId && loop.data.sessions.some(({ id }) => id === selectedId)
      ? selectedId
      : loop.data.sessions[0]?.id || "";
  const selectedDetail = detail?.id === effectiveSelectedId ? detail : null;

  useEffect(() => {
    if (!effectiveSelectedId) return;
    let active = true;
    api<AgentSession>(`/api/agent/sessions/${encodeURIComponent(effectiveSelectedId)}`)
      .then((session) => { if (active) { setDetail(session); setDetailError(""); } })
      .catch((error) => { if (active) setDetailError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [effectiveSelectedId, loop.data.sessions]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const stream = new EventSource("/api/agent/events");
    const reload = loop.reload;
    const changed = () => { void reload(); };
    stream.addEventListener("session.changed", changed);
    return () => { stream.removeEventListener("session.changed", changed); stream.close(); };
  }, [loop.reload]);

  function selectSession(id: string) {
    setSelectedId(id);
    setSearchParams({ session: id });
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDetail || !message.trim()) return;
    setSending(true);
    try {
      await api(`/api/agent/sessions/${encodeURIComponent(selectedDetail.id)}/messages`, { method: "POST", body: JSON.stringify({ content: message.trim() }) });
      setMessage("");
      await loop.reload();
    } finally { setSending(false); }
  }

  async function answer(confirmationId: string, selection: string) {
    await api(`/api/agent/confirmations/${encodeURIComponent(confirmationId)}/answer`, { method: "POST", body: JSON.stringify({ selection }) });
    await loop.reload();
  }

  async function action(name: "stop" | "accept" | "cancel" | "upgrade-workspace" | "cleanup-workspace") {
    if (!selectedDetail) return;
    await api(`/api/agent/sessions/${encodeURIComponent(selectedDetail.id)}/${name}`, { method: "POST", body: "{}" });
    await loop.reload();
  }

  const attentionLabels: Record<AgentSession["attention"], string> = {
    none: "正在执行",
    confirmation_required: "人工确认",
    reply_required: "等待回复",
    review_required: "待验收"
  };
  const pendingConfirmations = selectedDetail?.confirmations?.filter(({ status }) => status === "pending") ?? [];
  const lastTurn = selectedDetail?.turns?.at(-1);
  return (
    <>
      <PageHeader eyebrow="Manual agent workspace" title="Loop" description="人工启动、可恢复、可对话的本地 Agent 工作台。" />
      <ErrorBanner message={loop.error ?? detailError} />
      <div className="info-banner"><ShieldCheck size={16} />{loop.data.message} Agent 完成不会自动修改 Todo 或 Meego。</div>
      <div className="agent-workbench">
        <aside className="agent-session-panel">
          <div className="agent-panel-heading"><strong>Agent 会话</strong><Badge tone="blue">{loop.data.sessions.length}</Badge></div>
          <div className="agent-session-list">
            {loop.data.sessions.map((session) => (
              <button className={session.id === effectiveSelectedId ? "active" : ""} key={session.id} onClick={() => selectSession(session.id)} type="button">
                <span><strong>{session.title}</strong><small>{session.repository?.name ?? session.repositoryId} · {formatDate(session.updatedAt)}</small></span>
                <Badge tone={session.attention === "confirmation_required" ? "amber" : session.status === "active" ? "mint" : "neutral"}>{session.status === "active" ? attentionLabels[session.attention] : session.status}</Badge>
              </button>
            ))}
            {!loop.data.sessions.length && <EmptyState icon={Bot} title="还没有 Agent 会话" description="从 Todo 或 Meego 手动启动。" />}
          </div>
        </aside>
        <main className="agent-conversation-panel">
          {selectedDetail ? <>
            <div className="agent-panel-heading"><div><strong>{selectedDetail.title}</strong><small>{lastTurn?.status ?? selectedDetail.attention}</small></div>{lastTurn?.status === "running" && <Badge tone="mint">Running</Badge>}</div>
            <div className="agent-messages">
              {selectedDetail.messages?.map((entry) => <article className={`agent-message role-${entry.role}`} key={entry.id}><span>{entry.role === "assistant" ? "Agent" : entry.role === "user" ? "你" : "系统"}</span><p>{entry.content}</p><small>{formatDate(entry.createdAt)}</small></article>)}
              {selectedDetail.events?.filter(({ type }) => type.includes("command_execution") || type.includes("file_change")).map((event) => <article className="agent-event" key={event.id}><code>{event.type.includes("command") ? String(event.data.command ?? "命令执行") : "文件修改"}</code><small>{String(event.data.status ?? "")}</small></article>)}
            </div>
            {pendingConfirmations.map((confirmation) => <section className="agent-confirmation" key={confirmation.id}><CircleUserRound size={18} /><div><strong>需要人工确认</strong><p>{confirmation.question}</p><div>{confirmation.options.map((option) => <button className="secondary-button" key={option} onClick={() => void answer(confirmation.id, option)} type="button">{option === "approve" ? "批准" : option === "reject" ? "拒绝" : option}</button>)}</div></div></section>)}
            <form className="agent-composer" onSubmit={send}><textarea aria-label="发送给 Agent" onChange={(event) => setMessage(event.target.value)} placeholder="继续和 Agent 对话…" value={message} /><button className="primary-button" disabled={sending || !message.trim() || selectedDetail.status !== "active"} type="submit"><Send size={16} />发送</button></form>
          </> : <EmptyState icon={Bot} title="选择一个 Agent 会话" description="查看执行过程、对话和人工确认。" />}
        </main>
        <aside className="agent-context-panel">
          {selectedDetail && <>
            <div className="agent-panel-heading"><strong>工作上下文</strong></div>
            <div className="meta-list"><div><span>来源</span><strong>{selectedDetail.sourceKind}</strong></div><div><span>模式</span><strong>{selectedDetail.mode === "read_only" ? "只读分析" : "隔离开发"}</strong></div><div><span>仓库</span><strong>{selectedDetail.repository?.name ?? "—"}</strong></div><div><span>分支</span><strong>{selectedDetail.branch ?? "不创建"}</strong></div><div><span>基线</span><code>{selectedDetail.baseCommit.slice(0, 12)}</code></div><div><span>工作区</span><code>{selectedDetail.workspacePath}</code></div></div>
            <div className="agent-context-actions">
              {selectedDetail.mode === "read_only" && selectedDetail.status === "active" && <button className="secondary-button" onClick={() => void action("upgrade-workspace")} type="button"><Sparkles size={15} />创建 worktree 继续</button>}
              {lastTurn?.status === "running" && <button className="secondary-button" onClick={() => void action("stop")} type="button"><Square size={14} />停止当前 Turn</button>}
              {selectedDetail.attention === "review_required" && selectedDetail.status === "active" && <button className="primary-button" onClick={() => void action("accept")} type="button"><Check size={15} />验收并结束</button>}
              {selectedDetail.status === "active" && <button className="secondary-button danger" onClick={() => void action("cancel")} type="button"><X size={15} />结束会话</button>}
              {selectedDetail.mode === "isolated_worktree" && selectedDetail.status !== "active" && selectedDetail.workspaceLifecycle !== "removed" && <button className="secondary-button danger" onClick={() => void action("cleanup-workspace")} type="button"><Trash2 size={15} />清理 worktree</button>}
            </div>
          </>}
        </aside>
      </div>
    </>
  );
}

function MeegoPage() {
  const list = useApi<MeegoList>("/api/meego", {
    mode: "updated_at",
    items: [],
    groups: []
  });
  const status = useApi<MeegoSyncStatus>(
    "/api/sync/meego/status",
    EMPTY_MEEGO_SYNC_STATUS
  );
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");

  async function syncMeego() {
    setSyncing(true);
    setMessage("");
    try {
      const result = await api<MeegoSyncStatus>("/api/sync/meego", {
        method: "POST"
      });
      setMessage(
        result.lastError
          ? `同步完成，但存在问题：${result.lastError}`
          : result.enabled
            ? "Meego 只读同步完成。"
            : "Meego 抓取当前已关闭，请先在 Settings 开启。"
      );
      await Promise.all([list.reload(), status.reload()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
    }
  }

  const failed = status.data.results.filter((result) => !result.ok);
  return (
    <>
      <PageHeader
        eyebrow="Meego · Read only"
        title="我参与的 Meego"
        description={
          list.data.mode === "q_tag_time"
            ? "仅展示未完成且带合法 Q 时间标签的参与项，按完整标签分组。"
            : "展示配置空间内全部未完成参与项，按更新时间从新到旧排列。"
        }
        action={
          <button
            className="primary-button"
            disabled={!status.data.enabled || syncing || status.data.running}
            onClick={() => void syncMeego()}
            type="button"
          >
            <RefreshCw className={syncing || status.data.running ? "spin" : ""} size={17} />
            {syncing || status.data.running ? "正在同步…" : "同步 Meego"}
          </button>
        }
      />
      <ErrorBanner message={list.error ?? status.error} />
      {message && <div className="info-banner">{message}</div>}
      {!status.data.enabled && (
        <div className="info-banner">
          Meego 抓取已关闭。请在 <Link className="text-link" to="/settings">Settings</Link> 配置项目并开启。
        </div>
      )}
      {failed.length > 0 && (
        <div className="lark-issue-list">
          {failed.map((result) => (
            <div className="lark-issue" key={`${result.projectKey}:${result.workItemType ?? "project"}`}>
              <div className="lark-issue-head">
                <AlertTriangle size={16} />
                <div>
                  <strong>{result.projectKey} · {result.workItemType ?? "项目"}</strong>
                  <span>{result.error ?? "同步失败"}</span>
                </div>
                <Badge tone="coral">失败</Badge>
              </div>
            </div>
          ))}
        </div>
      )}
      {list.data.mode === "q_tag_time" ? (
        list.data.groups.length ? (
          <div className="meego-groups">
            {list.data.groups.map((group) => (
              <Section
                key={group.qTag.raw}
                title={group.qTag.raw}
                subtitle={`${group.items.length} 个未完成参与项`}
              >
                {group.items.map((item) => <MeegoItemRow item={item} key={item.id} />)}
              </Section>
            ))}
          </div>
        ) : (
          <Section title="Q 标签时间线" subtitle="当前过滤模式">
            <EmptyState
              icon={ListTodo}
              title={list.loading ? "正在加载…" : "没有匹配的 Meego"}
              description="同步后，仅包含合法 Q 时间标签的参与项会显示在这里。"
            />
          </Section>
        )
      ) : (
        <Section title="最近更新" subtitle={`${list.data.items.length} 个参与项`}>
          {list.data.items.length ? (
            list.data.items.map((item) => <MeegoItemRow item={item} key={item.id} />)
          ) : (
            <EmptyState
              icon={ListTodo}
              title={list.loading ? "正在加载…" : "尚未同步 Meego"}
              description="配置项目空间并执行只读同步后，参与项会显示在这里。"
            />
          )}
        </Section>
      )}
    </>
  );
}

interface ConfigResponse {
  leaders: LeaderConfig[];
  lark: {
    status: SyncStatus;
    readOnly: boolean;
    identity: string;
    schedule: {
      config: {
        enabled: boolean;
        interval: number;
        unit: "minutes" | "hours";
      };
      running: boolean;
      next_run_at: string | null;
    };
  };
  meego: {
    config: MeegoConfig;
    status: MeegoSyncStatus;
    readOnly: boolean;
  };
  loop: { enabled: boolean; automaticExecutionEnabled: boolean; executionEndpoint: string | null };
  retention: { source_body_days: number };
  analysis: {
    current_provider: string;
    config_source: "workspace" | "environment";
    provider_locked: boolean;
    worker_count: number;
    worker_count_source: "workspace" | "environment";
    worker_count_locked: boolean;
    config: AnalysisConfig;
    providers: Array<{ id: string } & ProviderAvailability>;
    prompt_version: string;
    schema_version: string;
    status: AnalysisStatusMetadata;
    queue: AnalysisQueueCounts;
    failed_jobs: AnalysisJob[];
    recent_runs: AnalysisRunMetadata[];
  };
}

function SettingsPage() {
  const config = useApi<ConfigResponse>("/api/config", {
    leaders: [],
    lark: {
      status: EMPTY_SYNC_STATUS,
      readOnly: true,
      identity: "user",
      schedule: {
        config: { enabled: false, interval: 1, unit: "hours" },
        running: false,
        next_run_at: null
      }
    },
    meego: {
      config: {
        enabled: false,
        qTagTimelineEnabled: false,
        projectKeys: []
      },
      status: EMPTY_MEEGO_SYNC_STATUS,
      readOnly: true
    },
    loop: { enabled: true, automaticExecutionEnabled: false, executionEndpoint: "/api/agent/sessions" },
    retention: { source_body_days: 90 },
    analysis: {
      current_provider: "codex-sdk",
      config_source: "workspace",
      provider_locked: false,
      worker_count: 1,
      worker_count_source: "workspace",
      worker_count_locked: false,
      config: {
        provider: "codex-sdk",
        model: null,
        reasoning_effort: "medium",
        timeout_ms: 120000,
        max_source_chars: 20000,
        max_batch_records: 50,
        max_batch_source_chars: 60000,
        max_output_bytes: 2000000,
        prompt_version: "context-analysis@4",
        retain_runs: 50,
        max_reanalysis_records: 50
      },
      providers: [],
      prompt_version: "context-analysis@4",
      schema_version: "work-context/analysis@2",
      status: {
        schema: "work-context/analysis-status@1",
        id: "analysis_status",
        type: "analysis-status",
        title: "LLM 分析状态",
        managed: "generated",
        created_at: "",
        updated_at: "",
        source_refs: [],
        last_run_id: null,
        last_status: null,
        last_provider: null,
        last_completed_at: null,
        last_error_code: null,
        last_error_message: null
      },
      queue: emptyAnalysisQueue,
      failed_jobs: [],
      recent_runs: []
    }
  });
  const {
    data: liveStatus,
    error: syncStatusError,
    reload: reloadSyncStatus
  } = useApi<SyncStatus>(
    "/api/sync/lark/status",
    EMPTY_SYNC_STATUS
  );
  const {
    data: meegoStatus,
    error: meegoStatusError,
    reload: reloadMeegoStatus
  } = useApi<MeegoSyncStatus>(
    "/api/sync/meego/status",
    EMPTY_MEEGO_SYNC_STATUS
  );
  const people = useApi<ApiDocument<PersonMetadata>[]>("/api/documents?type=person", []);
  const diagnostics = useApi<MarkdownDiagnostic[]>(
    "/api/markdown/diagnostics",
    []
  );
  const markdownStatus = useApi<MarkdownSyncStatus>("/api/markdown/status", {
    watcherRunning: false,
    lastReconciledAt: null,
    lastIncrementalAt: null,
    reconcileMilliseconds: 5 * 60 * 1000
  });
  const agentRepositories = useApi<AgentRepository[]>("/api/agent/repositories", []);
  const [syncing, setSyncing] = useState(false);
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [savingReasoningEffort, setSavingReasoningEffort] = useState(false);
  const [savingWorkerCount, setSavingWorkerCount] = useState(false);
  const [savingRetention, setSavingRetention] = useState(false);
  const [savingSyncSchedule, setSavingSyncSchedule] = useState(false);
  const [savingMeego, setSavingMeego] = useState(false);
  const [syncingMeego, setSyncingMeego] = useState(false);
  const [savingAgentRepository, setSavingAgentRepository] = useState(false);
  const [retryingJob, setRetryingJob] = useState<string | null>(null);
  const [leaderQuery, setLeaderQuery] = useState("");
  const [updatingLeader, setUpdatingLeader] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const configuredLeaderIds = new Set(
    config.data.leaders.map((leader) => leader.person_id)
  );
  const peopleById = new Map(
    people.data.map(({ data: person }) => [person.id, person])
  );
  const normalizedLeaderQuery = leaderQuery.trim().toLocaleLowerCase();
  const leaderSearchResults = normalizedLeaderQuery
    ? people.data
        .map(({ data: person }) => person)
        .filter((person) => !configuredLeaderIds.has(person.id))
        .filter((person) =>
          [
            person.title,
            person.role ?? "",
            ...person.identities.map(
              (identity) => identity.display_name ?? identity.external_id
            )
          ].some((value) =>
            value.toLocaleLowerCase().includes(normalizedLeaderQuery)
          )
        )
        .slice(0, 8)
    : [];
  useEffect(() => {
    if (!syncing && !liveStatus.running) return;
    void reloadSyncStatus();
    const timer = window.setInterval(() => {
      void reloadSyncStatus();
    }, 750);
    return () => window.clearInterval(timer);
  }, [syncing, liveStatus.running, reloadSyncStatus]);

  async function syncLark() {
    setSyncing(true);
    setMessage("");
    void reloadSyncStatus();
    try {
      const status = await api<SyncStatus>("/api/sync/lark", { method: "POST" });
      const failed = status.results.filter((result) => !result.ok);
      if (failed.some((result) => result.issue?.requires_action)) {
        setMessage("同步已完成，但存在需要处理的飞书权限或认证问题，请查看下方提醒。");
      } else if (failed.length) {
        setMessage(`同步已完成，但 ${failed.length} 个来源失败，请查看下方详情。`);
      } else {
        setMessage("只读同步完成。");
      }
      await Promise.all([config.reload(), reloadSyncStatus()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
    }
  }

  async function updateLeader(person: PersonMetadata, add: boolean) {
    setUpdatingLeader(person.id);
    setMessage("");
    const current = config.data.leaders;
    const next = add
      ? [...current, { person_id: person.id, boost: person.leader_boost || 20 }]
      : current.filter((leader) => leader.person_id !== person.id);
    try {
      await api("/api/config/leaders", {
        method: "PUT",
        body: JSON.stringify(next)
      });
      await config.reload();
      if (add) setLeaderQuery("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatingLeader(null);
    }
  }

  async function switchProvider(provider: string) {
    setSwitchingProvider(true);
    setMessage("");
    try {
      await api("/api/config/analysis", {
        method: "PUT",
        body: JSON.stringify({ provider })
      });
      setMessage(`后续分析将使用 ${provider}；运行中的分析不受影响。`);
      await config.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitchingProvider(false);
    }
  }

  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingModel(true);
    setMessage("");
    const rawModel = new FormData(event.currentTarget).get("model");
    const model =
      typeof rawModel === "string" ? rawModel.trim() || null : null;
    try {
      await api("/api/config/analysis", {
        method: "PUT",
        body: JSON.stringify({ model })
      });
      setMessage(
        model
          ? `后续分析将使用模型 ${model}；可用性由当前 Codex 认证决定。`
          : "已清空模型覆盖；后续分析使用 Codex 当前默认模型。"
      );
      await config.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingModel(false);
    }
  }

  async function saveReasoningEffort(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingReasoningEffort(true);
    setMessage("");
    const rawEffort = new FormData(event.currentTarget).get("reasoning_effort");
    try {
      await api("/api/config/analysis", {
        method: "PUT",
        body: JSON.stringify({ reasoning_effort: rawEffort })
      });
      setMessage(`后续 Codex SDK 分析将使用 ${rawEffort} 推理强度。`);
      await config.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingReasoningEffort(false);
    }
  }

  async function retryAnalysisJob(jobId: string) {
    setRetryingJob(jobId);
    setMessage("");
    try {
      await api(`/api/analysis/jobs/${encodeURIComponent(jobId)}/retry`, {
        method: "POST"
      });
      setMessage("分析任务已重新排队。");
      await config.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRetryingJob(null);
    }
  }

  async function saveWorkerCount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingWorkerCount(true);
    setMessage("");
    const raw = new FormData(event.currentTarget).get("worker_count");
    const workerCount = Number(raw);
    try {
      await api("/api/config/analysis/workers", {
        method: "PUT",
        body: JSON.stringify({ worker_count: workerCount })
      });
      setMessage(`LLM Worker 已调整为 ${workerCount}；新并发度立即生效。`);
      await config.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingWorkerCount(false);
    }
  }

  async function saveRetention(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingRetention(true);
    setMessage("");
    const raw = new FormData(event.currentTarget).get("source_body_days");
    const days = Number(raw);
    try {
      await api("/api/config/retention", {
        method: "PUT",
        body: JSON.stringify({ source_body_days: days })
      });
      setMessage(`原始来源正文将保留 ${days} 天。`);
      await config.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingRetention(false);
    }
  }

  async function saveSyncSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingSyncSchedule(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const enabled = form.get("enabled") === "true";
    const interval = Number(form.get("interval"));
    const unit = form.get("unit");
    try {
      await api("/api/config/lark-sync-schedule", {
        method: "PUT",
        body: JSON.stringify({ enabled, interval, unit })
      });
      setMessage(
        enabled
          ? `已启用定期只读同步：每 ${interval} ${unit === "minutes" ? "分钟" : "小时"}一次。`
          : "已关闭定期只读同步。"
      );
      await config.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingSyncSchedule(false);
    }
  }

  async function saveMeego(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingMeego(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const rawProjects = String(form.get("project_keys") ?? "");
    const projectKeys = rawProjects
      .split(/[\s,]+/u)
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      await api("/api/config/meego", {
        method: "PUT",
        body: JSON.stringify({
          enabled: form.get("enabled") === "on",
          qTagTimelineEnabled: form.get("q_tag_timeline_enabled") === "on",
          projectKeys
        })
      });
      setMessage("Meego 配置已保存。开关只影响后续抓取和页面过滤，不会删除已有数据。");
      await Promise.all([config.reload(), reloadMeegoStatus()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingMeego(false);
    }
  }

  async function syncMeegoFromSettings() {
    setSyncingMeego(true);
    setMessage("");
    try {
      const status = await api<MeegoSyncStatus>("/api/sync/meego", {
        method: "POST"
      });
      setMessage(
        status.lastError
          ? `Meego 同步完成，但存在问题：${status.lastError}`
          : status.enabled
            ? "Meego 只读同步完成。"
            : "Meego 抓取当前已关闭。"
      );
      await Promise.all([config.reload(), reloadMeegoStatus()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncingMeego(false);
    }
  }

  async function registerAgentRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingAgentRepository(true);
    setMessage("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api("/api/agent/repositories", { method: "POST", body: JSON.stringify({ path: String(form.get("path") ?? "") }) });
      formElement.reset();
      setMessage("Agent 仓库已注册。");
      await agentRepositories.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setSavingAgentRepository(false); }
  }

  async function removeAgentRepository(id: string) {
    setMessage("");
    try {
      await api(`/api/agent/repositories/${encodeURIComponent(id)}`, { method: "DELETE" });
      setMessage("已移除仓库注册；磁盘仓库未被删除。");
      await agentRepositories.reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  return (
    <>
      <PageHeader eyebrow="Local control" title="Settings" description="人工内容由 Markdown 管理；同步、分析和审核状态保存在本机 SQLite。" />
      <ErrorBanner message={config.error ?? people.error ?? diagnostics.error ?? markdownStatus.error ?? syncStatusError ?? meegoStatusError ?? agentRepositories.error} />
      {message && <div className="info-banner">{message}</div>}
      <div className="settings-grid">
        <Section title="Agent repositories" subtitle="人工 Loop 允许使用的本地 Git 仓库">
          <form className="agent-repository-form" onSubmit={registerAgentRepository}>
            <label className="provider-control"><span>仓库路径</span><input aria-label="Agent 仓库路径" name="path" placeholder="/absolute/path/to/repository" required /></label>
            <button className="primary-button" disabled={savingAgentRepository} type="submit"><Plus size={16} />{savingAgentRepository ? "验证中…" : "注册仓库"}</button>
          </form>
          <div className="agent-repository-list">
            {agentRepositories.data.map((repository) => <div className="setting-row" key={repository.id}><div className="setting-icon"><Bot size={18} /></div><div><strong>{repository.name}</strong><span>{repository.path}</span><small>{repository.branch ?? "detached"} · {repository.headCommit.slice(0, 12)}</small></div><button aria-label={`移除仓库 ${repository.name}`} className="icon-button" onClick={() => void removeAgentRepository(repository.id)} type="button"><Trash2 size={15} /></button></div>)}
            {!agentRepositories.loading && !agentRepositories.data.length && <p className="muted-copy">尚未注册仓库，Todo 和 Meego 的 Agent 启动面板将不可提交。</p>}
          </div>
          <p className="muted-copy">只读任务直接读取原仓库；开发任务会在 Context Space 管理目录创建独立 worktree。移除注册不会删除磁盘文件。</p>
        </Section>

        <Section title="Lark source" subtitle="仅用户身份、只读命令">
          <div className="setting-row">
            <div className="setting-icon"><ShieldCheck size={19} /></div>
            <div><strong>Read-only adapter</strong><span>`lark-cli --as {config.data.lark.identity}` · no mutation commands</span></div>
            <Badge tone="mint">Protected</Badge>
          </div>
          <div className="sync-summary">
            <div><span>最后完成</span><strong>{formatDate(liveStatus.completed_at)}</strong></div>
            <div><span>来源结果</span><strong>{liveStatus.results.filter((result) => result.ok).length}/{liveStatus.results.length || 5}</strong></div>
            <div>
              <span>分析失败</span>
              <strong>{liveStatus.results.reduce((sum, result) => sum + (result.analysis_failed ?? 0), 0)}</strong>
            </div>
          </div>
          <LarkSyncIssues status={liveStatus} />
          <button className="primary-button full-button" disabled={syncing || liveStatus.running} onClick={syncLark}>
            <RefreshCw className={syncing || liveStatus.running ? "spin" : ""} size={17} />
            {syncing || liveStatus.running ? "正在同步…" : "立即只读同步"}
          </button>
          <form className="sync-schedule-control" onSubmit={saveSyncSchedule}>
            <label className="provider-control">
              <span>定期同步</span>
              <select
                aria-label="定期只读同步状态"
                defaultValue={String(config.data.lark.schedule.config.enabled)}
                key={String(config.data.lark.schedule.config.enabled)}
                name="enabled"
              >
                <option value="false">关闭</option>
                <option value="true">开启</option>
              </select>
            </label>
            <label className="provider-control">
              <span>周期</span>
              <input
                aria-label="定期同步周期"
                defaultValue={config.data.lark.schedule.config.interval}
                key={`${config.data.lark.schedule.config.interval}-${config.data.lark.schedule.config.unit}`}
                min={1}
                name="interval"
                required
                type="number"
              />
            </label>
            <label className="provider-control">
              <span>单位</span>
              <select
                aria-label="定期同步周期单位"
                defaultValue={config.data.lark.schedule.config.unit}
                key={config.data.lark.schedule.config.unit}
                name="unit"
              >
                <option value="minutes">分钟</option>
                <option value="hours">小时</option>
              </select>
            </label>
            <button
              className="secondary-button"
              disabled={savingSyncSchedule}
              type="submit"
            >
              {savingSyncSchedule ? "保存中…" : "保存定期同步"}
            </button>
          </form>
          <p className="muted-copy">
            {config.data.lark.schedule.config.enabled
              ? `下次同步：${formatDate(config.data.lark.schedule.next_run_at)}。触发时若已有同步运行，本周期会跳过。`
              : "定期同步当前已关闭；手动只读同步不受影响。"}
          </p>
        </Section>

        <Section title="Meego source" subtitle="显式项目空间 · 仅同步我参与的工作项">
          <div className="setting-row">
            <div className="setting-icon"><ListTodo size={19} /></div>
            <div>
              <strong>Meegle read-only adapter</strong>
              <span>使用 all_participate_persons() 与 current_login_user() 限定参与范围</span>
            </div>
            <Badge tone={config.data.meego.config.enabled ? "mint" : "neutral"}>
              {config.data.meego.config.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <form className="meego-config-control" onSubmit={saveMeego}>
            <label className="toggle-control">
              <input
                aria-label="开启 Meego 抓取"
                defaultChecked={config.data.meego.config.enabled}
                key={`meego-enabled-${config.data.meego.config.enabled}`}
                name="enabled"
                type="checkbox"
              />
              <span><strong>开启 Meego 抓取</strong><small>关闭后不会执行任何 meegle 业务查询</small></span>
            </label>
            <label className="toggle-control">
              <input
                aria-label="按 Q 标签过滤并排序"
                defaultChecked={config.data.meego.config.qTagTimelineEnabled}
                key={`meego-q-${config.data.meego.config.qTagTimelineEnabled}`}
                name="q_tag_timeline_enabled"
                type="checkbox"
              />
              <span><strong>按 Q 标签过滤并排序</strong><small>仅展示合法 Qxxxxx 标签；关闭时按 updated_at 倒序</small></span>
            </label>
            <label className="provider-control">
              <span>Project keys（每行一个，也支持逗号分隔）</span>
              <textarea
                aria-label="Meego Project keys"
                defaultValue={config.data.meego.config.projectKeys.join("\n")}
                key={config.data.meego.config.projectKeys.join("|")}
                name="project_keys"
                placeholder="例如：618cd556ef01eddedd9e09aa"
                rows={4}
              />
            </label>
            <div className="meego-config-actions">
              <button className="secondary-button" disabled={savingMeego} type="submit">
                {savingMeego ? "保存中…" : "保存 Meego 配置"}
              </button>
              <button
                className="primary-button"
                disabled={!config.data.meego.config.enabled || syncingMeego || meegoStatus.running}
                onClick={() => void syncMeegoFromSettings()}
                type="button"
              >
                <RefreshCw className={syncingMeego || meegoStatus.running ? "spin" : ""} size={16} />
                {syncingMeego || meegoStatus.running ? "同步中…" : "立即同步 Meego"}
              </button>
            </div>
          </form>
          <div className="sync-summary">
            <div><span>最后完成</span><strong>{formatDate(meegoStatus.completedAt)}</strong></div>
            <div><span>成功范围</span><strong>{meegoStatus.results.filter((result) => result.ok && !result.skipped).length}/{meegoStatus.results.filter((result) => !result.skipped).length}</strong></div>
          </div>
          {meegoStatus.lastError && (
            <div className="sync-progress-error"><AlertTriangle size={14} />{meegoStatus.lastError}</div>
          )}
        </Section>

        <Section title="同步状态" subtitle="运行时进度与错误">
          <div className={`sync-progress-window ${liveStatus.running ? "running" : ""}`}>
            <div className="sync-progress-head">
              <span className="sync-progress-dot" />
              <div>
                <strong>{liveStatus.progress?.message ?? "尚未执行同步"}</strong>
                <span>
                  {liveStatus.running
                    ? "同步进行中"
                    : liveStatus.progress?.phase === "failed"
                      ? "存在问题"
                      : liveStatus.progress?.phase === "completed"
                        ? "同步完成"
                        : "空闲"}
                </span>
              </div>
              <Badge tone={liveStatus.running ? "blue" : liveStatus.last_error ? "coral" : "mint"}>
                {liveStatus.progress?.phase ?? "idle"}
              </Badge>
            </div>
            <div className="sync-progress-grid">
              <div><span>当前来源</span><strong>{liveStatus.progress?.source ? larkSourceLabels[liveStatus.progress.source] : "—"}</strong></div>
              <div><span>时间窗口</span><strong>{liveStatus.progress?.window_index !== null && liveStatus.progress?.window_index !== undefined ? `${liveStatus.progress.window_index + 1}/${liveStatus.progress.window_count ?? "?"}` : "—"}</strong></div>
              <div><span>当前页</span><strong>{liveStatus.progress?.page_index !== null && liveStatus.progress?.page_index !== undefined ? liveStatus.progress.page_index + 1 : "—"}</strong></div>
              <div><span>读取 / 新增</span><strong>{liveStatus.progress ? `${liveStatus.progress.received} / ${liveStatus.progress.persisted}` : "0 / 0"}</strong></div>
            </div>
            {liveStatus.progress?.updated_at && <small>更新于 {formatDate(liveStatus.progress.updated_at)}</small>}
            {liveStatus.last_error && <div className="sync-progress-error"><AlertTriangle size={14} />{liveStatus.last_error}</div>}
          </div>
        </Section>

        <Section title="LLM 内容分析" subtitle={`${config.data.analysis.prompt_version} · ${config.data.analysis.schema_version}`}>
          <div className="setting-row">
            <div className="setting-icon analysis-icon"><Sparkles size={19} /></div>
            <div>
              <strong>分析 Provider</strong>
              <span>完整拉取后按容量批量发送上下文；不会让模型执行任务或调用工具</span>
            </div>
            {config.data.analysis.provider_locked && <Badge tone="amber">环境锁定</Badge>}
          </div>
          <label className="provider-control">
            <span>调用方式</span>
            <select
              aria-label="LLM 分析 Provider"
              value={config.data.analysis.current_provider}
              disabled={config.data.analysis.provider_locked || switchingProvider}
              onChange={(event) => void switchProvider(event.target.value)}
            >
              {config.data.analysis.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.id}</option>
              ))}
            </select>
          </label>
          <form className="model-control" onSubmit={saveModel}>
            <label className="provider-control">
              <span>模型（留空使用 Codex 默认）</span>
              <input
                key={config.data.analysis.config.model ?? "codex-default"}
                aria-label="LLM 分析模型"
                name="model"
                defaultValue={config.data.analysis.config.model ?? ""}
                maxLength={200}
                placeholder="例如：账户当前可用的模型 ID"
              />
            </label>
            <button
              className="secondary-button"
              disabled={savingModel}
              type="submit"
            >
              {savingModel ? "保存中…" : "保存模型"}
            </button>
          </form>
          {config.data.analysis.current_provider === "codex-sdk" && (
            <form className="model-control" onSubmit={saveReasoningEffort}>
              <label className="provider-control">
                <span>推理强度</span>
                <select
                  key={config.data.analysis.config.reasoning_effort}
                  aria-label="Codex SDK 推理强度"
                  name="reasoning_effort"
                  defaultValue={config.data.analysis.config.reasoning_effort}
                >
                  {CODEX_REASONING_EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>{effort}</option>
                  ))}
                </select>
              </label>
              <button
                className="secondary-button"
                disabled={savingReasoningEffort}
                type="submit"
              >
                {savingReasoningEffort ? "保存中…" : "保存推理强度"}
              </button>
            </form>
          )}
          <form className="model-control" onSubmit={saveWorkerCount}>
            <label className="provider-control">
              <span>并行分析 Worker（1–8）</span>
              <input
                key={config.data.analysis.worker_count}
                aria-label="LLM Worker 数量"
                defaultValue={config.data.analysis.worker_count}
                disabled={config.data.analysis.worker_count_locked}
                max={8}
                min={1}
                name="worker_count"
                required
                type="number"
              />
            </label>
            <button
              className="secondary-button"
              disabled={
                savingWorkerCount || config.data.analysis.worker_count_locked
              }
              type="submit"
            >
              {savingWorkerCount ? "保存中…" : "保存 Worker 数量"}
            </button>
          </form>
          {config.data.analysis.worker_count_locked && (
            <p className="muted-copy">
              Worker 数量由 CONTEXT_SPACE_ANALYSIS_WORKERS 环境变量锁定。
            </p>
          )}
          <div className="provider-list">
            {config.data.analysis.providers.map((provider) => (
              <div key={provider.id}>
                <span className={`provider-dot ${provider.available ? "available" : ""}`} />
                <span><strong>{provider.id}</strong><small>{provider.detail}</small></span>
                <Badge tone={provider.available ? "mint" : "amber"}>
                  {provider.available ? "可用" : "不可用"}
                </Badge>
              </div>
            ))}
          </div>
          <div className="sync-summary analysis-summary">
            <div><span>排队</span><strong>{config.data.analysis.queue.queued}</strong></div>
            <div><span>运行中</span><strong>{config.data.analysis.queue.leased}</strong></div>
            <div><span>等待重试</span><strong>{config.data.analysis.queue.failed_retryable}</strong></div>
            <div><span>失败终态</span><strong>{config.data.analysis.queue.failed_terminal}</strong></div>
          </div>
          {config.data.analysis.failed_jobs.map((job) => (
            <div className="setting-row" key={job.id}>
              <div className="setting-icon"><AlertTriangle size={19} /></div>
              <div>
                <strong>{job.lastErrorCode ?? "分析失败"}</strong>
                <span>{job.lastErrorMessage ?? job.id}</span>
              </div>
              <button
                className="secondary-button"
                disabled={retryingJob === job.id}
                onClick={() => void retryAnalysisJob(job.id)}
                type="button"
              >
                {retryingJob === job.id ? "重试中…" : "重新排队"}
              </button>
            </div>
          ))}
          <div className="sync-summary analysis-summary">
            <div><span>当前模型</span><strong>{config.data.analysis.config.model ?? "Codex 默认"}</strong></div>
            {config.data.analysis.current_provider === "codex-sdk" && (
              <div><span>推理强度</span><strong>{config.data.analysis.config.reasoning_effort}</strong></div>
            )}
            <div><span>每批记录</span><strong>{config.data.analysis.config.max_batch_records}</strong></div>
            <div><span>每批来源字符</span><strong>{config.data.analysis.config.max_batch_source_chars}</strong></div>
            <div><span>并行 Worker</span><strong>{config.data.analysis.worker_count}</strong></div>
          </div>
          {config.data.analysis.status.last_error_message && (
            <p className="provider-error">{config.data.analysis.status.last_error_message}</p>
          )}
          <p className="muted-copy">
            SDK 方式可能使用 Codex 标准本地会话存储；codex-exec 使用 ephemeral 模式。两种方式均使用只读隔离目录，失败时不会静默切换。
          </p>
        </Section>

        <Section title="Loop safety" subtitle="未来能力的硬边界">
          <div className="setting-row">
            <div className="setting-icon"><Bot size={19} /></div>
            <div><strong>Execution disabled</strong><span>没有执行端点或可用 capability</span></div>
            <Badge tone="purple">V1</Badge>
          </div>
          <div className="policy-list">
            <div><CheckCircle2 size={16} />确认默认必需</div>
            <div><CheckCircle2 size={16} />运行历史不伪造</div>
            <div><CheckCircle2 size={16} />外部动作不可达</div>
          </div>
        </Section>

        <Section title="数据保留" subtitle="原始来源正文">
          <form className="model-control" onSubmit={saveRetention}>
            <label className="provider-control">
              <span>保留天数（1–3650）</span>
              <input
                key={config.data.retention.source_body_days}
                aria-label="来源正文保留天数"
                defaultValue={config.data.retention.source_body_days}
                max={3650}
                min={1}
                name="source_body_days"
                required
                type="number"
              />
            </label>
            <button
              className="secondary-button"
              disabled={savingRetention}
              type="submit"
            >
              {savingRetention ? "保存中…" : "保存保留期"}
            </button>
          </form>
          <p className="muted-copy">
            到期后删除正文，但保留来源 ID、时间、参与者、正文哈希和审计元数据；待审核证据会延迟清理。
          </p>
        </Section>

        <Section title="Priority people" subtitle="只有你能指定 Leader">
          <div className="priority-people">
            <label className="people-search">
              <Search size={15} />
              <input
                aria-label="搜索 Priority people"
                onChange={(event) => setLeaderQuery(event.target.value)}
                placeholder="搜索姓名或角色后添加"
                type="search"
                value={leaderQuery}
              />
            </label>
            {normalizedLeaderQuery && (
              <div className="leader-search-results">
                {leaderSearchResults.map((person) => (
                  <button
                    disabled={updatingLeader === person.id}
                    key={person.id}
                    onClick={() => void updateLeader(person, true)}
                    type="button"
                  >
                    <span className="person-avatar small">{person.title.slice(0, 1)}</span>
                    <span>
                      <strong>{person.title}</strong>
                      <small>{person.role ?? "角色待补充"}</small>
                    </span>
                    <span className="leader-action"><Plus size={14} />添加</span>
                  </button>
                ))}
                {!leaderSearchResults.length && (
                  <span className="leader-search-empty">没有匹配的未添加人物</span>
                )}
              </div>
            )}
            <div className="configured-leaders">
              <span className="configured-leaders-title">
                已添加 · {config.data.leaders.length}
              </span>
              <div className="leader-list">
                {config.data.leaders.map((leader) => {
                  const person = peopleById.get(leader.person_id);
                  const title = person?.title ?? leader.person_id;
                  return (
                    <div className="leader-row selected" key={leader.person_id}>
                      <span className="person-avatar small">{title.slice(0, 1)}</span>
                      <span>
                        <strong>{title}</strong>
                        <small>{person?.role ?? `优先级加权 +${leader.boost}`}</small>
                      </span>
                      <button
                        aria-label={`移除 ${title}`}
                        className="leader-remove"
                        disabled={!person || updatingLeader === leader.person_id}
                        onClick={() => person && void updateLeader(person, false)}
                        title={person ? "移除" : "人物资料缺失，请在配置文件中处理"}
                        type="button"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  );
                })}
                {!config.data.leaders.length && (
                  <span className="leader-search-empty">尚未添加 Priority people</span>
                )}
              </div>
            </div>
            {!people.data.length && <p className="muted-copy">同步上下文后即可搜索并添加人物。</p>}
          </div>
        </Section>

        <Section title="Markdown workspace" subtitle="Canonical source of truth">
          <div className="workspace-code">CONTEXT_SPACE_ROOT=./workspace</div>
          <div className="sync-summary">
            <div><span>文件监听</span><strong>{markdownStatus.data.watcherRunning ? "运行中" : "未启动"}</strong></div>
            <div><span>最近全量校准</span><strong>{formatDate(markdownStatus.data.lastReconciledAt)}</strong></div>
            <div><span>最近增量更新</span><strong>{formatDate(markdownStatus.data.lastIncrementalAt)}</strong></div>
          </div>
          <p className="muted-copy">索引可以随时删除并从 Markdown 重建。`workspace/` 默认不会进入 Git。</p>
          <button className="secondary-button" onClick={async () => { await api("/api/index/rebuild", { method: "POST" }); setMessage("索引已从 Markdown 重建。"); }}>
            <RefreshCw size={16} />重建索引
          </button>
          {diagnostics.data.length > 0 && (
            <div className="policy-list">
              {diagnostics.data.map((diagnostic) => (
                <div key={diagnostic.path}>
                  <AlertTriangle size={16} />
                  {diagnostic.path}：{diagnostic.message}
                </div>
              ))}
            </div>
          )}
          {!diagnostics.loading && diagnostics.data.length === 0 && (
            <p className="muted-copy">Markdown 诊断正常，没有隔离文件。</p>
          )}
        </Section>
      </div>
    </>
  );
}

function SearchPage() {
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";
  const { data, loading, error } = useApi<SearchResult[]>(`/api/search?q=${encodeURIComponent(query)}`, []);
  return (
    <>
      <PageHeader eyebrow="Global search" title={`“${query}”`} description="搜索 Markdown 正文、标题与结构化元数据。" />
      <ErrorBanner message={error} />
      <Section title={`${data.length} 个结果`}>
        <div className="search-results">
          {data.map((result) => (
            <Link to={`/documents/${encodeURIComponent(result.id)}`} className="search-result" key={result.id}>
              <Badge>{result.type}</Badge>
              <div><strong>{result.title}</strong><p>{result.excerpt || "匹配位于结构化元数据中。"}</p></div>
              <ChevronRight size={16} />
            </Link>
          ))}
        </div>
        {!data.length && <EmptyState icon={Search} title={loading ? "正在搜索…" : "没有匹配结果"} description="尝试人物、项目、决策或 Todo 标题。" />}
      </Section>
    </>
  );
}

function DocumentPage() {
  const { id = "" } = useParams();
  const [provenancePage, setProvenancePage] = useState(1);
  const endpoint = `/api/documents/${encodeURIComponent(id)}?provenance_page=${provenancePage}&provenance_page_size=10`;
  const resource = useApi<ApiDocument | null>(endpoint, null);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [saveError, setSaveError] = useState("");
  const [statusSaving, setStatusSaving] = useState(false);

  const document = resource.data;
  async function save() {
    if (!document) return;
    setSaveError("");
    try {
      await api(endpoint, {
        method: "PUT",
        body: JSON.stringify({ etag: document.etag, body })
      });
      setEditing(false);
      await resource.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  async function toggleTodoStatus(todo: TodoMetadata) {
    setStatusSaving(true);
    setSaveError("");
    try {
      await api(`/api/todos/${encodeURIComponent(todo.id)}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          status: todo.status === "done" ? "open" : "done"
        })
      });
      await resource.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setStatusSaving(false);
    }
  }

  if (resource.loading && !document) return <EmptyState title="正在加载文档…" description="读取 Markdown 与来源引用。" />;
  if (!document) return <EmptyState title="文档不存在" description={resource.error ?? "该 ID 未被索引。"} />;

  const todo = document.data.type === "todo" ? (document.data as TodoMetadata) : null;
  const person = document.data.type === "person" ? (document.data as PersonMetadata) : null;
  return (
    <>
      <PageHeader
        eyebrow={`${document.data.type} · ${document.data.managed}`}
        title={document.data.title}
        description={`更新于 ${formatDate(document.data.updated_at)} · ${document.path}`}
        action={
          <div className="page-actions">
            {todo && (
              <button
                className="secondary-button"
                disabled={statusSaving}
                onClick={() => void toggleTodoStatus(todo)}
              >
                <CheckCircle2 size={16} />
                {todo.status === "done" ? "重新打开" : "标记完成"}
              </button>
            )}
            {document.data.managed !== "generated" ? (
              <button className="secondary-button" onClick={() => { setBody(document.body); setEditing(!editing); }}>
                <FileText size={16} />{editing ? "取消编辑" : "编辑 Markdown"}
              </button>
            ) : <Badge tone="neutral">Generated · read only</Badge>}
          </div>
        }
      />
      <ErrorBanner message={resource.error ?? saveError} />
      <div className="detail-layout">
        <Section title="Content" subtitle="Canonical Markdown body">
          {editing ? (
            <div className="editor">
              <textarea value={body} onChange={(event) => setBody(event.target.value)} aria-label="Markdown 内容" />
              <button className="primary-button" onClick={save}><Check size={16} />保存</button>
            </div>
          ) : <div className="markdown-body">{document.body || <span className="muted-copy">No body content.</span>}</div>}
        </Section>
        <div className="detail-side">
          {todo && (
            <Section title="Priority">
              <Priority todo={todo} />
              <div className="meta-list"><div><span>状态</span><strong>{statusLabel(todo.status)}</strong></div><div><span>方向</span><strong>{todo.direction}</strong></div><div><span>到期</span><strong>{formatDate(todo.due_at)}</strong></div></div>
            </Section>
          )}
          {todo && (
            <Section title="Automation" subtitle="Future Loop contract">
              <div className="automation-status"><Bot size={19} /><div><strong>{todo.automation.mode}</strong><span>{todo.automation.requires_confirmation ? "需要人工确认" : "无需确认"}</span></div></div>
              <div className="disabled-control">外部执行不可用</div>
            </Section>
          )}
          {person && document.relationships && (
            <Section title="Mutual commitments">
              <div className="meta-list"><div><span>我欠对方</span><strong>{document.relationships.owedByMe.length}</strong></div><div><span>等待对方</span><strong>{document.relationships.waitingOnThem.length}</strong></div><div><span>共同推进</span><strong>{document.relationships.shared.length}</strong></div></div>
            </Section>
          )}
          {person && (
            <Section title="职场观察" subtitle="LLM 推断 · 可由证据修正">
              <div className="observation-list">
                {person.observations.map((observation, index) => (
                  <article
                    className={`observation ${observation.stale ? "stale" : ""}`}
                    key={observation.insight_key ?? `${observation.observed_at}-${index}`}
                  >
                    <div className="observation-head">
                      <Badge tone={observation.stale ? "amber" : "purple"}>
                        {observation.category
                          ? observationCategoryLabels[observation.category]
                          : "人工观察"}
                      </Badge>
                      <span>{Math.round(observation.confidence * 100)}% · {formatDate(observation.observed_at)}</span>
                    </div>
                    <strong>{observation.text}</strong>
                    <ul>
                      {observation.evidence.map((evidence) => (
                        <li key={evidence}>{evidence}</li>
                      ))}
                    </ul>
                  </article>
                ))}
                {!person.observations.length && (
                  <span className="muted-copy">暂无有证据支撑的职责或协作观察。</span>
                )}
              </div>
            </Section>
          )}
          {person && Boolean(document.acceptedInsights?.length) && (
            <Section title="已接受洞察" subtitle="独立人工 Markdown 备注">
              <div className="observation-list">
                {document.acceptedInsights!.map((insight) => (
                  <Link
                    className="provenance-source"
                    key={insight.id}
                    to={`/documents/${encodeURIComponent(insight.id)}`}
                  >
                    <span>
                      <strong>{insight.title}</strong>
                      <small>{insight.observations.length} 条观察</small>
                    </span>
                  </Link>
                ))}
              </div>
            </Section>
          )}
          <Section title="Provenance">
            <div className="source-refs">
              {document.provenanceSources?.map((source) => (
                <ProvenanceSource key={source.id} source={source} />
              ))}
              {!document.provenanceSources?.length && document.data.source_refs.map((reference) => (
                <code key={reference}>{reference}</code>
              ))}
              {!document.provenanceSources?.length && !document.data.source_refs.length && (
                <span className="muted-copy">没有可解析的来源消息</span>
              )}
            </div>
            {document.provenancePagination && document.provenancePagination.total_pages > 1 && (
              <div className="provenance-pagination">
                <button
                  aria-label="上一页 Provenance"
                  disabled={document.provenancePagination.page <= 1}
                  onClick={() => setProvenancePage(document.provenancePagination!.page - 1)}
                  type="button"
                >
                  <ChevronLeft size={14} />上一页
                </button>
                <span>
                  第 {document.provenancePagination.page} / {document.provenancePagination.total_pages} 页
                  · 共 {document.provenancePagination.total} 条
                </span>
                <button
                  aria-label="下一页 Provenance"
                  disabled={document.provenancePagination.page >= document.provenancePagination.total_pages}
                  onClick={() => setProvenancePage(document.provenancePagination!.page + 1)}
                  type="button"
                >
                  下一页<ChevronRight size={14} />
                </button>
              </div>
            )}
            {typeof document.data.confidence === "number" && <div className="confidence"><span>Confidence</span><strong>{Math.round(document.data.confidence * 100)}%</strong></div>}
            {document.data.analysis && (
              <div className="meta-list">
                <div><span>Provider</span><strong>{document.data.analysis.provider}</strong></div>
                <div><span>Prompt</span><strong>{document.data.analysis.prompt_version}</strong></div>
                <div><span>分析时间</span><strong>{formatDate(document.data.analysis.analyzed_at)}</strong></div>
                <div><span>状态</span><strong>{document.data.analysis.stale ? "结果已过时" : "当前结果"}</strong></div>
              </div>
            )}
          </Section>
          {Boolean(document.backlinks?.length) && (
            <Section title="Backlinks" subtitle="引用当前稳定 ID 的上下文">
              <div className="source-refs">
                {document.backlinks!.map((backlink) => (
                  <Link
                    className="text-link"
                    key={backlink.id}
                    to={`/documents/${encodeURIComponent(backlink.id)}`}
                  >
                    {backlink.title} · {backlink.type}
                  </Link>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

export function AppView() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<NowPage />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/todos" element={<TodosPage />} />
        <Route path="/people" element={<PeoplePage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/timeline" element={<TimelinePage />} />
        <Route path="/meego" element={<MeegoPage />} />
        <Route path="/loop" element={<LoopPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/documents/:id" element={<DocumentPage />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AppView />
    </BrowserRouter>
  );
}

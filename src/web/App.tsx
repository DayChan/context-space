import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleUserRound,
  Clock3,
  FileText,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Menu,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  X
} from "lucide-react";
import { FormEvent, ReactNode, useMemo, useState } from "react";
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
  LeaderConfig,
  LoopReadiness,
  Overview,
  PersonMetadata,
  SearchResult,
  SourceMetadata,
  SyncStatus,
  TodoMetadata,
  WorkspaceDocument
} from "../core/types";
import type {
  AnalysisConfig,
  AnalysisRunMetadata,
  AnalysisStatusMetadata,
  ProviderAvailability
} from "../analysis/contracts";
import { EMPTY_SYNC_STATUS } from "../core/types";
import { api } from "./api";
import { useApi } from "./hooks";
import "./styles.css";

interface ApiDocument<T extends BaseMetadata = BaseMetadata> extends WorkspaceDocument<T> {
  relationships?: {
    owedByMe: TodoMetadata[];
    waitingOnThem: TodoMetadata[];
    shared: TodoMetadata[];
  };
}

const emptyOverview: Overview = {
  topTodos: [],
  upcomingCalendar: [],
  recentMentions: [],
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

const navigation = [
  { to: "/", label: "Now", icon: LayoutDashboard },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/todos", label: "Todos", icon: ListTodo },
  { to: "/people", label: "People", icon: Users },
  { to: "/knowledge", label: "Knowledge", icon: BookOpen },
  { to: "/timeline", label: "Timeline", icon: Activity },
  { to: "/loop", label: "Loop", icon: Bot },
  { to: "/settings", label: "Settings", icon: Settings }
] as const;

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

function TodoRow({ todo, compact = false }: { todo: TodoMetadata; compact?: boolean }) {
  return (
    <Link className={`todo-row ${compact ? "compact" : ""}`} to={`/documents/${encodeURIComponent(todo.id)}`}>
      <span className={`todo-check status-${todo.status}`}>
        {todo.status === "done" ? <Check size={15} /> : <span />}
      </span>
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
        <span>{todo.due_at ? `${formatDate(todo.due_at)} 到期` : statusLabel(todo.status)}</span>
      </div>
      {!compact && <Priority todo={todo} />}
      <ChevronRight size={17} className="row-arrow" />
    </Link>
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

function NowPage() {
  const { data, loading, error } = useApi<Overview>("/api/overview", emptyOverview);
  const today = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(new Date());
  return (
    <>
      <PageHeader
        eyebrow={today}
        title="现在，先做重要的事。"
        description="从消息、日程和任务中汇总出的当前工作上下文。"
        action={<Link className="primary-button" to="/inbox"><Sparkles size={17} />查看待确认</Link>}
      />
      <ErrorBanner message={error} />
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
                <p>{data.loopReadiness.confirmationRequired.length} 项未来需要确认</p>
              </div>
            </div>
            <ChevronRight size={18} />
          </Link>
        </div>
      </div>

      <div className="three-column">
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
  const { data, loading, error } = useApi<ApiDocument[]>("/api/documents?type=candidate", []);
  return (
    <>
      <PageHeader eyebrow="Review queue" title="Inbox" description="不确定的 Todo 和知识先在这里等待确认，而不是直接污染事实。" />
      <ErrorBanner message={error} />
      <div className="document-grid">
        {data.map((document) => (
          <Link className="document-card" key={document.data.id} to={`/documents/${encodeURIComponent(document.data.id)}`}>
            <div className="document-card-top">
              <Badge tone="amber">{document.data.status === "candidate" ? "Todo 候选" : "知识草稿"}</Badge>
              {typeof document.data.confidence === "number" && (
                <span>
                  {document.data.analysis ? `${document.data.analysis.provider} · ` : ""}
                  {Math.round(document.data.confidence * 100)}% confidence
                </span>
              )}
            </div>
            <h3>{document.data.title}</h3>
            <p>{document.body || "等待人工检查来源和上下文。"}</p>
            <div className="document-card-foot"><span>{document.data.source_refs.length} 个来源</span><ChevronRight size={16} /></div>
          </Link>
        ))}
      </div>
      {!data.length && <EmptyState icon={Inbox} title={loading ? "正在加载…" : "Inbox 已清空"} description="低置信度推断会保留来源并进入这里。" />}
    </>
  );
}

function TodosPage() {
  const [direction, setDirection] = useState("all");
  const { data, loading, error } = useApi<ApiDocument<TodoMetadata>[]>("/api/documents?type=todo", []);
  const filtered = useMemo(
    () => data.filter(({ data: todo }) => direction === "all" || todo.direction === direction),
    [data, direction]
  );
  return (
    <>
      <PageHeader eyebrow="Commitments" title="Todos" description="把原生任务与聊天承诺放进同一个、可解释的优先级队列。" />
      <div className="filter-bar" role="group" aria-label="Todo 方向筛选">
        {[
          ["all", "全部"],
          ["owed_by_me", "我来处理"],
          ["waiting_on_them", "等待对方"],
          ["shared", "共同推进"]
        ].map(([value, label]) => (
          <button key={value} className={direction === value ? "active" : ""} onClick={() => setDirection(value)}>{label}</button>
        ))}
      </div>
      <ErrorBanner message={error} />
      <Section title={`${filtered.length} 个事项`} subtitle="优先级原因始终可见">
        {filtered.length ? <div className="list-stack">{filtered.sort((a, b) => b.data.priority.effective - a.data.priority.effective).map(({ data: todo }) => <TodoRow key={todo.id} todo={todo} />)}</div> : <EmptyState icon={ListTodo} title={loading ? "正在加载…" : "没有匹配的 Todo"} description="更换筛选条件或同步新的工作上下文。" />}
      </Section>
    </>
  );
}

function PeoplePage() {
  const { data, loading, error } = useApi<ApiDocument<PersonMetadata>[]>("/api/documents?type=person", []);
  return (
    <>
      <PageHeader eyebrow="Working relationships" title="People" description="角色、协作观察和双方承诺，全部带证据并可修正。" />
      <ErrorBanner message={error} />
      <div className="people-grid">
        {data.map((document) => {
          const person = document.data;
          const openLoops =
            (document.relationships?.owedByMe.length ?? 0) +
            (document.relationships?.waitingOnThem.length ?? 0) +
            (document.relationships?.shared.length ?? 0);
          return (
            <Link className="person-card" key={person.id} to={`/documents/${encodeURIComponent(person.id)}`}>
              <div className="person-avatar">{person.title.slice(0, 1).toUpperCase()}</div>
              <div className="person-card-main">
                <div><h3>{person.title}</h3>{person.is_leader && <Badge tone="coral">Leader +{person.leader_boost}</Badge>}</div>
                <p>{person.role ?? "角色待补充"}</p>
                <div className="person-meta"><span>{openLoops} 个开放承诺</span><span>最近 {formatDate(person.last_interaction_at)}</span></div>
              </div>
              <ChevronRight size={17} />
            </Link>
          );
        })}
      </div>
      {!data.length && <EmptyState icon={Users} title={loading ? "正在加载…" : "还没有人物档案"} description="相关消息、日程和任务会自动发现协作对象。" />}
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

function TimelinePage() {
  const { data, loading, error } = useApi<BaseMetadata[]>("/api/timeline", []);
  return (
    <>
      <PageHeader eyebrow="Source of truth" title="Timeline" description="从原始上下文到派生知识，按更新时间查看可追溯链路。" />
      <ErrorBanner message={error} />
      <div className="timeline">
        {data.map((item) => (
          <Link key={item.id} className="timeline-item" to={`/documents/${encodeURIComponent(item.id)}`}>
            <span className={`timeline-dot type-${item.type}`} />
            <div className="timeline-time">{formatDate(item.updated_at)}</div>
            <div className="timeline-content"><Badge>{item.type}</Badge><strong>{item.title}</strong><small>{item.source_refs.length} source refs</small></div>
            <ChevronRight size={16} />
          </Link>
        ))}
      </div>
      {!data.length && <EmptyState icon={Activity} title={loading ? "正在加载…" : "还没有时间线"} description="同步后的来源与派生内容会按时间串联。" />}
    </>
  );
}

interface LoopResponse {
  enabled: boolean;
  message: string;
  readiness: LoopReadiness;
}

function LoopPage() {
  const { data, error } = useApi<LoopResponse>("/api/loop", {
    enabled: false,
    message: "Automatic execution is not enabled in V1.",
    readiness: { futureAutomatable: [], confirmationRequired: [], blocked: [], recentRuns: [] }
  });
  const columns = [
    { title: "未来可自动化", items: data.readiness.futureAutomatable, icon: Sparkles, tone: "mint", copy: "已批准、等待未来执行器" },
    { title: "需要人工确认", items: data.readiness.confirmationRequired, icon: CircleUserRound, tone: "amber", copy: "建议存在，但必须由你确认" },
    { title: "被条件阻塞", items: data.readiness.blocked, icon: Clock3, tone: "coral", copy: "缺少权限、输入或外部条件" },
    { title: "最近运行", items: data.readiness.recentRuns, icon: Activity, tone: "blue", copy: "V1 不会伪造运行记录" }
  ];
  return (
    <>
      <PageHeader eyebrow="Future automation" title="Loop" description="Todo 自动化的审核和运行工作区，从 V1 起保留位置。" />
      <ErrorBanner message={error} />
      <div className="loop-hero">
        <div className="loop-visual"><span /><span /><span /><Bot size={34} /></div>
        <div>
          <Badge tone="purple">V1 · READ ONLY</Badge>
          <h2>自动执行尚未启用</h2>
          <p>当前页面只展示 readiness。没有执行端点、调度器或外部工具调用，未经确认的推断永远不会触发动作。</p>
        </div>
        <div className="loop-safety"><ShieldCheck size={19} /><span>Safe by construction</span></div>
      </div>
      <div className="loop-columns">
        {columns.map(({ title, items, icon: Icon, tone, copy }) => (
          <section className="loop-column" key={title}>
            <div className="loop-column-head"><span className={`tone-${tone}`}><Icon size={17} /></span><div><strong>{title}</strong><small>{items.length} items</small></div></div>
            {items.length ? items.map((todo: TodoMetadata) => <TodoRow compact todo={todo} key={todo.id} />) : <EmptyState icon={Icon} title="暂无项目" description={copy} />}
          </section>
        ))}
      </div>
      <div className="automation-contract">
        <div><FileText size={19} /><div><strong>Automation contract 已预留</strong><span>mode · handler · confirmation · allowed capabilities</span></div></div>
        <Badge tone="neutral">execution_enabled: false</Badge>
      </div>
    </>
  );
}

interface ConfigResponse {
  leaders: LeaderConfig[];
  lark: { status: SyncStatus; readOnly: boolean; identity: string };
  loop: { enabled: boolean; executionEndpoint: null };
  analysis: {
    current_provider: string;
    config_source: "workspace" | "environment";
    provider_locked: boolean;
    config: AnalysisConfig;
    providers: Array<{ id: string } & ProviderAvailability>;
    prompt_version: string;
    schema_version: string;
    status: AnalysisStatusMetadata;
    recent_runs: AnalysisRunMetadata[];
  };
}

function SettingsPage() {
  const config = useApi<ConfigResponse>("/api/config", {
    leaders: [],
    lark: { status: EMPTY_SYNC_STATUS, readOnly: true, identity: "user" },
    loop: { enabled: false, executionEndpoint: null },
    analysis: {
      current_provider: "codex-sdk",
      config_source: "workspace",
      provider_locked: false,
      config: {
        provider: "codex-sdk",
        model: null,
        timeout_ms: 120000,
        max_source_chars: 20000,
        max_output_bytes: 2000000,
        prompt_version: "context-analysis@1",
        retain_runs: 50,
        max_reanalysis_records: 50
      },
      providers: [],
      prompt_version: "context-analysis@1",
      schema_version: "work-context/analysis@1",
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
      recent_runs: []
    }
  });
  const people = useApi<ApiDocument<PersonMetadata>[]>("/api/documents?type=person", []);
  const [syncing, setSyncing] = useState(false);
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [message, setMessage] = useState("");

  async function syncLark() {
    setSyncing(true);
    setMessage("");
    try {
      await api("/api/sync/lark", { method: "POST" });
      setMessage("只读同步完成。");
      await config.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
    }
  }

  async function toggleLeader(person: PersonMetadata) {
    const current = config.data.leaders;
    const exists = current.some((leader) => leader.person_id === person.id);
    const next = exists
      ? current.filter((leader) => leader.person_id !== person.id)
      : [...current, { person_id: person.id, boost: person.leader_boost || 20 }];
    await api("/api/config/leaders", { method: "PUT", body: JSON.stringify(next) });
    await Promise.all([config.reload(), people.reload()]);
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

  return (
    <>
      <PageHeader eyebrow="Local control" title="Settings" description="数据源、Leader、同步和安全边界都由本地 Markdown 配置。" />
      <ErrorBanner message={config.error ?? people.error} />
      {message && <div className="info-banner">{message}</div>}
      <div className="settings-grid">
        <Section title="Lark source" subtitle="仅用户身份、只读命令">
          <div className="setting-row">
            <div className="setting-icon"><ShieldCheck size={19} /></div>
            <div><strong>Read-only adapter</strong><span>`lark-cli --as {config.data.lark.identity}` · no mutation commands</span></div>
            <Badge tone="mint">Protected</Badge>
          </div>
          <div className="sync-summary">
            <div><span>最后完成</span><strong>{formatDate(config.data.lark.status.completed_at)}</strong></div>
            <div><span>来源结果</span><strong>{config.data.lark.status.results.filter((result) => result.ok).length}/{config.data.lark.status.results.length || 5}</strong></div>
            <div>
              <span>分析失败</span>
              <strong>{config.data.lark.status.results.reduce((sum, result) => sum + (result.analysis_failed ?? 0), 0)}</strong>
            </div>
          </div>
          <button className="primary-button full-button" disabled={syncing} onClick={syncLark}>
            <RefreshCw className={syncing ? "spin" : ""} size={17} />
            {syncing ? "正在同步…" : "立即只读同步"}
          </button>
        </Section>

        <Section title="LLM 内容分析" subtitle={`${config.data.analysis.prompt_version} · ${config.data.analysis.schema_version}`}>
          <div className="setting-row">
            <div className="setting-icon analysis-icon"><Sparkles size={19} /></div>
            <div>
              <strong>分析 Provider</strong>
              <span>只发送当前来源的最小上下文；不会让模型执行任务或调用工具</span>
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
            <div><span>最近状态</span><strong>{config.data.analysis.status.last_status ?? "尚未运行"}</strong></div>
            <div><span>最近 Provider</span><strong>{config.data.analysis.status.last_provider ?? "—"}</strong></div>
            <div><span>完成时间</span><strong>{formatDate(config.data.analysis.status.last_completed_at)}</strong></div>
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

        <Section title="Priority people" subtitle="只有你能指定 Leader">
          <div className="leader-list">
            {people.data.map(({ data: person }) => {
              const active = config.data.leaders.some((leader) => leader.person_id === person.id);
              return (
                <button className={`leader-row ${active ? "selected" : ""}`} key={person.id} onClick={() => void toggleLeader(person)}>
                  <span className="person-avatar small">{person.title.slice(0, 1)}</span>
                  <span><strong>{person.title}</strong><small>{person.role ?? "角色待补充"}</small></span>
                  <span className="leader-toggle">{active ? <Check size={15} /> : null}</span>
                </button>
              );
            })}
            {!people.data.length && <EmptyState icon={Users} title="没有可配置人物" description="同步上下文后即可指定 Leader。" />}
          </div>
        </Section>

        <Section title="Markdown workspace" subtitle="Canonical source of truth">
          <div className="workspace-code">CONTEXT_SPACE_ROOT=./workspace</div>
          <p className="muted-copy">索引可以随时删除并从 Markdown 重建。`workspace/` 默认不会进入 Git。</p>
          <button className="secondary-button" onClick={async () => { await api("/api/index/rebuild", { method: "POST" }); setMessage("索引已从 Markdown 重建。"); }}>
            <RefreshCw size={16} />重建索引
          </button>
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
  const endpoint = `/api/documents/${encodeURIComponent(id)}`;
  const resource = useApi<ApiDocument | null>(endpoint, null);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [saveError, setSaveError] = useState("");

  const document = resource.data;
  async function save() {
    if (!document) return;
    setSaveError("");
    try {
      await api(endpoint, {
        method: "PUT",
        body: JSON.stringify({ etag: document.etag, data: document.data, body })
      });
      setEditing(false);
      await resource.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
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
        action={document.data.managed !== "generated" ? (
          <button className="secondary-button" onClick={() => { setBody(document.body); setEditing(!editing); }}>
            <FileText size={16} />{editing ? "取消编辑" : "编辑 Markdown"}
          </button>
        ) : <Badge tone="neutral">Generated · read only</Badge>}
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
          <Section title="Provenance">
            <div className="source-refs">
              {document.data.source_refs.map((reference) => <code key={reference}>{reference}</code>)}
              {!document.data.source_refs.length && <span className="muted-copy">Manual or baseline document</span>}
            </div>
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

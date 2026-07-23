import { existsSync } from "node:fs";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { AgentConflictError, AgentRequestError } from "../core/agent-errors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  AgentCoordinator,
  AgentLoopService,
  AgentSessionEvents,
  MultiAgentRuntime,
  GitWorkspaceService,
  InvalidAgentRepositoryError,
  MacWorkspaceOpener,
  OpenSpecInspector,
  type AgentEditor,
  type OpenSpecCommandRunner,
  type WorkspaceOpener,
  type AgentRuntime
} from "../agent";
import {
  AnalysisConfigService,
  importLegacyAnalysisConfig
} from "../analysis/config";
import type { AnalysisProvider } from "../analysis/contracts";
import {
  analysisJobIdempotencyKey,
  PersistentAnalysisProcessor,
  type PersistentAnalysisJobConfig
} from "../analysis/persistent-processor";
import {
  CandidateReviewService
} from "../analysis/candidate-review";
import {
  AnalysisWorkerConfigService,
  AnalysisWorkerPool
} from "../analysis/worker";
import { CodexExecProvider } from "../analysis/providers/codex-exec";
import { CodexSdkProvider } from "../analysis/providers/codex-sdk";
import { TraexProvider } from "../analysis/providers/traex";
import { AnalysisProviderRegistry } from "../analysis/providers/registry";
import { ANALYSIS_PROMPT_VERSION } from "../analysis/prompt";
import { ANALYSIS_SCHEMA_VERSION } from "../analysis/schema";
import { LarkAdapter } from "../adapters/lark/adapter";
import { LarkCliCommandRunner, type CommandRunner } from "../adapters/lark/runner";
import {
  LarkCliPermissionChecker,
  LarkPermissionPreflightError,
  type LarkPermissionChecker
} from "../adapters/lark/permissions";
import {
  LarkSyncService,
  syncOptionsFromEnvironment
} from "../adapters/lark/sync";
import {
  LarkSyncScheduleConfigService,
  PeriodicLarkSyncScheduler
} from "../adapters/lark/scheduler";
import {
  MeegoAdapter,
  MeegoConfigService,
  MeegleCliCommandRunner,
  MeegoSyncService,
  type MeegleCommandRunner
} from "../adapters/meego";
import { ContextIndex } from "../core/index";
import { buildMeegoList, meegoItemFromSource } from "../core/meego";
import { MarkdownIndexSync } from "../core/markdown-index-sync";
import {
  DocumentConflictError,
  InvalidDocumentError,
  MarkdownStore,
  UnsafeWorkspacePathError
} from "../core/markdown-store";
import { buildOverview, buildTimeline } from "../core/overview";
import {
  applyLeaderConfiguration,
  commitmentsForPerson,
  personIdForIdentity
} from "../core/people";
import { calculatePriority } from "../core/todo";
import type {
  LeaderConfig,
  PersonMetadata,
  TodoMetadata,
  TodoStatus,
  WorkspaceDocument
} from "../core/types";
import { initializeHumanWorkspace } from "../core/workspace";
import {
  AnalysisJobRepository,
  AgentRepositoryStore,
  AnalysisResultRepository,
  LegacyWorkspaceMigration,
  MachineContextRepository,
  MarkdownIndexRepository,
  SettingsRepository,
  SourceRetentionWorker,
  SyncRepository,
  openMachineDatabase,
  type MachineDatabase
} from "../machine";
import { hashStableValue } from "../analysis/run-store";
import {
  createLogger,
  withLogContext,
  type Logger
} from "../logging";
import { ContextQueryService } from "./context-query";
import { DailySummaryService } from "./daily-summary";
import { HumanDocumentService } from "./human-documents";

const leadersSchema = z.array(
  z.object({
    person_id: z.string().min(1),
    boost: z.number().int().min(0).max(50)
  })
);

const updateDocumentContentSchema = z
  .object({
    etag: z.string().min(1),
    title: z.string().min(1).max(300).optional(),
    body: z.string()
  })
  .strict();

const todoStatusSchema = z
  .object({
    status: z.enum(["open", "done"])
  })
  .strict();

const provenancePaginationSchema = z.object({
  provenance_page: z.coerce.number().int().min(1).default(1),
  provenance_page_size: z.coerce.number().int().min(1).max(50).default(10)
});

const UNKNOWN_SENDER_NAMES = new Set([
  "Unknown",
  "Lark user",
  "Direct message partner"
]);

function sourceMetadataString(
  metadata: Record<string, unknown>,
  key: string
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceConversation(source: {
  provider: string;
  kind: string;
  metadata: Record<string, unknown>;
  participants: Array<{
    provider_id: string;
    name: string;
    role?: string;
  }>;
}, resolveIdentityName: (provider: string, externalId: string) => string | null): {
  type: "direct" | "group";
  name: string;
} | null {
  if (source.kind !== "p2p" && source.kind !== "mention") return null;
  const type = source.kind === "p2p" ? "direct" : "group";
  const chatName = sourceMetadataString(source.metadata, "chat_name");
  if (type === "group") {
    return { type, name: chatName ?? "Group mention" };
  }
  const partner = source.participants.find(({ role }) => role === "partner");
  const resolvedPartnerName = partner
    ? resolveIdentityName(source.provider, partner.provider_id)
    : null;
  const partnerName =
    partner?.name &&
    partner.name !== partner.provider_id &&
    !UNKNOWN_SENDER_NAMES.has(partner.name)
      ? partner.name
      : null;
  return {
    type,
    name: resolvedPartnerName ?? partnerName ?? chatName ?? "Direct message"
  };
}

const timelinePaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20)
});

const reanalysisRangeSchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    limit: z.number().int().positive().optional()
  })
  .strict()
  .refine((value) => Date.parse(value.from) <= Date.parse(value.to), {
    message: "重分析开始时间不能晚于结束时间"
  });

const reanalysisSchema = z.union([
  z.object({ source_id: z.string().min(1) }).strict(),
  reanalysisRangeSchema
]);

const registerAgentRepositorySchema = z.object({ path: z.string().min(1).max(4_096) }).strict();
const agentReadinessQuerySchema = z.object({
  agent: z.enum(["codex", "traex", "claude"]).default("codex")
});
const startAgentSessionSchema = z.object({
  sourceKind: z.enum(["todo", "meego"]),
  sourceId: z.string().min(1),
  repositoryId: z.string().min(1),
  agent: z.enum(["codex", "traex", "claude"]).default("codex"),
  model: z.string().trim().min(1).max(200).nullable().default(null),
  mode: z.enum(["read_only", "isolated_worktree"]),
  workflow: z.union([
    z.object({ kind: z.literal("direct") }).strict(),
    z.object({ kind: z.literal("openspec"), initializeIfMissing: z.boolean() }).strict()
  ]).default({ kind: "direct" }),
  prompt: z.string().min(1).max(100_000)
}).strict();
const agentMessageSchema = z.object({ content: z.string().min(1).max(100_000) }).strict();
const agentConfirmationAnswerSchema = z.object({
  selection: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(10_000).optional()
}).strict().refine((value) => value.selection || value.text, "必须提供确认选项或文本回答");
const cleanupAgentWorkspaceSchema = z.object({}).strict();
const openAgentWorkspaceSchema = z.object({
  editor: z.enum(["trae", "trae_cn", "vscode", "pycharm", "goland"])
}).strict();
const createOpenSpecChangeSchema = z.object({
  name: z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(10_000)
}).strict();

export interface Runtime {
  store: MarkdownStore;
  index: ContextIndex;
  database: MachineDatabase;
  machineContext: MachineContextRepository;
  sync: LarkSyncService;
  syncScheduler: PeriodicLarkSyncScheduler;
  meegoSync: MeegoSyncService;
  meegoConfig: MeegoConfigService;
  agentLoop: AgentLoopService;
  agentStore: AgentRepositoryStore;
  agentCoordinator: AgentCoordinator;
  analysisJobs: AnalysisJobRepository;
  analysisResults: AnalysisResultRepository;
  markdownIndexRepository: MarkdownIndexRepository;
  analysisWorker: AnalysisWorkerPool;
  candidateReview: CandidateReviewService;
  markdownIndexSync: MarkdownIndexSync;
  query: ContextQueryService;
  legacyMigration: LegacyWorkspaceMigration;
  sourceRetention: SourceRetentionWorker;
  analysisConfig: AnalysisConfigService;
  analysisWorkerConfig: AnalysisWorkerConfigService;
  analysisProviders: AnalysisProviderRegistry;
  logger: Logger;
  getLeaders(): Promise<LeaderConfig[]>;
}

export interface CreateAppOptions {
  workspaceRoot: string;
  commandRunner?: CommandRunner;
  larkPermissionChecker?: LarkPermissionChecker;
  meegleCommandRunner?: MeegleCommandRunner;
  agentRuntime?: AgentRuntime;
  workspaceOpener?: WorkspaceOpener;
  openSpecRunner?: OpenSpecCommandRunner;
  analysisProviders?: AnalysisProvider[];
  environment?: NodeJS.ProcessEnv;
  staticRoot?: string;
  logger?: Logger;
}

function mutationRequest(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function allowedRequestOrigins(
  request: Request,
  environment: NodeJS.ProcessEnv
): Set<string> {
  const configured = environment.CONTEXT_SPACE_ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const requestOrigin = `${request.protocol}://${request.get("host")}`;
  return new Set(
    configured?.length
      ? configured
      : [
          requestOrigin,
          "http://127.0.0.1:5173",
          "http://localhost:5173"
        ]
  );
}

function isTodo(document: WorkspaceDocument): document is WorkspaceDocument<TodoMetadata> {
  return document.data.type === "todo";
}

function isPerson(document: WorkspaceDocument): document is WorkspaceDocument<PersonMetadata> {
  return document.data.type === "person";
}

function safeRequestId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : randomUUID();
}

function requestLogPath(request: Request): string {
  const route = request.route as { path?: unknown } | undefined;
  const routePath = typeof route?.path === "string" ? route.path : null;
  return routePath ? `${request.baseUrl}${routePath}` : request.path;
}

function errorStatus(error: unknown): number {
  if (error instanceof DocumentConflictError || error instanceof AgentConflictError) return 409;
  if (
    error instanceof UnsafeWorkspacePathError ||
    error instanceof InvalidDocumentError ||
    error instanceof z.ZodError ||
    error instanceof InvalidAgentRepositoryError ||
    error instanceof AgentRequestError
  ) {
    return 400;
  }
  return 500;
}

function analysisQueueStatus(jobs: AnalysisJobRepository): {
  last_run_id: null;
  last_status: "queued" | "running" | "succeeded" | "failed" | null;
  last_provider: null;
  last_completed_at: null;
  last_error_code: null;
  last_error_message: null;
} {
  const counts = jobs.counts();
  const lastStatus =
    counts.leased > 0
      ? "running"
      : counts.failed_terminal + counts.failed_retryable > 0
        ? "failed"
        : counts.queued > 0
          ? "queued"
          : counts.succeeded > 0
            ? "succeeded"
            : null;
  return {
    last_run_id: null,
    last_status: lastStatus,
    last_provider: null,
    last_completed_at: null,
    last_error_code: null,
    last_error_message: null
  };
}

async function apiDocument(
  document: WorkspaceDocument,
  runtime: Runtime,
  leaders: LeaderConfig[],
  options: {
    includeProvenance?: boolean;
    includeBacklinks?: boolean;
    includePersonInsights?: boolean;
    personTodos?: Array<WorkspaceDocument<TodoMetadata>>;
    provenancePage?: number;
    provenancePageSize?: number;
  } = {}
): Promise<unknown> {
  const backlinks = options.includeBacklinks
    ? runtime.query
        .all()
        .filter(({ data }) => data.source_refs.includes(document.data.id))
        .map(({ data }) => data)
    : undefined;
  const page = options.provenancePage ?? 1;
  const pageSize = options.provenancePageSize ?? 10;
  const personDocument = isPerson(document) ? document : null;
  const provenanceSourceIds = personDocument
    ? [
        ...new Set([
          ...personDocument.data.source_refs,
          ...personDocument.data.observations.flatMap(
            (observation) => observation.source_refs ?? []
          )
        ])
      ]
    : document.data.source_refs;
  const provenanceResult = options.includeProvenance
    ? runtime.machineContext.provenanceSources({
        sourceIds: provenanceSourceIds,
        identities:
          personDocument?.data.identities.map((identity) => ({
            provider: identity.provider,
            externalId: identity.external_id
          })) ?? [],
        limit: pageSize,
        offset: (page - 1) * pageSize
      })
    : { sources: [], total: 0 };
  const totalPages = Math.max(1, Math.ceil(provenanceResult.total / pageSize));
  const normalizedPage = Math.min(page, totalPages);
  const normalizedProvenanceResult =
    options.includeProvenance && normalizedPage !== page
      ? runtime.machineContext.provenanceSources({
          sourceIds: provenanceSourceIds,
          identities:
            personDocument?.data.identities.map((identity) => ({
              provider: identity.provider,
              externalId: identity.external_id
            })) ?? [],
          limit: pageSize,
          offset: (normalizedPage - 1) * pageSize
        })
      : provenanceResult;
  const provenance = options.includeProvenance
    ? {
        provenanceSources: normalizedProvenanceResult.sources.map((source) => ({
          sender: (() => {
            const sender = source.participants.find(
              ({ role }) => role === "sender"
            );
            if (!sender) return null;
            return {
              person_id: personIdForIdentity(
                source.provider,
                sender.provider_id
              ),
              display_name:
                sender.name && !UNKNOWN_SENDER_NAMES.has(sender.name)
                  ? sender.name
                  : "未知发送人"
            };
          })(),
          conversation: sourceConversation(
            source,
            (provider, externalId) =>
              runtime.machineContext.displayNameForIdentity(
                provider,
                externalId
              )
          ),
          id: source.id,
          provider: source.provider,
          title: source.title,
          body: source.body,
          occurred_at: source.occurredAt,
          source_kind: source.kind,
          body_purged_at: source.bodyPurgedAt
        })),
        provenancePagination: {
          page: normalizedPage,
          page_size: pageSize,
          total: normalizedProvenanceResult.total,
          total_pages: totalPages
        }
      }
    : {};
  if (isTodo(document)) {
    return {
      ...document,
      data: {
        ...document.data,
        priority: calculatePriority(document.data, leaders)
      },
      ...provenance,
      ...(backlinks ? { backlinks } : {})
    };
  }
  if (isPerson(document)) {
    const todos =
      options.personTodos ??
      runtime.query.all({ type: "todo" }).filter(isTodo);
    const relationships = commitmentsForPerson(document.data.id, todos);
    const includePersonInsights = options.includePersonInsights ?? true;
    const acceptedInsights = includePersonInsights
      ? runtime.index
          .all<PersonMetadata>({ type: "person" })
          .filter(
            (candidate) =>
              candidate.data.related_person_id === document.data.id
          )
          .map(({ path, data }) => ({
            id: data.id,
            title: data.title,
            path,
            observations: data.observations
          }))
      : [];
    return {
      ...document,
      data: applyLeaderConfiguration(document.data, leaders),
      ...provenance,
      relationships: {
        owedByMe: relationships.owedByMe.map(({ data }) => data),
        waitingOnThem: relationships.waitingOnThem.map(({ data }) => data),
        shared: relationships.shared.map(({ data }) => data)
      },
      acceptedInsights,
      ...(backlinks ? { backlinks } : {})
    };
  }
  return {
    ...document,
    ...provenance,
    ...(backlinks ? { backlinks } : {})
  };
}

export async function createApp(options: CreateAppOptions): Promise<{
  app: express.Express;
  runtime: Runtime;
}> {
  const environment = options.environment ?? process.env;
  const logger =
    options.logger ??
    createLogger({
      workspaceRoot: options.workspaceRoot,
      environment: { ...process.env, ...environment }
    });
  const serverLogger = logger.child({ component: "server" });
  serverLogger.info("application.initializing");
  let store: MarkdownStore;
  try {
    store = await initializeHumanWorkspace(options.workspaceRoot);
  } catch (error) {
    serverLogger.fatal("application.initialization.failed", { error });
    await logger.flush();
    throw error;
  }
  const database = await openMachineDatabase(options.workspaceRoot);
  const markdownIndexRepository = new MarkdownIndexRepository(database);
  const markdownIndexSync = new MarkdownIndexSync(
    store,
    markdownIndexRepository
  );
  const index = new ContextIndex(markdownIndexRepository, markdownIndexSync);
  await markdownIndexSync.reconcile();
  const settings = new SettingsRepository(database);
  await importLegacyAnalysisConfig(store, settings);
  if (!settings.get<string>("workspace_timezone")) {
    const workspaceConfig = (await store.exists("config/workspace.md"))
      ? await store.read("config/workspace.md")
      : null;
    settings.set(
      "workspace_timezone",
      typeof workspaceConfig?.data.timezone === "string"
        ? workspaceConfig.data.timezone
        : "Asia/Shanghai"
    );
  }
  if (!settings.get<LeaderConfig[]>("leaders")) {
    const legacyLeaders = (await store.exists("config/priority-people.md"))
      ? await store.read("config/priority-people.md")
      : null;
    const parsed = leadersSchema.safeParse(legacyLeaders?.data.leaders);
    settings.set("leaders", parsed.success ? parsed.data : []);
  }
  const analysisConfig = new AnalysisConfigService(settings, environment);
  const syncScheduleConfig = new LarkSyncScheduleConfigService(settings);
  const meegoConfig = new MeegoConfigService(settings);
  const analysisWorkerConfig = new AnalysisWorkerConfigService(
    settings,
    environment
  );
  const analysisProviders = new AnalysisProviderRegistry(
    options.analysisProviders ?? [
      new CodexSdkProvider({ environment }),
      new CodexExecProvider({ environment }),
      new TraexProvider({ environment })
    ]
  );
  const machineContext = new MachineContextRepository(database);
  const analysisJobs = new AnalysisJobRepository(database);
  const analysisResults = new AnalysisResultRepository(database);
  const syncRepository = new SyncRepository(database);
  const legacyMigration = new LegacyWorkspaceMigration(
    options.workspaceRoot,
    store,
    database,
    machineContext,
    syncRepository,
    settings
  );
  await legacyMigration.run();
  const sourceRetention = new SourceRetentionWorker(
    machineContext,
    settings
  );
  const candidateReview = new CandidateReviewService(
    analysisResults,
    store,
    async (documentPath) => markdownIndexSync.refreshPath(documentPath)
  );
  await candidateReview.recover();
  const initialAutomaticPublication =
    await candidateReview.publishWithoutReview();
  if (
    initialAutomaticPublication.failures.length ||
    initialAutomaticPublication.operations.some(
      ({ state }) => state === "conflict"
    )
  ) {
    serverLogger.error("analysis.automatic_publication.initial_incomplete", {
      failure_count: initialAutomaticPublication.failures.length,
      conflict_count: initialAutomaticPublication.operations.filter(
        ({ state }) => state === "conflict"
      ).length,
      failures: initialAutomaticPublication.failures
    });
  }
  const analysisProcessor = new PersistentAnalysisProcessor(
    machineContext,
    analysisJobs,
    analysisResults,
    analysisProviders,
    candidateReview,
    logger
  );
  const analysisWorker = new AnalysisWorkerPool(
    analysisJobs,
    analysisProcessor,
    logger,
    {},
    analysisWorkerConfig.getEffective().worker_count
  );
  const query = new ContextQueryService(index, machineContext, analysisResults);
  const dailySummary = new DailySummaryService(store, markdownIndexSync);
  const humanDocuments = new HumanDocumentService(
    store,
    index,
    markdownIndexSync
  );
  const runner =
    options.commandRunner ??
    new LarkCliCommandRunner("lark-cli", logger);
  const larkPermissionChecker =
    options.larkPermissionChecker ??
    new LarkCliPermissionChecker("lark-cli", { environment });
  const sync = new LarkSyncService(
    database,
    machineContext,
    syncRepository,
    analysisJobs,
    new LarkAdapter(runner),
    larkPermissionChecker,
    async (): Promise<PersistentAnalysisJobConfig> => ({
      analysis: (await analysisConfig.getEffective()).config,
      timezone:
        settings.get<string>("workspace_timezone") ?? "Asia/Shanghai",
      currentUserId:
        settings.get<string>("current_user_id") ?? "self"
    }),
    logger,
    syncOptionsFromEnvironment(environment)
  );
  await sync.loadStatus();
  const syncScheduler = new PeriodicLarkSyncScheduler(
    sync,
    syncScheduleConfig,
    logger
  );
  const meegleRunner =
    options.meegleCommandRunner ??
    new MeegleCliCommandRunner("meegle", logger);
  const meegoSync = new MeegoSyncService(
    machineContext,
    meegoConfig,
    new MeegoAdapter(meegleRunner),
    logger
  );
  const agentStore = new AgentRepositoryStore(database);
  const agentEvents = new AgentSessionEvents();
  const agentCoordinator = new AgentCoordinator(
    agentStore,
    options.agentRuntime ?? new MultiAgentRuntime(),
    agentEvents,
    logger
  );
  const openSpecInspector = new OpenSpecInspector(options.openSpecRunner);
  const agentLoop = new AgentLoopService(
    agentStore,
    new GitWorkspaceService(options.workspaceRoot),
    agentCoordinator,
    openSpecInspector
  );
  const workspaceOpener = options.workspaceOpener ?? new MacWorkspaceOpener();

  const runtime: Runtime = {
    store,
    index,
    database,
    machineContext,
    sync,
    syncScheduler,
    meegoSync,
    meegoConfig,
    agentLoop,
    agentStore,
    agentCoordinator,
    analysisJobs,
    analysisResults,
    markdownIndexRepository,
    analysisWorker,
    candidateReview,
    markdownIndexSync,
    query,
    legacyMigration,
    sourceRetention,
    analysisConfig,
    analysisWorkerConfig,
    analysisProviders,
    logger,
    async getLeaders() {
      const parsed = leadersSchema.safeParse(
        settings.get<LeaderConfig[]>("leaders") ?? []
      );
      return parsed.success ? parsed.data : [];
    }
  };

  const app = express();
  const csrfToken = randomBytes(32).toString("base64url");
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const requestId = safeRequestId(request.get("x-request-id"));
    const started = process.hrtime.bigint();
    let completed = false;
    response.setHeader("x-request-id", requestId);
    withLogContext({ request_id: requestId }, () => {
      const finish = (aborted: boolean) => {
        if (completed) return;
        completed = true;
        withLogContext({ request_id: requestId }, () => {
          const durationMs =
            Number(process.hrtime.bigint() - started) / 1_000_000;
          const fields = {
            method: request.method,
            path: requestLogPath(request),
            status_code: response.statusCode,
            duration_ms: Math.round(durationMs * 100) / 100
          };
          if (aborted) {
            serverLogger.warn("http.request.aborted", fields);
          } else if (response.statusCode >= 500) {
            serverLogger.error("http.request.completed", fields);
          } else if (response.statusCode >= 400) {
            serverLogger.warn("http.request.completed", fields);
          } else {
            serverLogger.info("http.request.completed", fields);
          }
        });
      };
      response.once("finish", () => finish(false));
      response.once("close", () => finish(!response.writableEnded));
      next();
    });
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/security/csrf", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ token: csrfToken });
  });
  app.use((request, response, next) => {
    if (!mutationRequest(request.method)) {
      next();
      return;
    }
    const origin = request.get("origin");
    if (origin && !allowedRequestOrigins(request, environment).has(origin)) {
      response.status(403).json({ error: "请求 Origin 不受信任" });
      return;
    }
    if (!tokenMatches(request.get("x-context-space-csrf"), csrfToken)) {
      response.status(403).json({ error: "CSRF Token 无效或缺失" });
      return;
    }
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "context-space",
      indexSize: index.size,
      loopExecutionEnabled: true,
      automaticLoopExecutionEnabled: false
    });
  });

  app.get("/api/overview", async (_request, response) => {
    const leaders = await runtime.getLeaders();
    response.json({
      ...buildOverview(query.all(), leaders, sync.getStatus()),
      analysisQueue: analysisJobs.counts()
    });
  });

  app.get("/api/documents", async (request, response) => {
    const type = typeof request.query.type === "string" ? request.query.type : undefined;
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    const direction =
      typeof request.query.direction === "string" ? request.query.direction : undefined;
    const leaders = await runtime.getLeaders();
    const selected = query.all({ type, status, direction });
    const personTodos = selected.some(isPerson)
      ? query.all({ type: "todo" }).filter(isTodo)
      : undefined;
    response.json(
      await Promise.all(
        selected.map((document) =>
          apiDocument(document, runtime, leaders, {
            includePersonInsights: false,
            personTodos
          })
        )
      )
    );
  });

  app.get("/api/documents/:id", async (request, response) => {
    const document = query.byId(request.params.id);
    if (!document) {
      response.status(404).json({ error: "Document not found" });
      return;
    }
    const provenancePagination = provenancePaginationSchema.parse(request.query);
    response.json(await apiDocument(
      document,
      runtime,
      await runtime.getLeaders(),
      {
        includeProvenance: true,
        includeBacklinks: true,
        provenancePage: provenancePagination.provenance_page,
        provenancePageSize: provenancePagination.provenance_page_size
      }
    ));
  });

  app.put("/api/documents/:id", async (request, response) => {
    const input = updateDocumentContentSchema.parse(request.body);
    const existing = index.byId(request.params.id);
    if (!existing) {
      const machineOwned = query.byId(request.params.id);
      response
        .status(machineOwned ? 403 : 404)
        .json({
          error: machineOwned
            ? "Generated documents are read-only"
            : "Document not found"
        });
      return;
    }
    if (existing.data.managed === "generated") {
      response.status(403).json({ error: "Generated documents are read-only" });
      return;
    }
    const saved = await humanDocuments.updateContent({
      id: request.params.id,
      etag: input.etag,
      ...(input.title ? { title: input.title } : {}),
      body: input.body
    });
    response.json(saved);
  });

  app.patch("/api/todos/:id/status", async (request, response) => {
    const input = todoStatusSchema.parse(request.body);
    const existing = query.byId(request.params.id) as
      | WorkspaceDocument<TodoMetadata>
      | undefined;
    if (!existing || existing.data.type !== "todo") {
      response.status(404).json({ error: "Todo not found" });
      return;
    }
    if (existing.data.managed === "generated") {
      response.status(403).json({ error: "Upstream tasks are read-only" });
      return;
    }
    const saved = await humanDocuments.updateTodoStatus(
      request.params.id,
      input.status as TodoStatus
    );
    if (!saved) {
      response.status(404).json({ error: "Todo not found" });
      return;
    }
    response.json(await apiDocument(saved, runtime, await runtime.getLeaders()));
  });

  app.get("/api/search", (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q : "";
    const type = typeof request.query.type === "string" ? request.query.type : undefined;
    response.json(runtime.query.search(query, type));
  });

  app.get("/api/timeline", (request, response) => {
    const pagination = timelinePaginationSchema.parse(request.query);
    const timeline = buildTimeline(query.all());
    const total = timeline.length;
    const totalPages = Math.max(1, Math.ceil(total / pagination.page_size));
    const page = Math.min(pagination.page, totalPages);
    const pageStart = (page - 1) * pagination.page_size;
    response.json({
      items: timeline.slice(pageStart, pageStart + pagination.page_size),
      pagination: {
        page,
        page_size: pagination.page_size,
        total,
        total_pages: totalPages
      }
    });
  });

  app.post("/api/summaries/daily", async (_request, response) => {
    const now = new Date();
    const timezone =
      settings.get<string>("workspace_timezone") ?? "Asia/Shanghai";
    const dateParts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
      })
        .formatToParts(now)
        .map(({ type, value }) => [type, value])
    );
    const date = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    const overview = buildOverview(
      query.all(),
      await runtime.getLeaders(),
      sync.getStatus(),
      now
    );
    response.status(201).json(await dailySummary.create(date, overview));
  });

  app.get("/api/config", async (_request, response) => {
    const effectiveAnalysis = await analysisConfig.getEffective();
    const effectiveWorkers = analysisWorkerConfig.getEffective();
    const registeredProviders = await Promise.all(
      analysisProviders.all().map(async (provider) => ({
        id: provider.id,
        ...(await provider.getAvailability())
      }))
    );
    const providers = analysisProviders.has(effectiveAnalysis.config.provider)
      ? registeredProviders
      : [
          ...registeredProviders,
          {
            id: effectiveAnalysis.config.provider,
            available: false,
            detail: "当前配置的 Provider 未注册"
          }
        ];
    response.json({
      leaders: await runtime.getLeaders(),
      lark: {
        status: sync.getStatus(),
        readOnly: true,
        identity: "user",
        schedule: syncScheduler.status()
      },
      meego: {
        config: meegoConfig.get(),
        status: meegoSync.getStatus(),
        readOnly: true
      },
      loop: {
        enabled: true,
        automaticExecutionEnabled: false,
        executionEndpoint: "/api/agent/sessions"
      },
      retention: {
        source_body_days: settings.getSourceRetentionDays()
      },
      analysis: {
        current_provider: effectiveAnalysis.config.provider,
        config_source: effectiveAnalysis.source,
        provider_locked: effectiveAnalysis.provider_locked,
        worker_count: effectiveWorkers.worker_count,
        worker_count_source: effectiveWorkers.source,
        worker_count_locked: effectiveWorkers.locked,
        config: effectiveAnalysis.config,
        providers,
        prompt_version: ANALYSIS_PROMPT_VERSION,
        schema_version: ANALYSIS_SCHEMA_VERSION,
        status: analysisQueueStatus(analysisJobs),
        queue: analysisJobs.counts(),
        failed_jobs: analysisJobs.list("failed_terminal", 20),
        recent_runs: []
      }
    });
  });

  app.put("/api/config/leaders", async (request, response) => {
    const leaders = leadersSchema.parse(request.body);
    settings.set("leaders", leaders);
    response.json({ leaders });
  });

  app.put("/api/config/meego", (request, response) => {
    const config = meegoConfig.update(request.body);
    response.json({ config, status: meegoSync.getStatus(), readOnly: true });
  });

  app.put("/api/config/analysis", async (request, response) => {
    const provider =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>).provider
        : undefined;
    if (typeof provider === "string" && !analysisProviders.has(provider)) {
      response.status(400).json({ error: `未注册的分析 Provider：${provider}` });
      return;
    }
    const current = await analysisConfig.getEffective();
    if (
      current.provider_locked &&
      typeof provider === "string" &&
      provider !== current.config.provider
    ) {
      response.status(409).json({ error: "分析 Provider 已被环境变量锁定" });
      return;
    }
    const effective = await analysisConfig.update(request.body);
    response.json(effective);
  });

  app.put("/api/config/analysis/workers", (request, response) => {
    const current = analysisWorkerConfig.getEffective();
    const requested =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>).worker_count
        : undefined;
    if (
      current.locked &&
      requested !== undefined &&
      requested !== current.worker_count
    ) {
      response.status(409).json({ error: "LLM Worker 数量已被环境变量锁定" });
      return;
    }
    const effective = analysisWorkerConfig.update(request.body);
    analysisWorker.setWorkerCount(effective.worker_count);
    response.json(effective);
  });

  app.put("/api/config/retention", (request, response) => {
    const input = z
      .object({ source_body_days: z.number().int().min(1).max(3650) })
      .strict()
      .parse(request.body);
    settings.setSourceRetentionDays(input.source_body_days);
    response.json(input);
  });

  app.put("/api/config/lark-sync-schedule", (request, response) => {
    syncScheduleConfig.update(request.body);
    syncScheduler.reschedule();
    response.json(syncScheduler.status());
  });

  app.get("/api/analysis/status", async (_request, response) => {
    response.json({
      status: analysisQueueStatus(analysisJobs),
      queue: analysisJobs.counts(),
      failed_jobs: analysisJobs.list("failed_terminal", 20),
      recent_runs: []
    });
  });

  app.post("/api/analysis/jobs/:id/retry", (request, response) => {
    const job = analysisJobs.get(request.params.id);
    if (!job) {
      response.status(404).json({ error: "Analysis job not found" });
      return;
    }
    if (job.status !== "failed_terminal") {
      response.status(409).json({ error: "只有终态失败任务可以手动重试" });
      return;
    }
    response.json(analysisJobs.retry(job.id));
  });

  app.get("/api/candidates", (request, response) => {
    const rawStatus =
      typeof request.query.status === "string"
        ? request.query.status
        : "reviewable";
    if (rawStatus === "reviewable") {
      response.json(
        candidateReview
          .list(null)
          .filter(
            ({ kind, status }) =>
              kind === "knowledge" &&
              (status === "proposed" || status === "pending")
          )
          .map((candidate) => ({
            ...candidate,
            acceptance: analysisResults.getAcceptance(candidate.id)
          }))
      );
      return;
    }
    const status =
      rawStatus === "all"
        ? null
        : z
            .enum(["proposed", "rejected", "pending", "accepted"])
            .parse(rawStatus);
    response.json(
      candidateReview.list(status).map((candidate) => ({
        ...candidate,
        acceptance: analysisResults.getAcceptance(candidate.id)
      }))
    );
  });

  app.get("/api/candidates/:id", (request, response) => {
    const candidate = candidateReview.get(request.params.id);
    if (!candidate) {
      response.status(404).json({ error: "Candidate not found" });
      return;
    }
    response.json({
      ...candidate,
      acceptance: analysisResults.getAcceptance(candidate.id)
    });
  });

  app.post("/api/candidates/:id/reject", (request, response) => {
    const candidate = candidateReview.get(request.params.id);
    if (!candidate) {
      response.status(404).json({ error: "Candidate not found" });
      return;
    }
    response.json(candidateReview.reject(request.params.id));
  });

  app.post("/api/candidates/:id/accept", async (request, response) => {
    const candidate = candidateReview.get(request.params.id);
    if (!candidate) {
      response.status(404).json({ error: "Candidate not found" });
      return;
    }
    const operation = await candidateReview.accept(request.params.id);
    if (operation.state === "conflict") {
      response.status(409).json({
        error: operation.error ?? "候选物化发生冲突",
        operation
      });
      return;
    }
    response.json(operation);
  });

  app.post("/api/analysis/reanalyze", async (request, response) => {
    const input = reanalysisSchema.parse(request.body);
    const effective = await analysisConfig.getEffective();
    const jobConfig: PersistentAnalysisJobConfig = {
      analysis: effective.config,
      timezone:
        settings.get<string>("workspace_timezone") ?? "Asia/Shanghai",
      currentUserId:
        settings.get<string>("current_user_id") ?? "self"
    };
    const selected =
      "source_id" in input
        ? [machineContext.getSource(input.source_id)].filter(
            (source): source is NonNullable<typeof source> => Boolean(source)
          )
        : machineContext.listSources({
            kinds: ["mention", "p2p"],
            from: input.from,
            to: input.to,
            limit: Math.min(
              input.limit ?? effective.config.max_reanalysis_records,
              effective.config.max_reanalysis_records
            )
          });
    if ("source_id" in input && !selected.length) {
      response.status(404).json({ error: `来源不存在：${input.source_id}` });
      return;
    }
    const sourceIds = selected.map(({ id }) => id);
    const sourceHash = hashStableValue(
      selected.map(({ id, bodyHash }) => ({ id, bodyHash }))
    );
    const baseKey = analysisJobIdempotencyKey({
      sourceIds,
      sourceHash,
      config: jobConfig
    });
    const job = analysisJobs.enqueue({
      idempotencyKey: hashStableValue({
        baseKey,
        explicitReanalysis: randomUUID()
      }),
      sourceIds,
      config: jobConfig as unknown as Record<string, unknown>
    });
    response.status(202).json({
      requested: sourceIds.length,
      queued: sourceIds.length,
      job_id: job.id
    });
  });

  app.post("/api/index/rebuild", async (_request, response) => {
    const count = await markdownIndexSync.reconcile();
    response.json({ ok: true, count });
  });

  app.get("/api/markdown/diagnostics", (_request, response) => {
    response.json(markdownIndexRepository.diagnostics());
  });

  app.get("/api/markdown/status", (_request, response) => {
    response.json(markdownIndexSync.status());
  });

  app.get("/api/migration/report", (_request, response) => {
    response.json(settings.get("legacy_migration_last_report") ?? null);
  });

  app.post("/api/migration/backup", async (request, response) => {
    const confirmed =
      request.body &&
      typeof request.body === "object" &&
      (request.body as Record<string, unknown>).confirmed === true;
    if (!confirmed) {
      response.status(400).json({
        error: "备份旧机器 Markdown 前必须显式提交 confirmed=true"
      });
      return;
    }
    response.json(await legacyMigration.backup({ confirmed: true }));
  });

  app.post("/api/sync/lark", async (_request, response, next) => {
    try {
      const status = await sync.sync();
      response.json(status);
    } catch (error) {
      if (error instanceof LarkPermissionPreflightError) {
        response.status(409).json({
          error: error.message,
          preflight: error.preflight
        });
        return;
      }
      next(error);
    }
  });

  app.get("/api/sync/lark/preflight", async (_request, response, next) => {
    try {
      response.json(await sync.checkPermissions());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sync/lark/status", (_request, response) => {
    response.json(sync.getStatus());
  });

  app.get("/api/meego", (_request, response) => {
    response.json(
      buildMeegoList(
        machineContext.listSources({ kinds: ["meego"] }),
        meegoConfig.get()
      )
    );
  });

  app.post("/api/sync/meego", async (_request, response, next) => {
    try {
      response.json(await meegoSync.sync());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sync/meego/status", (_request, response) => {
    response.json(meegoSync.getStatus());
  });

  app.get("/api/agent/repositories", (_request, response) => {
    response.json(agentLoop.repositories());
  });

  app.post("/api/agent/repositories", async (request, response, next) => {
    try {
      const input = registerAgentRepositorySchema.parse(request.body);
      response.status(201).json(await agentLoop.registerRepository(input.path));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/agent/repositories/:id", (request, response, next) => {
    try {
      agentLoop.removeRepository(request.params.id);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent/sessions", (_request, response) => {
    response.json(agentLoop.list());
  });

  app.get("/api/agent/sessions/:id", (request, response) => {
    const session = agentLoop.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Agent 会话不存在" });
      return;
    }
    response.json(session);
  });

  app.post("/api/agent/sessions", async (request, response, next) => {
    try {
      const input = startAgentSessionSchema.parse(request.body);
      let title: string;
      if (input.sourceKind === "todo") {
        const document = query.byId(input.sourceId);
        if (!document || !isTodo(document)) throw new InvalidAgentRepositoryError("Todo 不存在");
        if (!["open", "in_progress"].includes(document.data.status) || document.data.direction === "waiting_on_them") {
          throw new InvalidAgentRepositoryError("该 Todo 当前不可启动 Agent");
        }
        title = document.data.title;
      } else {
        const source = machineContext.getSource(input.sourceId);
        const item = source ? meegoItemFromSource(source) : null;
        if (!item || item.completed) throw new InvalidAgentRepositoryError("Meego 条目不存在或已完成");
        title = item.title;
      }
      response.status(202).json(await agentLoop.start({
        ...input,
        title,
        workflowKind: input.workflow.kind,
        initializeIfMissing: input.workflow.kind === "openspec" && input.workflow.initializeIfMissing
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/sessions/:id/messages", (request, response, next) => {
    try {
      const input = agentMessageSchema.parse(request.body);
      response.status(202).json(agentLoop.send(request.params.id, input.content));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent/repositories/:id/openspec-readiness", (request, response, next) => {
    try {
      const { agent } = agentReadinessQuerySchema.parse(request.query);
      response.json(agentLoop.openSpecReadiness(request.params.id, agent));
    }
    catch (error) { next(error); }
  });

  app.get("/api/agent/sessions/:id/openspec/changes", async (request, response, next) => {
    try { response.json(await agentLoop.openSpecChanges(request.params.id)); }
    catch (error) { next(error); }
  });

  app.get("/api/agent/sessions/:id/openspec/changes/:change/workflow", async (request, response, next) => {
    try { response.json(await agentLoop.openSpecWorkflow(request.params.id, request.params.change)); }
    catch (error) { next(error); }
  });

  app.post("/api/agent/sessions/:id/openspec/changes", (request, response, next) => {
    try {
      const input = createOpenSpecChangeSchema.parse(request.body);
      response.status(202).json(agentLoop.createOpenSpecChange(request.params.id, input.name, input.description));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/confirmations/:id/answer", async (request, response, next) => {
    try {
      response.json(await agentLoop.answer(
        request.params.id,
        agentConfirmationAnswerSchema.parse(request.body)
      ));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/sessions/:id/stop", (request, response) => {
    response.json({ stopped: agentLoop.stop(request.params.id) });
  });

  app.post("/api/agent/sessions/:id/accept", (request, response, next) => {
    try { response.json(agentLoop.accept(request.params.id)); }
    catch (error) { next(error); }
  });

  app.post("/api/agent/sessions/:id/cancel", (request, response, next) => {
    try { response.json(agentLoop.cancel(request.params.id)); }
    catch (error) { next(error); }
  });

  app.post("/api/agent/sessions/:id/upgrade-workspace", async (request, response, next) => {
    try { response.json(await agentLoop.upgrade(request.params.id)); }
    catch (error) { next(error); }
  });

  app.post("/api/agent/sessions/:id/cleanup-workspace", async (request, response, next) => {
    try {
      cleanupAgentWorkspaceSchema.parse(request.body ?? {});
      response.json(await agentLoop.cleanup(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/sessions/:id/open-workspace", async (request, response, next) => {
    try {
      const session = agentLoop.get(request.params.id);
      if (!session) throw new AgentRequestError("Agent 会话不存在");
      if (session.workspaceLifecycle === "removed") throw new AgentRequestError("Agent 工作区已被清理");
      if (!existsSync(session.workspacePath)) throw new AgentRequestError("Agent 工作区路径不存在");
      const { editor } = openAgentWorkspaceSchema.parse(request.body) as { editor: AgentEditor };
      const result = await workspaceOpener.open(editor, session.workspacePath);
      response.json({ editor, path: session.workspacePath, ...result });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent/events", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    response.write("event: ready\ndata: {}\n\n");
    const unsubscribe = agentEvents.subscribe((sessionId) => {
      response.write(`event: session.changed\ndata: ${JSON.stringify({ sessionId })}\n\n`);
    });
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
    heartbeat.unref();
    request.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/loop", async (_request, response) => {
    const overview = buildOverview(
      query.all(),
      await runtime.getLeaders(),
      sync.getStatus()
    );
    response.json({
      enabled: true,
      automaticExecutionEnabled: false,
      message: "仅支持人工启动 Agent；自动执行仍未启用。",
      readiness: overview.loopReadiness,
      sessions: agentLoop.list()
    });
  });

  if (options.staticRoot && existsSync(options.staticRoot)) {
    const staticRoot = path.resolve(options.staticRoot);
    app.use(express.static(staticRoot));
    app.use((request, response, next) => {
      if (request.method === "GET" && !request.path.startsWith("/api/")) {
        response.sendFile(path.join(staticRoot, "index.html"));
        return;
      }
      next();
    });
  }

  app.use((request, response) => {
    response.status(404).json({ error: `Route not found: ${request.method} ${request.path}` });
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction
    ) => {
      void next;
      const status = errorStatus(error);
      const fields = {
        status_code: status,
        error_type: error instanceof Error ? error.name : typeof error,
        error
      };
      if (status >= 500) {
        serverLogger.error("http.request.failed", fields);
      } else {
        serverLogger.warn("http.request.failed", fields);
      }
      if (status === 409) {
        response.status(409).json({
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      if (status === 400) {
        response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      response.status(500).json({
        error: error instanceof Error ? error.message : "Unexpected server error"
      });
    }
  );

  serverLogger.info("application.initialized", {
    index_size: index.size,
    analysis_provider_count: analysisProviders.all().length
  });
  return { app, runtime };
}

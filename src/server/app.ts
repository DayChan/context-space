import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { AnalysisConfigService } from "../analysis/config";
import { AnalysisCoordinator } from "../analysis/coordinator";
import type { AnalysisProvider } from "../analysis/contracts";
import { CodexExecProvider } from "../analysis/providers/codex-exec";
import { CodexSdkProvider } from "../analysis/providers/codex-sdk";
import { AnalysisProviderRegistry } from "../analysis/providers/registry";
import { ANALYSIS_PROMPT_VERSION } from "../analysis/prompt";
import { ANALYSIS_SCHEMA_VERSION } from "../analysis/schema";
import { LarkAdapter } from "../adapters/lark/adapter";
import { LarkCliCommandRunner, type CommandRunner } from "../adapters/lark/runner";
import { LarkSyncService } from "../adapters/lark/sync";
import { ContextIndex } from "../core/index";
import {
  DocumentConflictError,
  InvalidDocumentError,
  MarkdownStore,
  UnsafeWorkspacePathError
} from "../core/markdown-store";
import { buildOverview, buildTimeline } from "../core/overview";
import {
  applyLeaderConfiguration,
  commitmentsForPerson
} from "../core/people";
import { calculatePriority } from "../core/todo";
import type {
  BaseMetadata,
  LeaderConfig,
  PersonMetadata,
  TodoMetadata,
  WorkspaceDocument
} from "../core/types";
import { nowIso } from "../core/types";
import { initializeWorkspace } from "../core/workspace";

const leadersSchema = z.array(
  z.object({
    person_id: z.string().min(1),
    boost: z.number().int().min(0).max(50)
  })
);

const updateSchema = z.object({
  etag: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  body: z.string()
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

export interface Runtime {
  store: MarkdownStore;
  index: ContextIndex;
  sync: LarkSyncService;
  analysis: AnalysisCoordinator;
  analysisConfig: AnalysisConfigService;
  analysisProviders: AnalysisProviderRegistry;
  getLeaders(): Promise<LeaderConfig[]>;
}

export interface CreateAppOptions {
  workspaceRoot: string;
  commandRunner?: CommandRunner;
  analysisProviders?: AnalysisProvider[];
  environment?: NodeJS.ProcessEnv;
  staticRoot?: string;
}

function isTodo(document: WorkspaceDocument): document is WorkspaceDocument<TodoMetadata> {
  return document.data.type === "todo";
}

function isPerson(document: WorkspaceDocument): document is WorkspaceDocument<PersonMetadata> {
  return document.data.type === "person";
}

async function apiDocument(
  document: WorkspaceDocument,
  runtime: Runtime,
  leaders: LeaderConfig[]
): Promise<unknown> {
  if (isTodo(document)) {
    return {
      ...document,
      data: {
        ...document.data,
        priority: calculatePriority(document.data, leaders)
      }
    };
  }
  if (isPerson(document)) {
    const todos = runtime.index.all<TodoMetadata>().filter(isTodo);
    const relationships = commitmentsForPerson(document.data.id, todos);
    return {
      ...document,
      data: applyLeaderConfiguration(document.data, leaders),
      relationships: {
        owedByMe: relationships.owedByMe.map(({ data }) => data),
        waitingOnThem: relationships.waitingOnThem.map(({ data }) => data),
        shared: relationships.shared.map(({ data }) => data)
      }
    };
  }
  return document;
}

export async function createApp(options: CreateAppOptions): Promise<{
  app: express.Express;
  runtime: Runtime;
}> {
  const store = await initializeWorkspace(options.workspaceRoot);
  const index = new ContextIndex();
  await index.rebuild(store);
  const environment = options.environment ?? process.env;
  const analysisConfig = new AnalysisConfigService(store, environment);
  const analysisProviders = new AnalysisProviderRegistry(
    options.analysisProviders ?? [
      new CodexSdkProvider({ environment }),
      new CodexExecProvider({ environment })
    ]
  );
  const analysis = new AnalysisCoordinator(store, index, analysisProviders, analysisConfig);
  const runner = options.commandRunner ?? new LarkCliCommandRunner();
  const sync = new LarkSyncService(store, index, new LarkAdapter(runner), analysis);
  await sync.loadStatus();

  const runtime: Runtime = {
    store,
    index,
    sync,
    analysis,
    analysisConfig,
    analysisProviders,
    async getLeaders() {
      const document = await store.read("config/priority-people.md");
      const parsed = leadersSchema.safeParse(document.data.leaders);
      return parsed.success ? parsed.data : [];
    }
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "context-space",
      indexSize: index.size,
      loopExecutionEnabled: false
    });
  });

  app.get("/api/overview", async (_request, response) => {
    const leaders = await runtime.getLeaders();
    response.json(buildOverview(index.all(), leaders, sync.getStatus()));
  });

  app.get("/api/documents", async (request, response) => {
    const type = typeof request.query.type === "string" ? request.query.type : undefined;
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    const direction =
      typeof request.query.direction === "string" ? request.query.direction : undefined;
    const leaders = await runtime.getLeaders();
    const selected = index
      .all()
      .filter((document) => !type || document.data.type === type)
      .filter((document) => !status || document.data.status === status)
      .filter(
        (document) =>
          !direction ||
          (document.data.type === "todo" && (document.data as TodoMetadata).direction === direction)
      );
    response.json(
      await Promise.all(selected.map((document) => apiDocument(document, runtime, leaders)))
    );
  });

  app.get("/api/documents/:id", async (request, response) => {
    const document = index.byId(request.params.id);
    if (!document) {
      response.status(404).json({ error: "Document not found" });
      return;
    }
    response.json(await apiDocument(document, runtime, await runtime.getLeaders()));
  });

  app.put("/api/documents/:id", async (request, response) => {
    const input = updateSchema.parse(request.body);
    const existing = index.byId(request.params.id);
    if (!existing) {
      response.status(404).json({ error: "Document not found" });
      return;
    }
    if (existing.data.managed === "generated") {
      response.status(403).json({ error: "Generated documents are read-only" });
      return;
    }
    if (input.data.id !== existing.data.id || input.data.type !== existing.data.type) {
      response.status(400).json({ error: "Document identity and type cannot be changed" });
      return;
    }
    const data = {
      ...existing.data,
      ...input.data,
      id: existing.data.id,
      type: existing.data.type,
      created_at: existing.data.created_at,
      updated_at: nowIso()
    } as BaseMetadata;
    const saved = await store.write(existing.path, data, input.body, {
      expectedEtag: input.etag
    });
    await index.rebuild(store);
    response.json(saved);
  });

  app.get("/api/search", (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q : "";
    const type = typeof request.query.type === "string" ? request.query.type : undefined;
    response.json(index.search(query, type));
  });

  app.get("/api/timeline", (_request, response) => {
    response.json(buildTimeline(index.all()));
  });

  app.get("/api/config", async (_request, response) => {
    const effectiveAnalysis = await analysisConfig.getEffective();
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
        identity: "user"
      },
      loop: {
        enabled: false,
        executionEndpoint: null
      },
      analysis: {
        current_provider: effectiveAnalysis.config.provider,
        config_source: effectiveAnalysis.source,
        provider_locked: effectiveAnalysis.provider_locked,
        config: effectiveAnalysis.config,
        providers,
        prompt_version: ANALYSIS_PROMPT_VERSION,
        schema_version: ANALYSIS_SCHEMA_VERSION,
        status: await analysis.runStore.status(),
        recent_runs: await analysis.runStore.recent(5)
      }
    });
  });

  app.put("/api/config/leaders", async (request, response) => {
    const leaders = leadersSchema.parse(request.body);
    const existing = await store.read("config/priority-people.md");
    await store.write(
      existing.path,
      { ...existing.data, leaders, updated_at: nowIso() },
      existing.body,
      { expectedEtag: existing.etag }
    );
    for (const document of index.all<PersonMetadata>().filter(isPerson)) {
      const updated = applyLeaderConfiguration(document.data, leaders);
      if (
        updated.is_leader !== document.data.is_leader ||
        updated.leader_boost !== document.data.leader_boost
      ) {
        await store.write(
          document.path,
          { ...updated, updated_at: nowIso() },
          document.body,
          { expectedEtag: document.etag }
        );
      }
    }
    await index.rebuild(store);
    response.json({ leaders });
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
    await index.rebuild(store);
    response.json(effective);
  });

  app.get("/api/analysis/status", async (_request, response) => {
    response.json({
      status: await analysis.runStore.status(),
      recent_runs: await analysis.runStore.recent(20)
    });
  });

  app.post("/api/analysis/reanalyze", async (request, response) => {
    const input = reanalysisSchema.parse(request.body);
    const result =
      "source_id" in input
        ? await analysis.reanalyzeSource(input.source_id)
        : await analysis.reanalyzeRange(input.from, input.to, input.limit);
    await index.rebuild(store);
    response.json(result);
  });

  app.post("/api/index/rebuild", async (_request, response) => {
    const count = await index.rebuild(store);
    response.json({ ok: true, count });
  });

  app.post("/api/sync/lark", async (_request, response, next) => {
    try {
      const status = await sync.sync();
      response.json(status);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/loop", async (_request, response) => {
    const overview = buildOverview(
      index.all(),
      await runtime.getLeaders(),
      sync.getStatus()
    );
    response.json({
      enabled: false,
      message: "Automatic execution is not enabled in V1.",
      readiness: overview.loopReadiness
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
      if (error instanceof DocumentConflictError) {
        response.status(409).json({ error: error.message });
        return;
      }
      if (
        error instanceof UnsafeWorkspacePathError ||
        error instanceof InvalidDocumentError ||
        error instanceof z.ZodError
      ) {
        response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      response.status(500).json({
        error: error instanceof Error ? error.message : "Unexpected server error"
      });
    }
  );

  return { app, runtime };
}

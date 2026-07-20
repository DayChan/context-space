import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { MarkdownStore } from "./markdown-store";
import type { BaseMetadata } from "./types";
import { nowIso } from "./types";

const REQUIRED_DIRECTORIES = [
  "config/sources",
  "sources/lark/mentions",
  "sources/lark/dms",
  "sources/lark/calendar",
  "sources/lark/tasks",
  "inbox/todo-candidates",
  "inbox/knowledge-candidates",
  "inbox/conflicts",
  "todos/items",
  "todos/views",
  "people",
  "knowledge/projects",
  "knowledge/decisions",
  "knowledge/playbooks",
  "knowledge/concepts",
  "knowledge/glossary",
  "knowledge/drafts",
  "summaries/daily",
  "summaries/weekly",
  "loop/runs",
  ".context/sync",
  ".context/index",
  ".context/logs",
  ".context/analysis/runs"
] as const;

function baseline(
  id: string,
  type: BaseMetadata["type"],
  title: string,
  managed: BaseMetadata["managed"],
  extra: Record<string, unknown> = {}
): BaseMetadata {
  const timestamp = nowIso();
  return {
    schema: `work-context/${type}@1`,
    id,
    type,
    title,
    managed,
    created_at: timestamp,
    updated_at: timestamp,
    source_refs: [],
    ...extra
  };
}

const BASELINE_FILES: Array<{ path: string; data: BaseMetadata; body: string }> = [
  {
    path: "config/workspace.md",
    data: baseline("config_workspace", "config", "Workspace", "manual", {
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      initial_backfill_days: 30,
      overlap_minutes: 10
    }),
    body: "# Workspace\n\nLocal-first configuration for Context Space."
  },
  {
    path: "config/analysis.md",
    data: baseline("config_analysis", "config", "LLM 内容分析", "manual", {
      provider: "codex-sdk",
      model: null,
      timeout_ms: 120000,
      max_source_chars: 20000,
      max_batch_records: 50,
      max_batch_source_chars: 60000,
      max_output_bytes: 2000000,
      prompt_version: "context-analysis@2",
      retain_runs: 50,
      max_reanalysis_records: 50
    }),
    body: "# LLM 内容分析\n\nProvider 可在 Settings 中显式切换；凭证不得写入本文件。"
  },
  {
    path: "config/sources/lark.md",
    data: baseline("config_source_lark", "config", "Lark source", "manual", {
      enabled: true,
      identity: "user",
      sources: ["mentions", "p2p", "calendar", "tasks", "people"]
    }),
    body: "# Lark\n\nRead-only synchronization through `lark-cli --as user`."
  },
  {
    path: "config/priority-people.md",
    data: baseline("config_priority_people", "config", "Priority people", "manual", { leaders: [] }),
    body: "# Priority people\n\nLeader designations are always explicit and user-owned."
  },
  {
    path: "config/policies.md",
    data: baseline("config_policies", "config", "Privacy policies", "manual", {
      group_context_minutes: 30,
      download_attachments: false
    }),
    body: "# Privacy policies\n\nOnly collect the minimum context needed for work recall."
  },
  {
    path: "summaries/now.md",
    data: baseline("summary_now", "summary", "Now", "generated", { status: "empty" }),
    body: "# Now\n\nSync Lark or add Markdown Todo items to build your current view."
  },
  {
    path: "loop/README.md",
    data: baseline("loop_readme", "loop-policy", "Loop", "manual", { enabled: false }),
    body: "# Loop\n\nAutomatic execution is not enabled in V1."
  },
  {
    path: "loop/policies.md",
    data: baseline("loop_policies", "loop-policy", "Loop policies", "manual", {
      execution_enabled: false,
      require_confirmation: true,
      allowed_capabilities: []
    }),
    body: "# Loop policies\n\nReserved for future reviewed and auditable automation."
  },
  {
    path: ".context/analysis/status.md",
    data: baseline(
      "analysis_status",
      "analysis-status",
      "LLM 分析状态",
      "generated",
      {
        last_run_id: null,
        last_status: null,
        last_provider: null,
        last_completed_at: null,
        last_error_code: null,
        last_error_message: null
      }
    ),
    body: ""
  },
  {
    path: ".context/sync/lark.md",
    data: baseline("sync_lark_checkpoint", "sync-status", "Lark checkpoint", "generated", {
      source_checkpoints: {},
      last_completed_at: null
    }),
    body: ""
  },
  {
    path: ".context/sync/lark-status.md",
    data: baseline("sync_lark_status", "sync-status", "Lark sync status", "generated", {
      running: false,
      started_at: null,
      completed_at: null,
      results: [],
      last_error: null
    }),
    body: ""
  }
];

export async function initializeWorkspace(root: string): Promise<MarkdownStore> {
  const absoluteRoot = path.resolve(root);
  await mkdir(absoluteRoot, { recursive: true });
  for (const directory of REQUIRED_DIRECTORIES) {
    await mkdir(path.join(absoluteRoot, directory), { recursive: true });
  }
  const store = new MarkdownStore(absoluteRoot);
  for (const file of BASELINE_FILES) {
    if (!(await store.exists(file.path))) {
      await store.write(file.path, file.data, file.body, { createOnly: true });
    }
  }
  const analysisConfig = await store.read("config/analysis.md");
  const storedMaxSourceCharacters =
    typeof analysisConfig.data.max_source_chars === "number"
      ? analysisConfig.data.max_source_chars
      : 20000;
  const migratedAnalysis = {
    ...analysisConfig.data,
    ...(analysisConfig.data.max_batch_records === undefined
      ? { max_batch_records: 50 }
      : {}),
    ...(analysisConfig.data.max_batch_source_chars === undefined
      ? {
          max_batch_source_chars: Math.max(
            60000,
            storedMaxSourceCharacters
          )
        }
      : {}),
    ...(analysisConfig.data.prompt_version === "context-analysis@1"
      ? { prompt_version: "context-analysis@2" }
      : {})
  };
  if (
    migratedAnalysis.max_batch_records !==
      analysisConfig.data.max_batch_records ||
    migratedAnalysis.max_batch_source_chars !==
      analysisConfig.data.max_batch_source_chars ||
    migratedAnalysis.prompt_version !== analysisConfig.data.prompt_version
  ) {
    await store.write(
      analysisConfig.path,
      { ...migratedAnalysis, updated_at: nowIso() },
      analysisConfig.body,
      { expectedEtag: analysisConfig.etag }
    );
  }
  return store;
}

export async function listMarkdownFiles(root: string): Promise<string[]> {
  const absoluteRoot = path.resolve(root);
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.relative(absoluteRoot, absolute).replaceAll(path.sep, "/"));
      }
    }
  }

  await visit(absoluteRoot);
  return files.sort();
}

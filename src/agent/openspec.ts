import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AgentRequestError } from "../core/agent-errors";
import type {
  OpenSpecChangeSummary,
  OpenSpecReadiness,
  OpenSpecWorkflow
} from "../core/types";

const execFileAsync = promisify(execFile);
const changeNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const schemaNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const agentSkillRoots = [".codex", ".agents"] as const;

export function isOpenSpecChangeName(value: string): boolean {
  return changeNamePattern.test(value);
}

export interface OpenSpecCommandRunner {
  run(cwd: string, args: string[]): Promise<string>;
}

function supportedCommand(args: string[]): boolean {
  if (args.length === 2 && args[0] === "list" && args[1] === "--json") return true;
  if (args.length === 4 && args[0] === "status" && args[1] === "--change" && isOpenSpecChangeName(args[2]) && args[3] === "--json") return true;
  if (args.length === 4 && args[0] === "schema" && args[1] === "which" && schemaNamePattern.test(args[2]) && args[3] === "--json") return true;
  return args.length === 6 && args[0] === "init" && args[1] === "." && args[2] === "--tools" && args[3] === "codex" && args[4] === "--force" && args[5] === "--profile=custom";
}

export class NodeOpenSpecCommandRunner implements OpenSpecCommandRunner {
  async run(cwd: string, args: string[]): Promise<string> {
    if (!supportedCommand(args)) throw new AgentRequestError("拒绝执行未授权的 OpenSpec 命令");
    try {
      const result = await execFileAsync("openspec", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000
      });
      return result.stdout.trim();
    } catch (error) {
      const detail = error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim().slice(0, 2_000)
        : "";
      throw new AgentRequestError(detail ? `OpenSpec 命令失败：${detail}` : "OpenSpec 命令执行失败");
    }
  }
}

const listSchema = z.object({
  changes: z.array(z.object({
    name: z.string(),
    completedTasks: z.number().int().nonnegative().default(0),
    totalTasks: z.number().int().nonnegative().default(0),
    status: z.string().default("unknown"),
    lastModified: z.string().default("")
  }).passthrough())
});

const statusSchema = z.object({
  changeName: z.string(),
  schemaName: z.string(),
  isComplete: z.boolean(),
  artifacts: z.array(z.object({
    id: z.string(),
    outputPath: z.string(),
    status: z.enum(["done", "ready", "blocked"]),
    missingDeps: z.array(z.string()).optional()
  }))
});

const schemaLocationSchema = z.object({
  name: z.string(),
  path: z.string()
});

const workflowSchema = z.object({
  artifacts: z.array(z.object({
    id: z.string(),
    generates: z.string(),
    description: z.string().default(""),
    requires: z.array(z.string()).default([])
  }))
});

function parseJson<T>(value: string, schema: z.ZodType<T>, label: string): T {
  try {
    return schema.parse(JSON.parse(value));
  } catch {
    throw new AgentRequestError(`无法解析 OpenSpec ${label} 输出`);
  }
}

export class OpenSpecInspector {
  constructor(private readonly runner: OpenSpecCommandRunner = new NodeOpenSpecCommandRunner()) {}

  readiness(workspacePath: string): OpenSpecReadiness {
    const initialized = (
      existsSync(path.join(workspacePath, "openspec", "config.yaml"))
      || existsSync(path.join(workspacePath, "openspec", "config.yml"))
    ) && existsSync(path.join(workspacePath, "openspec", "changes"));
    const requiredSkills = ["openspec-explore", "openspec-new-change"];
    const missingSkills = requiredSkills.filter((skill) => agentSkillRoots.every((root) => !existsSync(
      path.join(workspacePath, root, "skills", skill, "SKILL.md")
    )));
    const missing = [
      ...(!initialized ? ["openspec"] : []),
      ...missingSkills.map((skill) => `.codex/skills/${skill} 或 .agents/skills/${skill}`)
    ];
    return { initialized, skillsReady: missingSkills.length === 0, ready: missing.length === 0, missing };
  }

  async initialize(workspacePath: string): Promise<OpenSpecReadiness> {
    await this.runner.run(workspacePath, ["init", ".", "--tools", "codex", "--force", "--profile=custom"]);
    const readiness = this.readiness(workspacePath);
    if (!readiness.ready) throw new AgentRequestError(`OpenSpec 初始化不完整：${readiness.missing.join("、")}`);
    return readiness;
  }

  async listChanges(workspacePath: string): Promise<OpenSpecChangeSummary[]> {
    const parsed = parseJson(await this.runner.run(workspacePath, ["list", "--json"]), listSchema, "change 列表");
    return parsed.changes.map((change) => ({
      name: change.name,
      completedTasks: change.completedTasks,
      totalTasks: change.totalTasks,
      status: change.status,
      lastModified: change.lastModified
    }));
  }

  async workflow(workspacePath: string, changeName: string): Promise<OpenSpecWorkflow> {
    if (!isOpenSpecChangeName(changeName)) throw new AgentRequestError("OpenSpec change 名称必须是 kebab-case");
    const status = parseJson(
      await this.runner.run(workspacePath, ["status", "--change", changeName, "--json"]),
      statusSchema,
      "status"
    );
    const schemaLocation = parseJson(
      await this.runner.run(workspacePath, ["schema", "which", status.schemaName, "--json"]),
      schemaLocationSchema,
      "schema"
    );
    let definition: z.infer<typeof workflowSchema>;
    try {
      definition = workflowSchema.parse(parseYaml(await readFile(path.join(schemaLocation.path, "schema.yaml"), "utf8")));
    } catch {
      throw new AgentRequestError(`无法读取 OpenSpec schema：${status.schemaName}`);
    }
    const stateById = new Map(status.artifacts.map((artifact) => [artifact.id, artifact]));
    return {
      changeName: status.changeName,
      schemaName: status.schemaName,
      relativePath: path.posix.join("openspec", "changes", changeName),
      isComplete: status.isComplete,
      nodes: definition.artifacts.map((artifact) => {
        const state = stateById.get(artifact.id);
        if (!state) throw new AgentRequestError(`OpenSpec status 缺少 artifact：${artifact.id}`);
        return {
          id: artifact.id,
          description: artifact.description,
          outputPath: state.outputPath || artifact.generates,
          requires: artifact.requires,
          status: state.status,
          missingDeps: state.missingDeps ?? []
        };
      })
    };
  }
}

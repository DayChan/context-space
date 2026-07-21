import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentRequestError } from "../core/agent-errors";

const execFileAsync = promisify(execFile);

export type AgentEditor = "trae" | "trae_cn" | "vscode" | "pycharm" | "goland";

export interface WorkspaceOpener {
  open(editor: AgentEditor, workspacePath: string): Promise<{ application: string }>;
}

const APPLICATION_CANDIDATES: Record<AgentEditor, string[]> = {
  trae: ["Trae"],
  trae_cn: ["Trae CN"],
  vscode: ["Visual Studio Code"],
  pycharm: ["PyCharm"],
  goland: ["GoLand"]
};

export class MacWorkspaceOpener implements WorkspaceOpener {
  async open(editor: AgentEditor, workspacePath: string): Promise<{ application: string }> {
    if (process.platform !== "darwin") {
      throw new AgentRequestError("当前仅支持在 macOS 上从浏览器打开本地 IDE");
    }

    for (const application of APPLICATION_CANDIDATES[editor]) {
      try {
        await execFileAsync("open", ["-a", application, workspacePath], { timeout: 10_000 });
        return { application };
      } catch {
        // Try the next known application name. This is primarily needed for Trae CN.
      }
    }

    throw new AgentRequestError(`未找到或无法启动 ${APPLICATION_CANDIDATES[editor].join(" / ")}`);
  }
}

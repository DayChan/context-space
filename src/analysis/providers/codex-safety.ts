export function codexSdkSafetyConfig() {
  return {
    approval_policy: "never",
    web_search: "disabled",
    mcp_servers: {},
    project_doc_max_bytes: 0,
    features: {
      apps: false,
      goals: false,
      hooks: false,
      memories: false,
      multi_agent: false,
      remote_plugin: false,
      shell_snapshot: false,
      shell_tool: false
    }
  };
}

const CODEX_EXEC_SAFETY_OVERRIDES = [
  'approval_policy="never"',
  'web_search="disabled"',
  "mcp_servers={}",
  "project_doc_max_bytes=0",
  "features.apps=false",
  "features.goals=false",
  "features.hooks=false",
  "features.memories=false",
  "features.multi_agent=false",
  "features.remote_plugin=false",
  "features.shell_snapshot=false",
  "features.shell_tool=false"
] as const;

export function codexExecSafetyArguments(): string[] {
  return CODEX_EXEC_SAFETY_OVERRIDES.flatMap((value) => ["-c", value]);
}

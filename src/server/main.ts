import { existsSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app";

const port = Number(process.env.CONTEXT_SPACE_PORT ?? 4318);
const host = process.env.CONTEXT_SPACE_HOST ?? "127.0.0.1";
const workspaceRoot = path.resolve(process.env.CONTEXT_SPACE_ROOT ?? "./workspace");

const webRoot = path.resolve("./dist");
const { app } = await createApp({
  workspaceRoot,
  staticRoot: existsSync(webRoot) ? webRoot : undefined
});

app.listen(port, host, () => {
  console.log(`Context Space API listening on http://${host}:${port}`);
  console.log(`Canonical Markdown workspace: ${workspaceRoot}`);
});

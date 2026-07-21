import { existsSync } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import { createApp } from "./app";
import { createLogger } from "../logging";

const port = Number(process.env.CONTEXT_SPACE_PORT ?? 4318);
const host = process.env.CONTEXT_SPACE_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error(
    "Context Space V1 仅支持单用户本机运行，CONTEXT_SPACE_HOST 必须是 loopback 地址"
  );
}
const workspaceRoot = path.resolve(process.env.CONTEXT_SPACE_ROOT ?? "./workspace");

const webRoot = path.resolve("./dist");
const logger = createLogger({
  workspaceRoot,
  environment: process.env
});
const serverLogger = logger.child({ component: "server" });

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

try {
  serverLogger.info("server.starting", {
    host,
    port,
    log_level: logger.config.level,
    console_logging: logger.config.consoleEnabled,
    file_logging: logger.config.fileEnabled
  });
  const { app, runtime } = await createApp({
    workspaceRoot,
    staticRoot: existsSync(webRoot) ? webRoot : undefined,
    logger
  });
  runtime.analysisWorker.start();
  runtime.syncScheduler.start();
  runtime.sourceRetention.start();
  await runtime.markdownIndexSync.start();
  const server = app.listen(port, host, () => {
    serverLogger.info("server.listening", {
      host,
      port,
      workspace_root: workspaceRoot
    });
  });
  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    serverLogger.info("server.stopping", { reason, exit_code: exitCode });
    const timeout = setTimeout(() => {
      serverLogger.warn("server.shutdown.timeout", { timeout_ms: 10_000 });
      server.closeAllConnections();
    }, 10_000);
    timeout.unref();
    try {
      await closeServer(server);
      runtime.syncScheduler.stop();
      await runtime.analysisWorker.stop();
      await runtime.markdownIndexSync.stop();
      runtime.sourceRetention.stop();
      runtime.database.close();
      serverLogger.info("server.stopped", { reason });
    } catch (error) {
      exitCode = 1;
      serverLogger.error("server.stop.failed", { reason, error });
    } finally {
      clearTimeout(timeout);
      await logger.close();
      process.exitCode = exitCode;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.once("uncaughtException", (error) => {
    serverLogger.fatal("process.uncaught_exception", { error });
    void shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (reason) => {
    serverLogger.fatal("process.unhandled_rejection", {
      error: reason instanceof Error ? reason : new Error(String(reason))
    });
    void shutdown("unhandledRejection", 1);
  });
  server.once("error", (error) => {
    serverLogger.fatal("server.listener.failed", { error });
    void shutdown("serverError", 1);
  });
} catch (error) {
  serverLogger.fatal("server.start.failed", { error });
  await logger.close();
  process.exitCode = 1;
}

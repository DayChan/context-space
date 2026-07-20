import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConfiguredLogger,
  loadLoggingConfig,
  withLogContext,
  type LoggingConfig
} from "../src/logging";

function loggingConfig(
  root: string,
  override: Partial<LoggingConfig> = {}
): LoggingConfig {
  return {
    level: "trace",
    consoleEnabled: true,
    fileEnabled: false,
    directory: path.join(root, "logs"),
    maxFileBytes: 10 * 1024 * 1024,
    retentionDays: 14,
    service: "context-space",
    ...override
  };
}

describe("structured logging", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "context-space-logging-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("emits stable JSON, filters levels, and merges child and async context", async () => {
    const lines: string[] = [];
    const logger = createConfiguredLogger({
      config: loggingConfig(root, { level: "info" }),
      now: () => new Date("2026-07-20T08:00:00.000Z"),
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line)
    }).child({ component: "test-component" });

    logger.debug("hidden.event");
    await withLogContext(
      { request_id: "request-1", sync_id: "sync-1" },
      async () => {
        await Promise.resolve();
        logger.info("test.completed", { count: 2 });
      }
    );
    await logger.flush();

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry).toMatchObject({
      timestamp: "2026-07-20T08:00:00.000Z",
      level: "info",
      service: "context-space",
      event: "test.completed",
      component: "test-component",
      request_id: "request-1",
      sync_id: "sync-1",
      count: 2,
      pid: process.pid
    });
  });

  it("isolates concurrent async contexts", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const logger = createConfiguredLogger({
      config: loggingConfig(root),
      stdout: (line) => entries.push(JSON.parse(line) as Record<string, unknown>),
      stderr: (line) => entries.push(JSON.parse(line) as Record<string, unknown>)
    });

    await Promise.all([
      withLogContext({ request_id: "left" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        logger.info("request.done", { side: "left" });
      }),
      withLogContext({ request_id: "right" }, async () => {
        await Promise.resolve();
        logger.info("request.done", { side: "right" });
      })
    ]);

    expect(
      entries.map(({ request_id, side }) => [request_id, side]).sort()
    ).toEqual([
      ["left", "left"],
      ["right", "right"]
    ]);
  });

  it("redacts sensitive fields and credentials while retaining usage counters", () => {
    const lines: string[] = [];
    const logger = createConfiguredLogger({
      config: loggingConfig(root),
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line)
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const error = new Error(
      "Authorization: Bearer secret-token-value OPENAI_API_KEY=sk-secretvalue Cookie: session=cookie-secret"
    );

    logger.error("analysis.failed", {
      authorization: "Bearer secret-token-value",
      prompt: "private message body",
      nested: {
        cookie: "session=secret",
        access_token: "secret-access-token"
      },
      diagnostic: "request failed with sess-secretvalue",
      jwt: "eyJabcdefghijk.abcdefghijkl.abcdefghijkl",
      input_tokens: 123,
      output_tokens: 45,
      bigint: 99n,
      circular,
      error
    });

    const raw = lines[0];
    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(raw).not.toContain("private message body");
    expect(raw).not.toContain("secret-token-value");
    expect(raw).not.toContain("secretvalue");
    expect(raw).not.toContain("cookie-secret");
    expect(raw).not.toContain("eyJabcdefghijk");
    expect(entry.authorization).toBe("[已脱敏]");
    expect(entry.prompt).toBe("[已脱敏]");
    expect(entry.input_tokens).toBe(123);
    expect(entry.output_tokens).toBe(45);
    expect(entry.bigint).toBe("99");
    expect(raw).toContain("[循环引用]");
  });

  it("rotates JSONL files by size and removes only expired matching logs", async () => {
    const logDirectory = path.join(root, "logs");
    await writeFile(path.join(root, "placeholder"), "safe");
    await mkdir(logDirectory, { recursive: true });
    await writeFile(
      path.join(logDirectory, "context-space-2026-06-01.jsonl"),
      "{}\n"
    );
    await writeFile(path.join(logDirectory, "keep.txt"), "keep");

    const logger = createConfiguredLogger({
      config: loggingConfig(root, {
        consoleEnabled: false,
        fileEnabled: true,
        directory: logDirectory,
        maxFileBytes: 1_024,
        retentionDays: 14
      }),
      now: () => new Date("2026-07-20T08:00:00.000Z"),
      stderr: () => undefined
    });
    for (let index = 0; index < 8; index += 1) {
      logger.info("rotation.entry", {
        index,
        detail: "x".repeat(420)
      });
    }
    await logger.close();

    const names = await readdir(logDirectory);
    const current = names.filter((name) =>
      /^context-space-2026-07-20(?:\.\d+)?\.jsonl$/.test(name)
    );
    expect(current.length).toBeGreaterThan(1);
    expect(names).not.toContain("context-space-2026-06-01.jsonl");
    expect(names).toContain("keep.txt");
    const first = await readFile(path.join(logDirectory, current[0]), "utf8");
    expect(() => JSON.parse(first.trim().split("\n")[0])).not.toThrow();
    expect((await stat(logDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(logDirectory, current[0]))).mode & 0o777).toBe(
      0o600
    );
  });

  it("degrades without rejecting business work when the file target is unavailable", async () => {
    const invalidDirectory = path.join(root, "not-a-directory");
    await writeFile(invalidDirectory, "file");
    const emergency: string[] = [];
    const logger = createConfiguredLogger({
      config: loggingConfig(root, {
        consoleEnabled: false,
        fileEnabled: true,
        directory: invalidDirectory
      }),
      stderr: (line) => emergency.push(line)
    });

    logger.info("first.event");
    logger.info("second.event");
    await expect(logger.flush()).resolves.toBeUndefined();

    expect(emergency).toHaveLength(1);
    expect(JSON.parse(emergency[0])).toMatchObject({
      event: "logging.target.failed",
      level: "error"
    });
  });

  it("uses safe defaults for invalid configuration and stays quiet in tests", () => {
    const loaded = loadLoggingConfig(root, {
      NODE_ENV: "test",
      CONTEXT_SPACE_LOG_LEVEL: "verbose",
      CONTEXT_SPACE_LOG_CONSOLE: "sometimes",
      CONTEXT_SPACE_LOG_MAX_BYTES: "0",
      CONTEXT_SPACE_LOG_RETENTION_DAYS: "forever"
    });

    expect(loaded.config).toMatchObject({
      level: "info",
      consoleEnabled: false,
      fileEnabled: false,
      maxFileBytes: 10 * 1024 * 1024,
      retentionDays: 14
    });
    expect(loaded.warnings.map(({ setting }) => setting).sort()).toEqual([
      "CONTEXT_SPACE_LOG_CONSOLE",
      "CONTEXT_SPACE_LOG_LEVEL",
      "CONTEXT_SPACE_LOG_MAX_BYTES",
      "CONTEXT_SPACE_LOG_RETENTION_DAYS"
    ]);
  });
});

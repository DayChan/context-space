#!/usr/bin/env node

import { fileURLToPath } from "node:url";

process.env.CONTEXT_SPACE_STATIC_ROOT ??= fileURLToPath(
  new URL("../dist", import.meta.url)
);
process.env.CONTEXT_SPACE_CLI_QUIET = "true";

await import("../dist-server/main.js");

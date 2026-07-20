import { AsyncLocalStorage } from "node:async_hooks";
import type { LogFields } from "./types";

const logContextStorage = new AsyncLocalStorage<Readonly<LogFields>>();

export function currentLogContext(): Readonly<LogFields> {
  return logContextStorage.getStore() ?? {};
}

export function withLogContext<T>(
  fields: LogFields,
  callback: () => T
): T {
  return logContextStorage.run(
    Object.freeze({ ...currentLogContext(), ...fields }),
    callback
  );
}

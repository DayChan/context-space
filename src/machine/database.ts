import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { applyMachineMigrations } from "./migrations";

export const MACHINE_DATABASE_RELATIVE_PATH = ".context/context-space.db";

export class MachineDatabase {
  constructor(
    readonly connection: Database.Database,
    readonly filePath: string
  ) {}

  transaction<T>(work: () => T): T {
    return this.connection.transaction(work)();
  }

  close(): void {
    if (this.connection.open) this.connection.close();
  }
}

export async function openMachineDatabase(
  workspaceRoot: string
): Promise<MachineDatabase> {
  const filePath = path.join(
    path.resolve(workspaceRoot),
    MACHINE_DATABASE_RELATIVE_PATH
  );
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const connection = new Database(filePath);
  try {
    connection.pragma("journal_mode = WAL");
    connection.pragma("foreign_keys = ON");
    connection.pragma("busy_timeout = 5000");
    connection.pragma("synchronous = NORMAL");
    applyMachineMigrations(connection);
    await chmod(filePath, 0o600);
    return new MachineDatabase(connection, filePath);
  } catch (error) {
    connection.close();
    throw error;
  }
}

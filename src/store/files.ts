import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { chmod, copyFile, link, mkdir, open, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { z } from "zod";

import { STORE_MIGRATIONS } from "./migrations.ts";

/** Opens (creating if needed) the private store file, applies pending migrations, returns the handle. */
export async function openDatabase(path: string): Promise<Database> {
  if (!isAbsolute(path)) throw new Error("store path must be absolute");
  await requirePrivateDirectory(dirname(path));
  const database = new Database(path, { create: true, strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = new Set(
      database
        .query<{ version: number }, []>("SELECT version FROM schema_migrations")
        .all()
        .map((row) => row.version),
    );
    for (const migration of STORE_MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      const apply = database.transaction(() => {
        database.exec(migration.sql);
        database
          .query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
      });
      apply.immediate();
    }
    await chmod(path, 0o600);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function requirePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`private path is not a directory: ${path}`);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`private directory must not grant group or world access: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`private directory must be owned by the Agent Tag user: ${path}`);
  }
}

export function verifyDatabaseFile(path: string): void {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const row = z.object({ quick_check: z.literal("ok") }).parse(
      database.query("PRAGMA quick_check").get(),
    );
    if (row.quick_check !== "ok") throw new Error("backup integrity check failed");
  } finally {
    database.close();
  }
}

function temporarySibling(path: string): string {
  return join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
}

async function installPrivateFile(input: {
  readonly temporaryPath: string;
  readonly destinationPath: string;
}): Promise<void> {
  try {
    await chmod(input.temporaryPath, 0o600);
    verifyDatabaseFile(input.temporaryPath);
    const file = await open(input.temporaryPath, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await link(input.temporaryPath, input.destinationPath);
  } finally {
    await rm(input.temporaryPath, { force: true });
  }
}

export async function backupTo(database: Database, path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("backup path must be absolute");
  await requirePrivateDirectory(dirname(path));
  const temporaryPath = temporarySibling(path);
  try {
    database.query("VACUUM INTO ?").run(temporaryPath);
    await installPrivateFile({ temporaryPath, destinationPath: path });
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export interface RestoreBackupInput {
  readonly backupPath: string;
  readonly destinationPath: string;
}

export async function restoreBackup(input: RestoreBackupInput): Promise<void> {
  if (!isAbsolute(input.backupPath)) throw new Error("backup path must be absolute");
  if (!isAbsolute(input.destinationPath)) throw new Error("destination path must be absolute");
  verifyDatabaseFile(input.backupPath);
  await requirePrivateDirectory(dirname(input.destinationPath));
  const temporaryPath = temporarySibling(input.destinationPath);
  try {
    await copyFile(input.backupPath, temporaryPath, constants.COPYFILE_EXCL);
    await installPrivateFile({ temporaryPath, destinationPath: input.destinationPath });
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

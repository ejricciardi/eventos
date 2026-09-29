import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

const carpetaMigraciones = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Abre la base (":memory:" para tests) y aplica las migraciones pendientes. */
export function abrirDb(ruta: string) {
  const sqlite = new Database(ruta);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: carpetaMigraciones });
  return db;
}

export type Db = ReturnType<typeof abrirDb>;

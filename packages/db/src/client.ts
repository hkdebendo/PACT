// SQLite connection (better-sqlite3: prebuilt binaries for Windows/macOS/Linux, no compiler) with
// a minimal forward-only migrator over migrations/*.sql.
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';
import { databasePath } from './env';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function migrate(sqlite: Database.Database): string[] {
  sqlite.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(sqlite.prepare('SELECT name FROM _migrations').pluck().all() as string[]);
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(resolve(migrationsDir, f), 'utf8');
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
    })();
    ran.push(f);
  }
  return ran;
}

export function openDb(path = databasePath()): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  migrate(sqlite);
  return drizzle(sqlite, { schema }) as Db;
}

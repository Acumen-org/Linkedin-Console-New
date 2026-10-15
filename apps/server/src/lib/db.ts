import fs from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { config } from './config.ts';
import { logger } from './logger.ts';

/** Column names are snake_case in SQL and camelCase in JS. */
export const sql = postgres(config.databaseUrl, {
  max: 10,
  transform: postgres.camel,
  onnotice: () => {},
});

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'migrations');

/** Applies pending SQL migrations in order (safe to call from several processes). */
export async function migrate() {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(424242)`;
    // Inside the lock: the api and the worker start together, and two concurrent CREATE TABLE IF NOT EXISTS
    // collide on a fresh database ("type schema_migrations already exists").
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await tx`SELECT name FROM schema_migrations`).map((r) => r.name as string));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.unsafe(await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      logger.info({ migration: file }, 'applied migration');
    }
  });
}

/** A search term inside LIKE/ILIKE: its % and _ match themselves, not "anything". */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Small key/value store for generated settings (e.g. VAPID keys). */
export async function getSetting<T>(key: string): Promise<T | null> {
  const [row] = await sql`SELECT value FROM settings WHERE key = ${key}`;
  return (row?.value as T) ?? null;
}

export async function setSetting(key: string, value: unknown) {
  await sql`
    INSERT INTO settings (key, value) VALUES (${key}, ${sql.json(value as never)})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
}

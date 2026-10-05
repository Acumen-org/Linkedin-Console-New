import fs from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { config } from './config.ts';

// Column names are snake_case in SQL and camelCase in JS.
export const sql = postgres(config.databaseUrl, {
  max: 10,
  transform: postgres.camel,
  onnotice: () => {},
});

export async function migrate() {
  const dir = path.join(import.meta.dirname, '..', 'migrations');
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(424242)`;
    const done = new Set((await tx`SELECT name FROM schema_migrations`).map((r) => r.name as string));
    for (const file of (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await tx.unsafe(await fs.readFile(path.join(dir, file), 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      console.log(`[db] applied ${file}`);
    }
  });
}

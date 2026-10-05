// Recreates every account pod with the current images (used by scripts/update.sh).
// The profile volume (LinkedIn session) is kept.
import { sql } from '../db.ts';
import { pods } from '../bridgeClient.ts';

const accounts = await sql`SELECT id, label, timezone, language, proxy_server FROM accounts`;
for (const a of accounts) {
  try {
    await pods.recreate(a.id, { timezone: a.timezone, language: a.language, proxyServer: a.proxyServer });
    console.log(`✔ ${a.label}`);
  } catch (e) {
    console.error(`✘ ${a.label}: ${(e as Error).message}`);
  }
}
await sql.end();
process.exit(0);

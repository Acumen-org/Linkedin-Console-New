// After an update: waits until every account's browser reports again (up to WAIT_SECONDS, default 180) and
// prints which ones did. Run by scripts/update.sh after the pods are recreated.
import { sql } from '../lib/db.ts';

const since = new Date();
const waitMs = Number(process.env.WAIT_SECONDS ?? 180) * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = { label: string; status: string; lastSeenAt: Date | null };
let rows: Row[] = [];
while (true) {
  rows = await sql<Row[]>`SELECT label, status, last_seen_at FROM accounts ORDER BY label`;
  const waiting = rows.filter((a) => !a.lastSeenAt || a.lastSeenAt < since);
  if (!waiting.length || Date.now() - since.getTime() > waitMs) break;
  await sleep(10_000);
}

const STATUS: Record<string, string> = {
  CONNECTED: 'connected',
  AWAITING_LOGIN: 'running, waiting for someone to log in',
  NEEDS_ATTENTION: 'running, but LinkedIn wants a login or security check (Accounts → Reconnect)',
};
let problems = 0;
for (const a of rows) {
  const back = a.lastSeenAt && a.lastSeenAt >= since;
  if (!back) problems++;
  console.log(
    `  ${back ? '✅' : '⚠️ '} ${a.label}: ${back ? (STATUS[a.status] ?? a.status) : 'not reporting yet (automatic recovery keeps retrying)'}`,
  );
}
if (!rows.length) console.log('  (no LinkedIn accounts yet)');
else if (problems) console.log(`  ${problems} account(s) not back yet: check Accounts in the app in a few minutes.`);
await sql.end();
process.exit(0);

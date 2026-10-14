// Makes someone the owner, on the server (run through scripts/set-owner.sh, which asks for the password):
//   EMAIL=…  [NAME=…]  password on stdin (only needed when the person is new or has no password yet)
// The previous owner stays on as an admin. Recorded in the audit log as done by System.
import { hashPassword } from '../core/auth.ts';
import { transferOwnership } from '../core/owner.ts';
import { sql } from '../lib/db.ts';
import { newId } from '../lib/ids.ts';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const email = (process.env.EMAIL ?? '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Usage: EMAIL=person@example.com (a valid email address)');
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const password = Buffer.concat(chunks)
  .toString('utf8')
  .replace(/\r?\n$/, '');

let [user] = await sql`SELECT id, name, password_hash, disabled_at FROM users WHERE email = ${email}`;
if (password && password.length < 10) fail('The password needs at least 10 characters');
if (!user) {
  if (!password) fail(`${email} is not a teammate yet: a password is needed to create the owner account`);
  const name = (process.env.NAME ?? '').trim() || email.split('@')[0];
  const id = newId('usr');
  await sql`INSERT INTO users (id, email, name, password_hash, role) VALUES (${id}, ${email}, ${name}, ${await hashPassword(password)}, 'ADMIN')`;
  [user] = await sql`SELECT id, name, password_hash, disabled_at FROM users WHERE id = ${id}`;
  console.log(`Created ${name} <${email}>`);
} else if (password) {
  await sql`UPDATE users SET password_hash = ${await hashPassword(password)} WHERE id = ${user.id}`;
  await sql`DELETE FROM sessions WHERE user_id = ${user.id}`;
  console.log('Password set (signed out everywhere)');
} else if (!user.passwordHash) {
  fail(`${email} has no password: the owner needs one for sign-in when Microsoft is unavailable`);
}
if (user.disabledAt) await sql`UPDATE users SET disabled_at = NULL, disabled_reason = NULL, disabled_by = NULL WHERE id = ${user.id}`;

const r = await transferOwnership(user.id, null);
console.log(r.changed ? `✅ ${email} is now the owner (the previous owner is an admin)` : `✅ ${email} was already the owner`);
await sql.end();
process.exit(0); // the Redis connection (notifications) would keep it running

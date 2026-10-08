// Each account's pod gets its own Redis user that can only touch that account's keys (plus write-only access
// to the shared event streams). A compromised browser then can't send as another account or read its data.
// Plain RESP over a socket: the pod-agent stays free of client libraries.
import crypto from 'node:crypto';
import net from 'node:net';
import { config } from './config.ts';

const resp = (args: string[]) => `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;

/** Runs commands as the admin user; rejects on the first error reply. */
function run(commands: string[][]): Promise<void> {
  const url = new URL(config.redisUrl);
  const auth = url.password ? [['AUTH', decodeURIComponent(url.username || 'default'), decodeURIComponent(url.password)]] : [];
  const all = [...auth, ...commands];
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port || 6379), url.hostname);
    let buf = '';
    let replies = 0;
    socket.setTimeout(10_000, () => socket.destroy(new Error('redis timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(all.map(resp).join('')));
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      for (let i = buf.indexOf('\r\n'); i !== -1; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line.startsWith('-')) {
          socket.destroy();
          return reject(new Error(`redis: ${line.slice(1)}`));
        }
        if (++replies === all.length) {
          socket.end();
          return resolve();
        }
      }
    });
  });
}

/** Stable per-account password (derived, so recreating the pod needs no storage). */
const podPassword = (id: string) => crypto.createHmac('sha256', config.token).update(`redis-pod:${id}`).digest('hex');

/** Creates or resets the account's Redis user and returns the URL its sidecar connects with. */
export async function podRedisUrl(id: string): Promise<string> {
  const base = new URL(config.redisUrl);
  if (!base.password) return config.redisUrl; // Redis without auth (local development): nothing to restrict
  const user = `pod-${id}`;
  const password = podPassword(id);
  await run([
    [
      'ACL',
      'SETUSER',
      user,
      'reset',
      'on',
      `>${password}`,
      `~li:cmd:${id}`,
      `~li:tpl:${id}`,
      `~li:bridge-target:${id}`,
      `~li:ever:${id}`,
      '~li:reply:*',
      '~li:heal:*',
      '%W~li:events',
      '%W~li:results',
      '+@connection',
      '+@read',
      '+@write',
      '+@stream',
      '+@string',
      '+@list',
      '+@keyspace',
      '+@transaction',
      '-@dangerous',
      '+info',
    ],
  ]);
  return `redis://${encodeURIComponent(user)}:${password}@${base.host}`;
}

export async function removePodRedisUser(id: string) {
  if (new URL(config.redisUrl).password) await run([['ACL', 'DELUSER', `pod-${id}`]]).catch(() => {});
}

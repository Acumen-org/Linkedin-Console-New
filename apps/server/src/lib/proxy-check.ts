// Proxy reachability test. Runs from the api server (not inside an account's browser): it opens a tunnel to LinkedIn's
// TLS port through the proxy and sends nothing through it. It proves the proxy answers and will relay — not that
// LinkedIn accepts the account behind it.
import net from 'node:net';
import tls from 'node:tls';
import { z } from 'zod';

const TARGET_HOST = 'www.linkedin.com';
const TARGET_PORT = 443;
const TIMEOUT_MS = 8000;

/** Same rules as the per-account proxy field: http(s) or socks5, and no SOCKS username/password (Chrome can't send it). */
export const ProxyAddress = z
  .string()
  .trim()
  .regex(/^(https?|socks5?):\/\/\S+$/, 'A proxy address looks like http://host:port')
  .refine((v) => !/^socks5?:\/\/[^/]*@/.test(v), 'SOCKS proxies with a username/password are not supported; use an http(s) proxy')
  .max(300);

/** Hide any credentials: callers only ever see scheme://host:port. */
export function maskAddress(address: string): string {
  try {
    const u = new URL(address);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return address.replace(/\/\/[^@/]*@/, '//');
  }
}

export interface ProxyCheck {
  ok: boolean;
  detail: string;
  ms: number;
}

/** Try to open a CONNECT tunnel to www.linkedin.com:443 through `address`. */
export async function checkProxy(address: string): Promise<ProxyCheck> {
  const started = Date.now();
  const done = (ok: boolean, detail: string): ProxyCheck => ({ ok, detail, ms: Date.now() - started });

  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return done(false, 'That is not a valid proxy address');
  }
  const scheme = url.protocol.replace(':', '');
  const host = url.hostname;
  const port = Number(url.port) || (scheme === 'https' ? 443 : scheme === 'http' ? 80 : 1080);

  // SOCKS: Chrome speaks HTTP(S) to the local forwarder, so we can only confirm the port answers, not tunnel-test it.
  if (scheme === 'socks' || scheme === 'socks5') {
    return new Promise<ProxyCheck>((resolve) => {
      const sock = net.connect({ host, port });
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(done(false, 'No answer from the proxy (timed out)'));
      }, TIMEOUT_MS);
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.destroy();
        resolve(done(true, 'The proxy port is reachable (SOCKS is not tunnel-tested)'));
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        resolve(done(false, err.message));
      });
    });
  }

  // http / https proxy: send CONNECT and expect a 2xx.
  return new Promise<ProxyCheck>((resolve) => {
    let settled = false;
    const finish = (r: ProxyCheck) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const auth = url.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}\r\n`
      : '';
    const request = `CONNECT ${TARGET_HOST}:${TARGET_PORT} HTTP/1.1\r\nHost: ${TARGET_HOST}:${TARGET_PORT}\r\n${auth}\r\n`;

    const drive = (sock: net.Socket) => {
      let buf = '';
      const timer = setTimeout(() => {
        sock.destroy();
        finish(done(false, 'No answer from the proxy (timed out)'));
      }, TIMEOUT_MS);
      sock.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        if (!buf.includes('\r\n\r\n')) return;
        clearTimeout(timer);
        const status = Number(buf.match(/^HTTP\/\d\.\d (\d{3})/)?.[1] ?? 0);
        sock.destroy();
        finish(
          status >= 200 && status < 300
            ? done(true, 'Opened a tunnel to LinkedIn through the proxy')
            : done(false, `The proxy refused the tunnel (HTTP ${status || '?'})`),
        );
      });
      sock.on('error', (err) => {
        clearTimeout(timer);
        finish(done(false, err.message));
      });
      sock.write(request);
    };

    if (scheme === 'https') {
      const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => drive(sock));
      sock.once('error', (err) => finish(done(false, err.message)));
    } else {
      const sock = net.connect({ host, port }, () => drive(sock));
      sock.once('error', (err) => finish(done(false, err.message)));
    }
  });
}

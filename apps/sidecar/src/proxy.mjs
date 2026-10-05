// Local forward proxy on 127.0.0.1:3128 that adds credentials for an upstream proxy.
// Chrome's --proxy-server flag can't carry a username/password, so Chrome points here.
import http from 'node:http';
import net from 'node:net';

export function startProxyForwarder(upstreamUrl, port = 3128) {
  const up = new URL(upstreamUrl);
  const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(up.username)}:${decodeURIComponent(up.password)}`).toString('base64');
  const upPort = Number(up.port || 80);

  const server = http.createServer((req, res) => {
    // Plain-HTTP request: forward with absolute URI to the upstream proxy.
    const fwd = http.request({
      host: up.hostname, port: upPort, method: req.method, path: req.url,
      headers: { ...req.headers, 'proxy-authorization': auth },
    }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    fwd.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(fwd);
  });

  server.on('connect', (req, client, head) => {
    const upstream = net.connect(upPort, up.hostname, () => {
      upstream.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      upstream.off('data', onData);
      const status = buf.subarray(0, buf.indexOf('\r\n')).toString();
      if (!/^HTTP\/1\.[01] 200/.test(status)) {
        client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
        upstream.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buf.subarray(end + 4);
      if (rest.length) client.write(rest);
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    };
    upstream.on('data', onData);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });

  server.listen(port, '127.0.0.1', () => console.log(`[proxy] forwarding 127.0.0.1:${port} → ${up.hostname}:${upPort}`));
  return server;
}

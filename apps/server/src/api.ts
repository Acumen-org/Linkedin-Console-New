// API process: HTTP + WebSocket (Socket.IO).
import { buildApp } from './app.ts';
import { startRealtime } from './core/realtime.ts';
import { config } from './lib/config.ts';
import { migrate, sql } from './lib/db.ts';
import { logger } from './lib/logger.ts';

await migrate();
const app = await buildApp();
startRealtime(app.server);
await app.listen({ port: config.port, host: '0.0.0.0' });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}

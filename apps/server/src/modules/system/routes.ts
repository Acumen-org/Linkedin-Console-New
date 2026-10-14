import type { AppConfig } from '@linkedin-console/contracts';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../../core/auth.ts';
import { config } from '../../lib/config.ts';
import { sql } from '../../lib/db.ts';
import { redis } from '../../lib/redis.ts';
import { twentyWebUrl } from '../../lib/twenty.ts';
import { vapidKeys } from '../../lib/vapid.ts';
import { aiEnabled } from '../ai/drafts.ts';

export default async function systemRoutes(app: FastifyInstance) {
  /** Liveness + dependencies (used by Docker healthchecks and monitoring). */
  app.get('/api/health', async () => {
    await sql`SELECT 1`;
    await redis.ping();
    return { ok: true };
  });

  /** Feature flags and public keys for the web app. */
  app.get('/api/config', async (req): Promise<AppConfig> => {
    requireUser(req);
    const keys = await vapidKeys().catch(() => null);
    return {
      features: { aiDrafts: aiEnabled(), push: !!keys },
      vapidPublicKey: keys?.publicKey ?? null,
      twentyUrl: config.crmSync && config.twenty ? twentyWebUrl() : null,
    };
  });
}

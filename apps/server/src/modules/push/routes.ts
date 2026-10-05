import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.ts';
import { sql } from '../../lib/db.ts';
import { newId } from '../../lib/ids.ts';

const Subscription = z.object({
  endpoint: z.url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

/** Browser push subscriptions (the installable web app notifies about new messages). */
export default async function pushRoutes(app: FastifyInstance) {
  app.post('/api/push/subscriptions', async (req) => {
    const user = requireUser(req);
    const sub = Subscription.parse(req.body);
    await sql`
      INSERT INTO push_subscriptions (id, user_id, endpoint, keys)
      VALUES (${newId('psh')}, ${user.id}, ${sub.endpoint}, ${sql.json(sub.keys)})
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`;
    return { ok: true };
  });

  app.delete('/api/push/subscriptions', async (req) => {
    const user = requireUser(req);
    const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body);
    await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND user_id = ${user.id}`;
    return { ok: true };
  });
}

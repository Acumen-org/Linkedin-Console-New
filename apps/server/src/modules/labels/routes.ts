import { EVERYONE_ROOM } from '@linkunify/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { requireAdmin, requireUser } from '../../core/auth.ts';
import { sql } from '../../lib/db.ts';
import { conflict } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { publish } from '../../lib/redis.ts';

const Label = z.object({
  name: z.string().trim().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#64748b'),
});

/** Workspace-wide labels (tags) for conversations. Anyone can create; admins can delete. */
export default async function labelRoutes(app: FastifyInstance) {
  app.get('/api/labels', async (req) => {
    requireUser(req);
    return sql`
      SELECT l.id, l.name, l.color, (SELECT count(*)::int FROM conversation_labels cl WHERE cl.label_id = l.id) AS usage
      FROM labels l ORDER BY l.name`;
  });

  app.post('/api/labels', async (req) => {
    const user = requireUser(req);
    const body = Label.parse(req.body);
    const [exists] = await sql`SELECT 1 FROM labels WHERE lower(name) = lower(${body.name})`;
    if (exists) throw conflict('A label with this name already exists');
    const id = newId('lbl');
    await sql`INSERT INTO labels (id, name, color) VALUES (${id}, ${body.name}, ${body.color})`;
    await publish(EVERYONE_ROOM, 'labels.changed', {});
    await audit({ userId: user.id, action: 'label.created', meta: { name: body.name } });
    return { id, ...body };
  });

  app.patch<{ Params: { id: string } }>('/api/labels/:id', async (req) => {
    requireAdmin(req);
    const body = Label.partial().parse(req.body);
    const [l] = await sql`
      UPDATE labels SET name = coalesce(${body.name ?? null}, name), color = coalesce(${body.color ?? null}, color)
      WHERE id = ${req.params.id} RETURNING id, name, color`;
    return l;
  });

  app.delete<{ Params: { id: string } }>('/api/labels/:id', async (req) => {
    const user = requireAdmin(req);
    await sql`DELETE FROM labels WHERE id = ${req.params.id}`;
    await audit({ userId: user.id, action: 'label.deleted', meta: { labelId: req.params.id } });
    return { ok: true };
  });
}
